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

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function findSizeAndGrindFromLineItems(lineItems) {
  // Find any line item whose variant has selectedOptions containing Size + Grind Size
  for (const li of lineItems || []) {
    const opts = li?.variant?.selectedOptions || [];
    const size = opts.find((o) => o.name === "Size")?.value || null;
    const grind =
      opts.find(o => o.name === "Grind Size")?.value ||
      opts.find(o => o.name === "Whole Bean or Ground")?.value ||
  null;

    if (size && grind) return { size, grind, lineItem: li };
  }
  return { size: null, grind: null, lineItem: null };
}

async function getCustomerLastPickMap(customerId) {
  const q = `
    query($id: ID!) {
      customer(id: $id) {
        id
        metafield(namespace: "roasters_choice", key: "last_pick_map") { value }
      }
    }
  `;
  const data = await shopifyGraphQL(q, { id: customerId });
  const raw = data?.customer?.metafield?.value;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

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

  const updatedNote = currentNote ? `${currentNote}\n\n${noteText}` : noteText;

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
  const q = `
    query($id: ID!) {
      order(id: $id) {
        id
        name
        customer { id email }
        lineItems(first: 50) {
          nodes {
            id
            title
            quantity
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

async function getEligibleFromCollection(collectionHandle, size, grind) {
  const q = `
    query($handle: String!, $cursor: String) {
      collectionByHandle(handle: $handle) {
        id
        title
        products(first: 100, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            title
            handle
            status
            tags
            variants(first: 100) {
              nodes {
                id
                title
                availableForSale
                selectedOptions { name value }
              }
            }
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
      if (p.tags?.includes("exclude_roasters_choice")) continue;

      const v = p.variants.nodes.find((vr) => {
        if (!vr.availableForSale) return false;
        const vSize = vr.selectedOptions.find((o) => o.name === "Size")?.value;
        const vGrind = vr.selectedOptions.find((o) => o.name === "Whole Bean or Ground")?.value;
        return vSize === size && vGrind === grind;
      });

      if (v) {
        candidates.push({
          product_id: p.id,
          product_title: p.title,
          product_handle: p.handle,
          variant_id: v.id,
        });
      }
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
    const { size, grind } = findSizeAndGrindFromLineItems(lineItems);

    if (!size || !grind) {
      return res.status(409).json({
        error: "Could not determine Size and Grind Size from order line items",
        order_name: order.name,
      });
    }

    const key = `${size}|${grind}`;
    const lastMap = await getCustomerLastPickMap(customerId);
    const lastProductId = lastMap[key] || null;

    const collectionHandle = "single-origin-coffee";
    let candidates = await getEligibleFromCollection(collectionHandle, size, grind);

    if (candidates.length === 0) {
      return res.status(409).json({ error: "No eligible coffees found", size, grind });
    }

    // No-repeat if possible
    if (lastProductId && candidates.length > 1) {
      const filtered = candidates.filter((c) => c.product_id !== lastProductId);
      if (filtered.length > 0) candidates = filtered;
    }

    const pick = pickRandom(candidates);

    const pickText = `${pick.product_title} — ${size} / ${grind}`;
    await setOrderPick(orderId, pickText);

   await addOrderTags(orderId, [
  "RC_PICKED",
  makeSafeTag(pick.product_handle)
]);

    await appendOrderNote(orderId, pickText);

    lastMap[key] = pick.product_id;
    await setCustomerLastPickMap(customerId, lastMap);

    return res.status(200).json({
      success: true,
      order: order.name,
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
