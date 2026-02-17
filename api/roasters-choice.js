export const config = { api: { bodyParser: false } };

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

export default async function handler(req, res) {
  const EXPECTED_TOKEN = "rc_3bfa8d1c9e2a4f7b6c8d0e1f2a3b4c5d";

  try {
    const incomingToken = req.headers["x-rc-token"];
    if (!incomingToken || incomingToken !== EXPECTED_TOKEN) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method Not Allowed" });
    }

    const raw = await readRawBody(req);
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch (e) {
      return res.status(400).json({ error: "Invalid JSON", raw });
    }

    console.log("Received Roaster's Choice order:", {
      order_id: payload?.order_id,
      order_name: payload?.order_name,
      customer_id: payload?.customer_id
    });

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("Handler error:", err);
    return res.status(500).json({ error: "Server error" });
  }
}
