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
      }
    }
  `;
  const data = await shopifyGraphQL(q, { id: customerId });
  const parse = (v, fallback) => { if (!v) return fallback; try { return JSON.parse(v); } catch { return fallback; } };
  const next = parse(data?.customer?.nextCoffee?.value, null);
  return {
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
    /* PATCH: also capture the matched Single Origin line item so we can read
       its _first_coffee_request property below. */
    const { size, grind, lineItem: soLineItem } = findSizeAndGrindFromLineItems(lineItems);
    if (!size || !grind) {
      return res.status(409).json({
        error: "Could not determine Size and Grind Size from order line items",
        order_name: order.name,
      });
    }

    const key = "global";
    /* PATCH 2026-10-05: one read for the no-repeat memory AND the portal pick. */
    const pickState = await getCustomerPickState(customerId);
    const lastMap = pickState.lastMap;
    const lastProductId = lastMap[key] || null;

    const collectionHandle = "single-origin-coffee";
    let candidates = await getEligibleFromCollection(collectionHandle);
    if (candidates.length === 0) {
      return res.status(409).json({ error: "No eligible coffees found", size, grind });
    }

    /* ── PATCH 2026-08-04: FIRST-SHIPMENT COFFEE REQUEST ─────────────────────
       If this is the customer's FIRST subscription order AND the storefront
       attached a coffee choice, honor it.

       Resolved against the full candidate list BEFORE the no-repeat filter, so
       an explicit request always wins over rotation logic. Gated on the
       "Subscription First Order" tag because Smartrr copies line-item
       properties onto renewal orders — without this gate the customer would be
       pinned to their signup coffee forever.

       Any failure here leaves requestedPick = null and the original random
       path runs untouched.
       ──────────────────────────────────────────────────────────────────────── */
    let requestedPick = null;
    let requestedHandle = null;
    try {
      const isFirstOrder = (order.tags || []).includes(FIRST_ORDER_TAG);
      requestedHandle = getRequestedHandle(soLineItem);
      if (isFirstOrder && requestedHandle) {
        requestedPick =
          candidates.find((c) => c.product_handle === requestedHandle) || null;
        if (!requestedPick) {
          // Requested coffee is gone, archived, or excluded — fall through to random.
          console.warn(
            `RC: requested coffee "${requestedHandle}" not eligible on ${order.name}; using random pick`
          );
        }
      }
    } catch (e) {
      console.error("RC: first-coffee-request override skipped:", e);
      requestedPick = null;
    }
    /* ── end patch ──────────────────────────────────────────────────────────── */

    /* ── PATCH 2026-10-05: the portal's pick, on ANY order (first or recurring).
       Resolved against the full list before the no-repeat filter: an explicit
       request wins even if it repeats the last bag. If the coffee has been pulled
       (draft, archived, excluded), it's a miss: random pick, remembered as missed
       so the portal can say so and Klaviyo can email them. ─────────────────── */
    let portalPick = null;
    let portalMissed = null;
    try {
      if (pickState.portalHandle) {
        portalPick = candidates.find((c) => c.product_handle === pickState.portalHandle) || null;
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

    // No-repeat if possible
    if (lastProductId && candidates.length > 1) {
      const filtered = candidates.filter((c) => c.product_id !== lastProductId);
      if (filtered.length > 0) candidates = filtered;
    }

    const debug = req.query?.debug === "1";
    if (debug) {
      return res.status(200).json({
        success: true,
        debug: true,
        order: order.name,
        size,
        grind,
        lastProductId,
        /* PATCH: surface the request so you can confirm it arrived */
        order_tags: order.tags,
        requested_handle: requestedHandle,
        requested_resolved: requestedPick ? requestedPick.product_title : null,
        /* PATCH 2026-10-05 */
        portal_handle: pickState.portalHandle,
        portal_resolved: portalPick ? portalPick.product_title : null,
        portal_missed: portalMissed,
        candidates_count: candidates.length,
        candidates: candidates.map(c => ({
          product_title: c.product_title,
          product_handle: c.product_handle,
          product_id: c.product_id
        }))
      });
    }

    // TEMP: allow forcing a specific coffee for testing
    const force = req.query?.force;
    let pick = null;
    if (force) {
      pick = candidates.find(c => c.product_handle === force) || null;
    }
    /* PATCH 2026-10-05: the portal pick comes first; it was made for this delivery. */
    if (!pick && portalPick) {
      pick = portalPick;
    }
    /* PATCH: customer's own first-shipment choice, ahead of the random pick */
    if (!pick && requestedPick) {
      pick = requestedPick;
    }
    if (!pick) {
      pick = pickRandom(candidates);
    }

    const pickText = `${pick.product_title} — ${size} / ${grind}`;
    await setOrderPick(orderId, pickText);

    const pid = numericIdFromGid(pick.product_id);
    /* PATCH: RC_REQUESTED tag makes honored requests visible/filterable in admin */
    const tagsToAdd = ["RC_PICKED", `RC_PID_${pid}`];
    if (requestedPick && pick.product_id === requestedPick.product_id) {
      tagsToAdd.push("RC_REQUESTED");
    }
    /* PATCH 2026-10-05: honoured portal picks and misses are visible in admin */
    if (portalPick && pick.product_id === portalPick.product_id) tagsToAdd.push("RC_PORTAL_PICK");
    if (portalMissed) tagsToAdd.push("RC_PICK_MISSED");
    await addOrderTags(orderId, tagsToAdd);

    await appendOrderNote(orderId, pickText);

    lastMap[key] = pick.product_id;
    await setCustomerLastPickMap(customerId, lastMap);

    /* PATCH 2026-10-05: tell the portal what shipped; clear the request now it's used. */
    let switchedEmail = false;
    try {
      await recordShippedCoffee(customerId, pick, portalMissed);
      const email = order?.customer?.email || pickState.email;
      if (portalMissed) switchedEmail = await notifyPickSwitched({ email, orderName: order.name, requestedTitle: portalMissed, shippedTitle: pick.product_title, size, grind });
      else if (portalPick) await syncPickToKlaviyo({ email, orderName: order.name, shippedTitle: pick.product_title, size, grind });
    } catch (e) {
      // The bag is picked and noted either way; this is bookkeeping for the portal.
      console.error("RC: recording the shipped coffee for the portal failed:", e);
    }

    return res.status(200).json({
      success: true,
      order: order.name,
      /* PATCH: report whether the choice was honored */
      honored_request: Boolean(requestedPick && pick.product_id === requestedPick.product_id),
      requested_handle: requestedHandle,
      /* PATCH 2026-10-05 */
      portal_pick_honored: Boolean(portalPick && pick.product_id === portalPick.product_id),
      portal_pick_missed: portalMissed,
      switched_email_sent: switchedEmail,
      pick: {
        product_title: pick.product_title,
        product_handle: pick.product_handle,
        size,
        grind,
      },
    });
  } catch (err) {
    console.error("Roasters Choice handler error:", err);
    return res.status(500).json({ error: String(err?.message || err) });
  }
}
