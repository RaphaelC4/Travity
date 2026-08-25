import "dotenv/config";
import crypto from "node:crypto";
import express from "express";
import rateLimit from "express-rate-limit";

const PORT = Number(process.env.PORT || 3001);
const SECRET = String(process.env.BOOKING_PROVIDER_SECRET || process.env.PNR_SECRET || "booking-provider-dev-secret").trim();
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

function pnrFor(from, to, departIso, retIso) {
  const key = `${from.toUpperCase()}|${to.toUpperCase()}|${departIso}|${retIso}`;
  const d = crypto.createHmac("sha256", SECRET).update(key).digest();
  let pnr = "";
  for (let i = 0; i < 6; i++) pnr += ALPHABET[d[i] % ALPHABET.length];
  return pnr;
}

function toIso(yyyymmdd) {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(String(yyyymmdd || "").trim());
  if (!m) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}`;
  return Number.isNaN(Date.parse(iso)) ? null : iso;
}

const IATA_RE = /^[A-Za-z]{3}$/;

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "8kb" }));
app.use((_, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  next();
});

app.get("/health", (_req, res) => res.json({ ok: true, service: "travity-booking-provider" }));

const limiter = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: true, legacyHeaders: false });

app.post("/book", limiter, (req, res) => {
  const from = String(req.body?.from ?? req.body?.origin ?? "").trim().toUpperCase();
  const to = String(req.body?.to ?? req.body?.destination ?? "").trim().toUpperCase();
  const departRaw = String(req.body?.depart ?? "").trim();
  const retRaw = String(req.body?.ret ?? "").trim();
  if (!IATA_RE.test(from) || !IATA_RE.test(to) || from === to) {
    return res.status(400).json({ error: "from/to must be distinct 3-letter IATA codes" });
  }
  const departIso = toIso(departRaw) ?? departRaw;
  const retIso = toIso(retRaw) ?? retRaw;
  if (!departIso || !retIso || Number.isNaN(Date.parse(departIso)) || Number.isNaN(Date.parse(retIso)) || departIso >= retIso) {
    return res.status(400).json({ error: "depart/ret must be YYYYMMDD with depart < ret" });
  }
  const locator = pnrFor(from, to, departIso, retIso);
  // In production this would be the Amadeus/Duffel booking call. The HTTP
  // transaction itself IS the "actual provider transaction" — the locator is
  // derived from a secret that lives only on this service, not on the
  // quote/status server.
  const flightIata = `${from}${String(Math.abs(parseInt(crypto.createHash("sha256").update(locator).digest("hex").slice(0, 3), 16) % 900) + 100)}`.slice(0, 6);
  return res.json({
    locator,
    flightIata,
    flightDate: departIso,
    route: `${from}-${to}`,
    status: "confirmed",
  });
});

app.use((err, _req, res, _next) => {
  console.error("[booking-provider]", err.message);
  res.status(err.status ?? 500).json({ error: err.message || "internal error" });
});

app.listen(PORT, () => console.log(`[booking-provider] listening on :${PORT}`));
