export const config = { api: { bodyParser: false } };

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

// In-memory token cache for warm Vercel instances
let cachedToken = null;
let tokenExpiresAt = 0;

async function getAdminToken() {
  const SHOP = process.env.SHOPIFY_SHOP;
  const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
  const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
  if (!SHOP || !CLIENT_ID || !CLIENT_SECRET) {
    throw new Error(
      "Missing SHOPIFY_SHOP / SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET env vars"
    );
  }
  if (cachedToken && Date.now() < tokenExpiresAt - 60_000) return cachedToken;
  const resp = await fetch(`https://${SHOP}.myshopify.com/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Token request failed: ${resp.status} ${text}`);
  }
  const { access_token, expires_in } = await resp.json();
  cachedToken = access_token;
  tokenExpiresAt = Date.now() + expires_in * 1000;
  return cachedToken;
}

async function shopifyGraphQL(query, variables = {}) {
  const SHOP = process.env.SHOPIFY_SHOP;
  const API_VERSION = process.env.SHOPIFY_API_VERSION || "2026-01";
  const resp = await fetch(`https://${SHOP}.myshopify.com/admin/api/${API_VERSION}/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": await getAdminToken(),
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await resp.json();
  if (!resp.ok || json.errors) {
    throw new Error(`GraphQL error: ${resp.status} ${JSON.stringify(json.errors || json)}`);
  }
  return json.data;
}

function numericIdFromGid(gid) {
  return String(gid || "").split("/").pop();
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/* ── PATCH 2026-08-04 ─────────────────────────────────────────────────────────
   Theme 2.0 lets a new subscriber choose their FIRST coffee. The storefront
   attaches that choice to the subscription line item as the hidden line-item
   property `_first_coffee_request` (value = a product handle).

   This helper reads it. It is deliberately defensive: any missing piece just
   returns null, which sends the request straight down the existing random path.
   ──────────────────────────────────────────────────────────────────────────── */
const FIRST_REQUEST_PROP = "_first_coffee_request";
const FIRST_ORDER_TAG = "Subscription First Order";

function getRequestedHandle(lineItem) {
  try {
    const attrs = lineItem?.customAttributes || [];
    const hit = attrs.find((a) => a && a.key === FIRST_REQUEST_PROP);
    const val = hit && typeof hit.value === "string" ? hit.value.trim() : "";
    return val || null;
  } catch (e) {
    console.error("getRequestedHandle failed, falling back to random:", e);
    return null;
  }
}
/* ── end patch helper ─────────────────────────────────────────────────────── */

function findSizeAndGrindFromLineItems(lineItems) {
  // First try to find the actual Single Origin Subscription item.
  // NOTE 2026-09-14: matched by HANDLE, not title. The product title was being
  // renamed to "Single Origin Coffee Subscription" for SEO, which does NOT
  // contain the old substring — the match would have failed silently and fallen
  // through to "first line item with a Size and a Grind" (wrong bag on any
  // multi-coffee order). The handle never changes; 27 theme files depend on it.
  const singleOriginLineItem = (lineItems || []).find((li) => {
    const productHandle = li?.variant?.product?.handle || "";
    const lineTitle = li?.title || "";
    const variantTitle = li?.variant?.title || "";
    return (
      productHandle === "roasters-choice-subscription" ||
      lineTitle.includes("Single Origin Subscription") ||
      variantTitle.includes("Single Origin - Roaster's Choice")
    );
  });

  if (singleOriginLineItem) {
    const opts = singleOriginLineItem?.variant?.selectedOptions || [];
    const size = opts.find((o) => o.name === "Size")?.value || null;
    const grind =
      opts.find((o) => o.name === "Grind Size")?.value ||
      opts.find((o) => o.name === "Whole Bean or Ground")?.value ||
      null;
    if (size && grind) {
      return { size, grind, lineItem: singleOriginLineItem };
    }
  }

  // Fallback: old behavior
  for (const li of lineItems || []) {
    const opts = li?.variant?.selectedOptions || [];
    const size = opts.find((o) => o.name === "Size")?.value || null;
    const grind =
      opts.find((o) => o.name === "Grind Size")?.value ||
      opts.find((o) => o.name === "Whole Bean or Ground")?.value ||
      null;
    if (size && grind) return { size, grind, lineItem: li };
  }
  return { size: null, grind: null, lineItem: null };
}

/* ── PATCH 2026-10-16: every Single Origin bag on the order ──────────────────
   Returns one entry per BAG (a line with quantity 2 is two bags), in line
   order, each with its size, grind and the line's `_first_coffee_request`.
   `bagIndex` is the bag's position within its line (0 = first), so a request
   is honoured once per line. If the order has no rotation line at all, falls
   back to the old single "first line with a Size and a Grind" behaviour so
   odd orders still get a pick.
   ──────────────────────────────────────────────────────────────────────────── */
function isSingleOriginLine(li) {
  const productHandle = li?.variant?.product?.handle || "";
  const lineTitle = li?.title || "";
  const variantTitle = li?.variant?.title || "";
  return (
    productHandle === "roasters-choice-subscription" ||
    lineTitle.includes("Single Origin Subscription") ||
    variantTitle.includes("Single Origin - Roaster's Choice")
  );
}

function sizeAndGrindOf(li) {
  const opts = li?.variant?.selectedOptions || [];
  const size = opts.find((o) => o.name === "Size")?.value || null;
  const grind =
    opts.find((o) => o.name === "Grind Size")?.value ||
    opts.find((o) => o.name === "Whole Bean or Ground")?.value ||
    null;
  return { size, grind };
}

function getSingleOriginBags(lineItems, skipped = []) {
  const bags = [];
  (lineItems || []).forEach((li, lineIndex) => {
    if (!isSingleOriginLine(li)) return;
    const { size, grind } = sizeAndGrindOf(li);
    if (!size || !grind) {
      // One bad line must not block the others: skip it, say so, and let the caller report it.
      console.warn(`RC: line ${lineIndex} (${li?.title || "?"}, ${li?.id || "?"}) has no Size/Grind; skipped`);
      skipped.push({ line: lineIndex, id: li?.id || null, title: li?.title || null, reason: "no Size/Grind on the variant" });
      return;
    }
    const qty = Math.max(1, Number(li?.quantity) || 1);
    const requestedHandle = getRequestedHandle(li);
    for (let bagIndex = 0; bagIndex < qty; bagIndex++) {
      bags.push({ lineItem: li, lineIndex, bagIndex, size, grind, requestedHandle });
    }
  });
  if (bags.length > 0) return bags;
  // Fallback: old behaviour, one bag from the first line that has a size and a grind.
  const { size, grind, lineItem } = findSizeAndGrindFromLineItems(lineItems);
  if (size && grind) {
    return [{ lineItem, lineIndex: 0, bagIndex: 0, size, grind, requestedHandle: getRequestedHandle(lineItem) }];
  }
  return [];
}
/* ── end 2026-10-16 helper ────────────────────────────────────────────────── */

/* ── PATCH 2026-10-05: THE PORTAL'S NEXT-COFFEE PICK ──────────────────────────
   On /pages/my-subscription a rotation subscriber can choose their next coffee.
   The portal saves it on the customer's Shopify record as
   roasters_choice.next_coffee = {"handle","title","requestedAt"}. It is a request
   for ONE delivery: honoured here if the coffee is still eligible, then cleared.
   Whatever ships is written back as roasters_choice.last_coffee = {"handle",
   "title","day","missed"} so the portal can show the last bag, and say when a
   pick sold out before it shipped ("missed" = the title they asked for).
   ──────────────────────────────────────────────────────────────────────────── */
async function getCustomerPickState(customerId) {
  const q = `
    query($id: ID!) {
      customer(id: $id) {
        id
        email
        lastMap: metafield(namespace: "roasters_choice", key: "last_pick_map") { value }
        nextCoffee: metafield(namespace: "roasters_choice", key: "next_coffee") { value }
        ratings: metafield(namespace: "roasters_choice", key: "ratings") { value }
      }
    }
  `;
  const data = await shopifyGraphQL(q, { id: customerId });
  const parse = (v, fallback) => { if (!v) return fallback; try { return JSON.parse(v); } catch { return fallback; } };
  const next = parse(data?.customer?.nextCoffee?.value, null);
  /* PATCH 2026-10-09: the portal's coffee log lets a subscriber mark a bag "not for me"
     (roasters_choice.ratings = {"<product id digits>": "love"|"fine"|"no"}). A "no" lot is never
     sent to them again by the rotation; an explicit portal pick still wins. */
  const ratings = parse(data?.customer?.ratings?.value, {});
  const avoid = new Set(Object.entries(ratings || {}).filter(([, v]) => v === "no").map(([k]) => String(k).replace(/\D/g, "")));
  return {
    avoid,
    lastMap: parse(data?.customer?.lastMap?.value, {}),
    portalHandle: next && typeof next.handle === "string" ? next.handle.trim() : null,
    portalTitle: next && typeof next.title === "string" ? next.title : null,
    email: data?.customer?.email || null,
  };
}

async function getCustomerLastPickMap(customerId) {
  return (await getCustomerPickState(customerId)).lastMap;
}

/** After the pick: clear the request, and record what shipped (with the miss, if any). */
async function recordShippedCoffee(customerId, pick, missedTitle) {
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const m = `
    mutation($set: [MetafieldsSetInput!]!, $del: [MetafieldIdentifierInput!]!) {
      metafieldsSet(metafields: $set) { userErrors { field message } }
      metafieldsDelete(metafields: $del) { userErrors { field message } }
    }
  `;
  const data = await shopifyGraphQL(m, {
    set: [{ ownerId: customerId, namespace: "roasters_choice", key: "last_coffee", type: "json",
      value: JSON.stringify({ handle: pick.product_handle, title: pick.product_title, day, missed: missedTitle || null }) }],
    del: [{ ownerId: customerId, namespace: "roasters_choice", key: "next_coffee" }],
  });
  const errs = [...(data?.metafieldsSet?.userErrors || []), ...(data?.metafieldsDelete?.userErrors || [])];
  if (errs.length) throw new Error(`recordShippedCoffee errors: ${JSON.stringify(errs)}`);
}

/** One Klaviyo event on the customer's profile, optionally updating profile properties with it. */
async function klaviyoEvent({ email, metric, properties, setProps, unsetProps }) {
  const key = process.env.KLAVIYO_PRIVATE_KEY;
  if (!key || !email) { console.warn(`RC: ${metric} not sent to Klaviyo (no key or email)`); return false; }
  const profile = { type: "profile", attributes: { email, ...(setProps ? { properties: setProps } : {}) } };
  if (unsetProps?.length) profile.meta = { patch_properties: { unset: unsetProps } };
  const resp = await fetch("https://a.klaviyo.com/api/events", {
    method: "POST",
    headers: { authorization: `Klaviyo-API-Key ${key}`, revision: "2024-10-15", "content-type": "application/vnd.api+json", accept: "application/vnd.api+json" },
    body: JSON.stringify({ data: { type: "event", attributes: { properties, metric: { data: { type: "metric", attributes: { name: metric } } }, profile: { data: profile } } } }),
  });
  if (!resp.ok) { console.error("RC: Klaviyo event failed", metric, resp.status, await resp.text().catch(() => "")); return false; }
  return true;
}

/** Tell Klaviyo a pick sold out before it shipped, so the "we switched your coffee" email goes out.
    The same call clears the pick from the profile and records what shipped (see syncPickToKlaviyo). */
async function notifyPickSwitched({ email, orderName, requestedTitle, shippedTitle, size, grind }) {
  return klaviyoEvent({ email, metric: "Portal Pick Switched",
    properties: { requested: requestedTitle, shipped: shippedTitle, order: orderName, size, grind },
    setProps: { last_coffee: shippedTitle }, unsetProps: ["next_coffee", "next_coffee_handle"] });
}

/** 2026-10-07: a honoured pick clears `next_coffee` on the Klaviyo profile (the portal set it when the
    customer chose), so the upcoming-order email stops naming a coffee that has already shipped. */
async function syncPickToKlaviyo({ email, orderName, shippedTitle, size, grind }) {
  return klaviyoEvent({ email, metric: "Portal Pick Shipped",
    properties: { shipped: shippedTitle, order: orderName, size, grind },
    setProps: { last_coffee: shippedTitle }, unsetProps: ["next_coffee", "next_coffee_handle"] });
}
/* ── end 2026-10-05 patch helpers ─────────────────────────────────────────── */

async function setCustomerLastPickMap(customerId, mapObj) {
  const m = `
    mutation($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        userErrors { field message }
      }
    }
  `;
  const data = await shopifyGraphQL(m, {
    metafields: [
      {
        ownerId: customerId,
        namespace: "roasters_choice",
        key: "last_pick_map",
        type: "single_line_text_field",
        value: JSON.stringify(mapObj),
      },
    ],
  });
  const errs = data?.metafieldsSet?.userErrors || [];
  if (errs.length) throw new Error(`Customer metafieldsSet errors: ${JSON.stringify(errs)}`);
}

async function setOrderPick(orderId, pickText) {
  const m = `
    mutation($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        userErrors { field message }
      }
    }
  `;
  const data = await shopifyGraphQL(m, {
    metafields: [
      {
        ownerId: orderId,
        namespace: "custom",
        key: "roasters_choice_pick",
        type: "single_line_text_field",
        value: pickText,
      },
    ],
  });
  const errs = data?.metafieldsSet?.userErrors || [];
  if (errs.length) throw new Error(`Order metafieldsSet errors: ${JSON.stringify(errs)}`);
}

async function getOrderPickText(orderId) {
  const q = `
    query($id: ID!) {
      order(id: $id) {
        metafield(namespace: "custom", key: "roasters_choice_pick") {
          value
        }
      }
    }
  `;
  const data = await shopifyGraphQL(q, { id: orderId });
  return data?.order?.metafield?.value || null;
}

async function addOrderTags(orderId, tags) {
  const m = `
    mutation($id: ID!, $tags: [String!]!) {
      tagsAdd(id: $id, tags: $tags) {
        userErrors { field message }
      }
    }
  `;
  const data = await shopifyGraphQL(m, { id: orderId, tags });
  const errs = data?.tagsAdd?.userErrors || [];
  if (errs.length) throw new Error(`tagsAdd errors: ${JSON.stringify(errs)}`);
}

async function appendOrderNote(orderId, noteText) {
  // Get existing note
  const getQuery = `
    query($id: ID!) {
      order(id: $id) {
        id
        note
      }
    }
  `;
  const existing = await shopifyGraphQL(getQuery, { id: orderId });
  const currentNote = existing?.order?.note || "";
  const updatedNote = noteText;

  const mutation = `
    mutation($input: OrderInput!) {
      orderUpdate(input: $input) {
        order { id note }
        userErrors { field message }
      }
    }
  `;
  const result = await shopifyGraphQL(mutation, {
    input: {
      id: orderId,
      note: updatedNote,
    },
  });
  const errs = result?.orderUpdate?.userErrors || [];
  if (errs.length) throw new Error(`orderUpdate errors: ${JSON.stringify(errs)}`);
}

async function getOrder(orderId) {
  /* PATCH 2026-08-04: added `tags` (to detect first vs recurring order) and
     lineItem `customAttributes` (to read _first_coffee_request). Everything
     else in this query is unchanged. */
  const q = `
    query($id: ID!) {
      order(id: $id) {
        id
        name
        tags
        customer { id email }
        lineItems(first: 50) {
          nodes {
            id
            title
            quantity
            customAttributes { key value }
            variant {
              id
              title
              selectedOptions { name value }
              product { id title handle }
            }
          }
        }
      }
    }
  `;
  const data = await shopifyGraphQL(q, { id: orderId });
  if (!data?.order) throw new Error("Order not found");
  return data.order;
}

async function getEligibleFromCollection(collectionHandle) {
  const q = `
    query($handle: String!, $cursor: String) {
      collectionByHandle(handle: $handle) {
        id
        products(first: 100, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            title
            handle
            status
            tags
          }
        }
      }
    }
  `;
  let cursor = null;
  const candidates = [];
  while (true) {
    const data = await shopifyGraphQL(q, { handle: collectionHandle, cursor });
    const col = data?.collectionByHandle;
    if (!col) throw new Error(`Collection not found: ${collectionHandle}`);
    const page = col.products;
    for (const p of page.nodes) {
      if (p.status !== "ACTIVE") continue;
      if (p.tags.includes("exclude_roasters_choice")) continue;
      candidates.push({
        product_id: p.id,
        product_title: p.title,
        product_handle: p.handle
      });
    }
    if (!page.pageInfo.hasNextPage) break;
    cursor = page.pageInfo.endCursor;
  }
  return candidates;
}

function makeSafeTag(str) {
  return (
    "RC_" +
    String(str || "")
      .toLowerCase()
      .replace(/[^a-z0-9-_]+/g, "-")
      .slice(0, 50)
  );
}

export default async function handler(req, res) {
  const expected = process.env.RC_SHARED_SECRET;
  try {
    const incomingToken = req.headers["x-rc-token"];
    if (!incomingToken || incomingToken !== expected) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method Not Allowed" });
    }

    const raw = await readRawBody(req);
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      return res.status(400).json({ error: "Invalid JSON" });
    }

    const orderId = payload?.order_id;
    if (!orderId) return res.status(400).json({ error: "Missing order_id" });

    // NOTE MODE: called by the delayed Flow to re-write the note after Smartrr overwrites it
    const mode = req.query?.mode;
    if (mode === "note") {
      const pickText = await getOrderPickText(orderId);
      // If Flow #1 hasn't saved the pick yet, don't fail—just exit cleanly
      if (!pickText) {
        return res.status(200).json({ success: true, mode: "note", message: "No pick saved yet" });
      }
      // Re-write the order note (ShipStation prints this)
      await appendOrderNote(orderId, pickText);
      // Mark so the delayed Flow doesn't run repeatedly
      await addOrderTags(orderId, ["RC_NOTE_SET"]);
      return res.status(200).json({ success: true, mode: "note" });
    }

    const order = await getOrder(orderId);
    const customerId = order?.customer?.id;
    if (!customerId) {
      return res
        .status(409)
        .json({ error: "Order has no customer; cannot enforce repeat protection" });
    }

    const lineItems = order.lineItems.nodes;

    /* ── PATCH 2026-10-16: ONE PICK PER BAG, NOT ONE PER ORDER ───────────────
       An order can carry several Single Origin subscription lines (two coffee
       pages subscribed in one checkout, a bag converted in the cart, a line
       with quantity 2). The old code took the FIRST rotation line and ignored
       the rest, so #106241 (two lines, two requests) got one coffee in the
       note. Now every bag gets its own pick: a line's own request is honoured
       on that line's first bag, the portal pick goes to the first bag without
       a request, and random bags avoid everything already picked on this
       order, the last bag they received, and their "not for me" list. The
       note lists every bag.
       ──────────────────────────────────────────────────────────────────────── */
    const skippedLines = [];
    const bags = getSingleOriginBags(lineItems, skippedLines);
    if (bags.length === 0) {
      return res.status(409).json({
        error: "Could not determine Size and Grind Size from order line items",
        order_name: order.name,
        skipped_lines: skippedLines,
      });
    }
    // Kept for the reply/debug shape older callers read; the first bag's size & grind.
    const { size, grind } = bags[0];

    const key = "global";
    /* PATCH 2026-10-05: one read for the no-repeat memory AND the portal pick. */
    const pickState = await getCustomerPickState(customerId);
    const lastMap = pickState.lastMap;
    const lastProductId = lastMap[key] || null;
    // 2026-10-16: a multi-bag order remembers every coffee it shipped, so none of them repeats next time.
    const lastProductIds = new Set(
      [lastProductId, ...(Array.isArray(lastMap.global_all) ? lastMap.global_all : [])].filter(Boolean)
    );

    const collectionHandle = "single-origin-coffee";
    const allCandidates = await getEligibleFromCollection(collectionHandle);
    if (allCandidates.length === 0) {
      return res.status(409).json({ error: "No eligible coffees found", size, grind });
    }

    const isFirstOrder = (order.tags || []).includes(FIRST_ORDER_TAG);

    /* ── PATCH 2026-10-05: the portal's pick, on ANY order (first or recurring).
       Resolved against the full list before the no-repeat filter: an explicit
       request wins even if it repeats the last bag. If the coffee has been pulled
       (draft, archived, excluded), it's a miss: random pick, remembered as missed
       so the portal can say so and Klaviyo can email them. ─────────────────── */
    let portalPick = null;
    let portalMissed = null;
    try {
      if (pickState.portalHandle) {
        portalPick = allCandidates.find((c) => c.product_handle === pickState.portalHandle) || null;
        if (!portalPick) {
          portalMissed = pickState.portalTitle || pickState.portalHandle;
          console.warn(`RC: portal pick "${pickState.portalHandle}" not eligible on ${order.name}; using random pick`);
        }
      }
    } catch (e) {
      console.error("RC: portal pick skipped:", e);
      portalPick = null;
    }
    /* ── end patch ──────────────────────────────────────────────────────────── */

    const avoidIds = pickState.avoid || new Set();
    const force = req.query?.force; // TEMP: allow forcing a specific coffee for testing (first bag only)

    /* Decide each bag in order. `taken` is what this order has already been given. */
    const taken = new Set();
    const picks = [];
    let portalUsed = false;
    let anyRequestHonoured = false;
    for (const bag of bags) {
      let pick = null;
      let how = "random";

      // ?force= applies to the first bag only.
      if (!pick && force && picks.length === 0) {
        pick = allCandidates.find((c) => c.product_handle === force) || null;
        if (pick) how = "forced";
      }

      /* ── PATCH 2026-08-04: FIRST-SHIPMENT COFFEE REQUEST ───────────────────
         The storefront attaches `_first_coffee_request` to the line. Honoured
         only on a first order (Smartrr copies properties onto renewals) and
         only on the line's first bag — extra bags of the same line are random.
         An explicit request is honoured even if another line asked for the
         same coffee: the customer asked for two of it on purpose. ─────────── */
      if (!pick && isFirstOrder && bag.requestedHandle && bag.bagIndex === 0) {
        pick = allCandidates.find((c) => c.product_handle === bag.requestedHandle) || null;
        if (pick) {
          how = "requested";
          anyRequestHonoured = true;
        } else {
          console.warn(`RC: requested coffee "${bag.requestedHandle}" not eligible on ${order.name}; using random pick`);
        }
      }

      /* The portal pick was made for one delivery: the first bag that has no request of its own. */
      if (!pick && portalPick && !portalUsed) {
        pick = portalPick;
        portalUsed = true;
        how = "portal";
      }

      if (!pick) {
        // Random: different from everything already on this order, then from the
        // last bag(s) they got, then from their "not for me" list — each rule
        // only applied while it leaves something on the shelf.
        let pool = allCandidates.filter((c) => !taken.has(c.product_id));
        if (pool.length === 0) pool = allCandidates.slice();
        if (lastProductIds.size && pool.length > 1) {
          const f = pool.filter((c) => !lastProductIds.has(c.product_id));
          if (f.length > 0) pool = f;
        }
        if (avoidIds.size && pool.length > 1) {
          const f = pool.filter((c) => !avoidIds.has(String(c.product_id).replace(/\D/g, "")));
          if (f.length > 0) pool = f;
        }
        pick = pickRandom(pool);
      }

      taken.add(pick.product_id);
      picks.push({ ...pick, size: bag.size, grind: bag.grind, how, requested_handle: bag.requestedHandle });
    }

    const pickText = picks.map((p) => `${p.product_title} — ${p.size} / ${p.grind}`).join("; ");

    const debug = req.query?.debug === "1";
    if (debug) {
      return res.status(200).json({
        success: true,
        debug: true,
        order: order.name,
        size,
        grind,
        bags: bags.length,
        skipped_lines: skippedLines,
        lastProductId,
        last_product_ids: [...lastProductIds],
        order_tags: order.tags,
        requested_handle: bags[0].requestedHandle,
        requested_handles: bags.map((b) => b.requestedHandle),
        portal_handle: pickState.portalHandle,
        portal_resolved: portalPick ? portalPick.product_title : null,
        portal_missed: portalMissed,
        avoid: [...avoidIds],
        would_pick: picks.map((p) => ({ product_title: p.product_title, product_handle: p.product_handle, size: p.size, grind: p.grind, how: p.how })),
        would_note: pickText,
        candidates_count: allCandidates.length,
        candidates: allCandidates.map((c) => ({
          product_title: c.product_title,
          product_handle: c.product_handle,
          product_id: c.product_id,
        })),
      });
    }

    await setOrderPick(orderId, pickText);

    /* Tags: one RC_PID per distinct coffee; RC_MULTI_BAG marks orders with more than one bag. */
    const tagsToAdd = ["RC_PICKED"];
    for (const id of taken) tagsToAdd.push(`RC_PID_${numericIdFromGid(id)}`);
    if (bags.length > 1) tagsToAdd.push("RC_MULTI_BAG");
    /* PATCH: RC_REQUESTED tag makes honored requests visible/filterable in admin */
    if (anyRequestHonoured) tagsToAdd.push("RC_REQUESTED");
    /* PATCH 2026-10-05: honoured portal picks and misses are visible in admin */
    if (portalUsed) tagsToAdd.push("RC_PORTAL_PICK");
    if (portalMissed) tagsToAdd.push("RC_PICK_MISSED");
    await addOrderTags(orderId, tagsToAdd);

    await appendOrderNote(orderId, pickText);

    // `global` stays a single id for anything else that reads it; `global_all` carries every bag.
    lastMap[key] = picks[picks.length - 1].product_id;
    lastMap.global_all = [...taken];
    await setCustomerLastPickMap(customerId, lastMap);

    /* PATCH 2026-10-05: tell the portal what shipped; clear the request now it's used.
       On a multi-bag order the portal's "last bag" names every coffee. */
    const shippedTitle = picks.map((p) => p.product_title).join(" + ");
    const firstPick = picks[0];
    let switchedEmail = false;
    try {
      await recordShippedCoffee(customerId, { product_handle: firstPick.product_handle, product_title: shippedTitle }, portalMissed);
      const email = order?.customer?.email || pickState.email;
      if (portalMissed) switchedEmail = await notifyPickSwitched({ email, orderName: order.name, requestedTitle: portalMissed, shippedTitle, size, grind });
      else if (portalUsed) await syncPickToKlaviyo({ email, orderName: order.name, shippedTitle, size, grind });
    } catch (e) {
      // The bags are picked and noted either way; this is bookkeeping for the portal.
      console.error("RC: recording the shipped coffee for the portal failed:", e);
    }

    return res.status(200).json({
      success: true,
      order: order.name,
      bags: bags.length,
      skipped_lines: skippedLines,
      /* PATCH: report whether the choice was honored (first bag, for older readers) */
      honored_request: firstPick.how === "requested",
      requested_handle: bags[0].requestedHandle,
      /* PATCH 2026-10-05 */
      portal_pick_honored: portalUsed,
      portal_pick_missed: portalMissed,
      switched_email_sent: switchedEmail,
      pick: {
        product_title: firstPick.product_title,
        product_handle: firstPick.product_handle,
        size: firstPick.size,
        grind: firstPick.grind,
      },
      /* 2026-10-16: every bag */
      picks: picks.map((p) => ({ product_title: p.product_title, product_handle: p.product_handle, size: p.size, grind: p.grind, how: p.how })),
      note: pickText,
    });
  } catch (err) {
    console.error("Roasters Choice handler error:", err);
    return res.status(500).json({ error: String(err?.message || err) });
  }
}
