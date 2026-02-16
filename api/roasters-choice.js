export default async function handler(req, res) {
  const EXPECTED_TOKEN = "rc_3bfa8d1c9e2a4f7b6c8d0e1f2a3b4c5d";

  const incomingToken = req.headers["x-rc-token"];
  if (!incomingToken || incomingToken !== EXPECTED_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  let payload = req.body;
  // Vercel parses JSON automatically when Content-Type is application/json
  // If it's a string, try parsing
  if (typeof payload === "string") {
    try { payload = JSON.parse(payload); } catch {}
  }

  console.log("Received Roaster's Choice order:", {
    order_id: payload?.order_id,
    order_name: payload?.order_name,
    customer_id: payload?.customer_id
  });

  return res.status(200).json({ success: true });
}
