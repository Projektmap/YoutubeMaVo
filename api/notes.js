// Sdílené poznámky týmu (IRČA, Patrik, Filip) uložené v Upstash Redis přes REST API.
// Proměnné prostředí ve Vercelu:
//   KV_REST_API_URL + KV_REST_API_TOKEN (doplní Vercel po připojení Upstash Redis)
//   nebo UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN
//   PIN_IRCA, PIN_PATRIK, PIN_FILIP (PIN pro zápis, každý má svůj)
const crypto = require("crypto");

const PEOPLE = { irca: "PIN_IRCA", patrik: "PIN_PATRIK", filip: "PIN_FILIP" };
const MAX_TEXT = 2000;
const MAX_NOTES = 300;
const MAX_FAILS = 10;
const FAIL_WINDOW_S = 900;

async function redis(command) {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error("storage_not_configured");
  const r = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(command),
  });
  const data = await r.json();
  if (!r.ok || data.error) throw new Error(data.error || `redis_${r.status}`);
  return data.result;
}

function pinOk(person, pin) {
  const expected = process.env[PEOPLE[person]];
  if (!expected || typeof pin !== "string") return false;
  const a = crypto.createHash("sha256").update(pin).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

function clientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  return (Array.isArray(fwd) ? fwd[0] : fwd || "").split(",")[0].trim() || "unknown";
}

async function checkPin(req, person, pin) {
  const failKey = `fail:${clientIp(req)}`;
  const fails = Number(await redis(["GET", failKey])) || 0;
  if (fails >= MAX_FAILS) return "locked";
  if (pinOk(person, pin)) return "ok";
  await redis(["INCR", failKey]);
  await redis(["EXPIRE", failKey, FAIL_WINDOW_S]);
  return "bad";
}

async function list(person) {
  const raw = await redis(["LRANGE", `notes:${person}`, 0, MAX_NOTES - 1]);
  return (raw || []).map((s) => {
    try { return JSON.parse(s); } catch { return null; }
  }).filter(Boolean);
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    const person = String((req.method === "GET" ? req.query.person : body.person) || "").toLowerCase();
    if (!PEOPLE[person]) return res.status(400).json({ error: "Neznámá záložka." });

    if (req.method === "GET") {
      return res.status(200).json({ notes: await list(person) });
    }

    const auth = await checkPin(req, person, body.pin);
    if (auth === "locked") return res.status(429).json({ error: "Moc špatných PINů. Zkus to za 15 minut." });
    if (auth !== "ok") return res.status(403).json({ error: "Špatný PIN." });

    if (req.method === "POST") {
      const text = String(body.text || "").trim();
      if (!text) return res.status(400).json({ error: "Poznámka je prázdná." });
      if (text.length > MAX_TEXT) return res.status(400).json({ error: `Poznámka může mít max ${MAX_TEXT} znaků.` });
      const note = { id: crypto.randomUUID(), text, at: new Date().toISOString() };
      await redis(["LPUSH", `notes:${person}`, JSON.stringify(note)]);
      await redis(["LTRIM", `notes:${person}`, 0, MAX_NOTES - 1]);
      return res.status(201).json({ note });
    }

    if (req.method === "DELETE") {
      const raw = await redis(["LRANGE", `notes:${person}`, 0, MAX_NOTES - 1]);
      const hit = (raw || []).find((s) => {
        try { return JSON.parse(s).id === body.id; } catch { return false; }
      });
      if (!hit) return res.status(404).json({ error: "Poznámka nenalezena." });
      await redis(["LREM", `notes:${person}`, 1, hit]);
      return res.status(200).json({ ok: true });
    }

    res.setHeader("Allow", "GET, POST, DELETE");
    return res.status(405).json({ error: "Nepodporovaná metoda." });
  } catch (e) {
    if (e.message === "storage_not_configured") {
      return res.status(503).json({ error: "Úložiště poznámek zatím není nastavené." });
    }
    return res.status(500).json({ error: "Chyba serveru, zkus to znovu." });
  }
};
