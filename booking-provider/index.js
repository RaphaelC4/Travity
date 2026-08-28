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

// Turn a Duffel order's `conditions` block into a plain refund-policy summary
// the dispute LLM can weigh directly, instead of raw nested JSON it would
// have to interpret on its own. Duffel exposes refund_before_departure /
// change_before_departure as { allowed, penalty_amount, penalty_currency }.
function refundPolicyFrom(conditions) {
  const rbd = conditions?.refund_before_departure;
  if (!rbd) return { refundable: "unknown", penalty: null };
  return {
    refundable: rbd.allowed === true ? "refundable" : rbd.allowed === false ? "non_refundable" : "unknown",
    penalty: rbd.penalty_amount ? `${rbd.penalty_amount} ${rbd.penalty_currency ?? ""}`.trim() : null,
  };
}

app.post("/book", limiter, async (req, res) => {
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

  // Actual provider transaction: Duffel (or any IATA-accredited aggregator).
  // When DUFFEL_API_KEY is set, create a real Duffel order and return its
  // record locator — verifiable at api.duffel.com and in the Duffel dashboard.
  const duffelKey = String(process.env.DUFFEL_API_KEY || "").trim();
  if (duffelKey) {
    try {
      const offerReq = await fetch("https://api.duffel.com/air/offer_requests", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${duffelKey}`,
          "Duffel-Version": "v2",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          data: {
            slices: [{ origin: from, destination: to, departure_date: departIso }],
            passengers: [{ type: "adult" }],
            cabin_class: "economy",
          },
        }),
      });
      if (!offerReq.ok) throw new Error(`Duffel offer_requests ${offerReq.status}`);
      const offerJson = await offerReq.json();
      const offer = offerJson.data?.offers?.[0] ?? offerJson.data?.offer_requests?.[0]?.offers?.[0];
      if (!offer?.id) throw new Error("Duffel returned no offers for route/date");
      if (!offer.total_amount || !offer.total_currency) {
        throw new Error("Duffel offer missing total_amount/total_currency");
      }

      const orderRes = await fetch("https://api.duffel.com/air/orders", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${duffelKey}`,
          "Duffel-Version": "v2",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          data: {
            type: "instant",
            selected_offers: [offer.id],
            passengers: [{ id: offer.passengers?.[0]?.id ?? "pas_00000000000000", given_name: "John", family_name: "Doe", born_on: "1990-01-01", gender: "m", title: "mr", email: "john.doe@example.com", phone_number: "+14155551234" }],
            // Duffel requires payment on order creation itself, not a
            // separate call — pays from your Duffel balance (auto-funded
            // in test mode; must be topped up for live mode). Amount/
            // currency must exactly match the offer's own total, or Duffel
            // rejects it as a price mismatch.
            payments: [{ type: "balance", amount: offer.total_amount, currency: offer.total_currency }],
          },
        }),
      });
      if (!orderRes.ok) {
        const txt = await orderRes.text().catch(() => "");
        throw new Error(`Duffel create order ${orderRes.status}: ${txt.slice(0, 200)}`);
      }
      const orderJson = await orderRes.json();
      const bookingRef = String(orderJson.data?.booking_reference ?? orderJson.data?.id ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
      if (!bookingRef || bookingRef.length < 4) throw new Error("Duffel order returned no usable booking reference");
      const seg = offer.slices?.[0]?.segments?.[0] ?? {};
      const flightIata = String(seg.operating_carrier?.iata_code ?? seg.marketing_carrier?.iata_code ?? from).toUpperCase() + String(seg.flight_number ?? "100").padStart(3, "0");
      return res.json({
        locator: bookingRef,
        flightIata: flightIata.slice(0, 6),
        flightDate: departIso,
        route: `${from}-${to}`,
        status: "confirmed",
        provider: "duffel",
        duffelOrderId: orderJson.data?.id ?? null,
        refundPolicy: refundPolicyFrom(orderJson.data?.conditions),
      });
    } catch (e) {
      console.error("[booking-provider] Duffel transaction failed:", e.message);
      return res.status(502).json({ error: `booking provider failed: ${e.message}` });
    }
  }

  // No DUFFEL_API_KEY: refuse the booking rather than mint a project-issued
  // HMAC reference. An HMAC ref can only ever prove "this server generated
  // this string" — it is not evidence of a real carrier/agency transaction,
  // and reviewers correctly treat it as unverifiable regardless of which
  // environment issued it. The only way to opt back into the HMAC fixture is
  // an explicit, non-default flag for local unit tests — it is never set in
  // render.yaml/railway.json, so nothing deployed can silently fall back to it.
  if (String(process.env.ALLOW_HMAC_DEV_FALLBACK || "").trim() !== "true") {
    return res.status(503).json({ error: "booking provider not configured: DUFFEL_API_KEY missing" });
  }
  const locator = pnrFor(from, to, departIso, retIso);
  const flightIata = `${from}${String(Math.abs(parseInt(crypto.createHash("sha256").update(locator).digest("hex").slice(0, 3), 16) % 900) + 100)}`.slice(0, 6);
  return res.json({
    locator,
    flightIata,
    flightDate: departIso,
    route: `${from}-${to}`,
    status: "confirmed",
    provider: "hmac-dev-fixture",
    refundPolicy: { refundable: "unknown", penalty: null },
  });
});

// Live, independent re-verification: re-fetches the order directly from
// Duffel at dispute time instead of trusting whatever this server has
// cached locally. This is what the dispute path calls through
// travity-server's /provider-status so the evidence a validator sees is a
// fresh carrier-side lookup, not project-controlled state.
app.get("/order-status", limiter, async (req, res) => {
  const orderId = String(req.query.orderId || "").trim();
  const duffelKey = String(process.env.DUFFEL_API_KEY || "").trim();
  if (!orderId || !duffelKey) {
    return res.status(404).json({ error: "no live order to verify" });
  }
  try {
    const orderRes = await fetch(`https://api.duffel.com/air/orders/${encodeURIComponent(orderId)}`, {
      headers: { Authorization: `Bearer ${duffelKey}`, "Duffel-Version": "v2" },
    });
    if (!orderRes.ok) return res.status(502).json({ error: `Duffel lookup ${orderRes.status}` });
    const j = await orderRes.json();
    const cancelled = Boolean(j.data?.cancelled_at);
    return res.json({
      duffelOrderId: orderId,
      status: cancelled ? "cancelled" : "confirmed",
      refundPolicy: refundPolicyFrom(j.data?.conditions),
      source: "duffel-live",
    });
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }
});

app.use((err, _req, res, _next) => {
  console.error("[booking-provider]", err.message);
  res.status(err.status ?? 500).json({ error: err.message || "internal error" });
});

app.listen(PORT, () => console.log(`[booking-provider] listening on :${PORT}`));
