import "dotenv/config";
import express from "express";
import rateLimit from "express-rate-limit";

const PORT = Number(process.env.PORT || 3001);
// Shared secret with travity-server (BOOKING_PROVIDER_API_KEY). When set,
// every booking endpoint requires Authorization: Bearer <key>. Unset = local dev only.
const PROVIDER_API_KEY = String(process.env.BOOKING_PROVIDER_API_KEY || process.env.PROVIDER_API_KEY || "").trim();

function requireProviderAuth(req, res, next) {
  // Fail closed in production: an unset shared secret must never mean open.
  // Local dev (NODE_ENV!=production) stays open for harness convenience.
  if (!PROVIDER_API_KEY) {
    if (String(process.env.NODE_ENV || "").toLowerCase() === "production") {
      return res.status(401).json({ error: "unauthorized: provider API key not configured" });
    }
    return next();
  }
  const auth = String(req.headers.authorization || "");
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (token !== PROVIDER_API_KEY) return res.status(401).json({ error: "unauthorized" });
  return next();
}

const PII_FIELDS = ["given_name", "family_name", "born_on", "gender", "title", "email", "phone_number"];

function validPassenger(p) {
  if (!p || typeof p !== "object") return "passenger object required";
  for (const f of PII_FIELDS) {
    if (!String(p[f] ?? "").trim()) return `passenger.${f} required`;
  }
  if (Number.isNaN(Date.parse(String(p.born_on)))) return "passenger.born_on must be a valid date";
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(p.email))) return "passenger.email invalid";
  return null;
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
app.use((req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Accept, Authorization, X-Wallet-Address, X-Wallet-Signature");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.get("/health", (_req, res) => res.json({ ok: true, service: "travity-booking-provider", duffelConfigured: Boolean(String(process.env.DUFFEL_API_KEY || "").trim()), providerKeyConfigured: Boolean(PROVIDER_API_KEY), commit: String(process.env.RENDER_GIT_COMMIT || "local").slice(0, 7) }));

const limiter = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: true, legacyHeaders: false });

const _offerCache = new Map();
const OFFER_TTL_MS = 300_000;
const _offer429Cache = new Map();
const NEG_TTL_MS = 60_000;
// Single-flight: concurrent holds for the same route/date share one Duffel call.
const _offerInflight = new Map();

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

app.post("/book", limiter, (req, res) => {
  return res.status(410).json({ error: "gone: use POST /offer-hold then hold_booking, then POST /confirm" });
});

app.post("/book-legacy", limiter, requireProviderAuth, async (req, res) => {
  const from = String(req.body?.from ?? req.body?.origin ?? "").trim().toUpperCase();
  const to = String(req.body?.to ?? req.body?.destination ?? "").trim().toUpperCase();
  const departRaw = String(req.body?.depart ?? "").trim();
  const retRaw = String(req.body?.ret ?? "").trim();
  const reqPassenger = req.body?.passenger ?? null;
  const reqItineraryJson = String(req.body?.itinerary_json ?? req.body?.itineraryJson ?? "").trim() || null;
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

      // Use caller-supplied passenger if present, else dummy John Doe (dev)
      const pasIn = reqPassenger && typeof reqPassenger === "object" ? reqPassenger : {};
      const passengerForOrder = {
        id: offer.passengers?.[0]?.id ?? String(pasIn.id ?? "pas_00000000000000"),
        given_name: String(pasIn.given_name ?? "John"),
        family_name: String(pasIn.family_name ?? "Doe"),
        born_on: String(pasIn.born_on ?? "1990-01-01"),
        gender: String(pasIn.gender ?? "m"),
        title: String(pasIn.title ?? "mr"),
        email: String(pasIn.email ?? "john.doe@example.com"),
        phone_number: String(pasIn.phone_number ?? "+14155551234"),
      };
      const itineraryJsonBound = reqItineraryJson ?? JSON.stringify({ slices: offer.slices, passengers: offer.passengers, cabin_class: "economy" });
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
            passengers: [passengerForOrder],
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
        offerId: offer.id,
        passengerId: passengerForOrder.id,
        itinerary_json: itineraryJsonBound,
        refundPolicy: refundPolicyFrom(orderJson.data?.conditions),
      });
    } catch (e) {
      console.error("[booking-provider] Duffel transaction failed:", e.message);
      return res.status(502).json({ error: `booking provider failed: ${e.message}` });
    }
  }

  // No DUFFEL_API_KEY: no fallback — real Duffel transaction required.
  return res.status(503).json({ error: "booking provider not configured: DUFFEL_API_KEY missing" });
});

// Offer hold — free, no Duffel charge. Returns off_… for hold_booking.
app.post("/offer-hold", limiter, requireProviderAuth, async (req, res) => {
  const from = String(req.body?.from ?? "").trim().toUpperCase();
  const to = String(req.body?.to ?? "").trim().toUpperCase();
  const departRaw = String(req.body?.depart ?? "").trim();
  const departIso = toIso(departRaw) ?? departRaw;
  if (!IATA_RE.test(from) || !IATA_RE.test(to) || from === to) return res.status(400).json({ error: "from/to must be distinct 3-letter IATA codes" });
  if (!departIso || Number.isNaN(Date.parse(departIso))) return res.status(400).json({ error: "depart must be YYYYMMDD" });
  const duffelKey = String(process.env.DUFFEL_API_KEY || "").trim();
  if (!duffelKey) return res.status(503).json({ error: "booking provider not configured: DUFFEL_API_KEY missing" });
  const cacheKey = `${from}|${to}|${departIso}`;
  const neg = _offer429Cache.get(cacheKey);
  if (neg && Date.now() - neg.ts < NEG_TTL_MS) {
    const waitS = Math.max(1, Math.ceil((NEG_TTL_MS - (Date.now() - neg.ts)) / 1000));
    res.set("Retry-After", String(waitS));
    return res.status(429).json({ error: "Duffel rate limited (429), please retry shortly", retryAfter: String(waitS) });
  }
  const cached = _offerCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < OFFER_TTL_MS) {
    return res.json(cached.value);
  }
  // Single-flight: join an in-progress Duffel call for the same key instead of firing another.
  const inflight = _offerInflight.get(cacheKey);
  if (inflight) {
    try {
      const value = await inflight;
      return res.json(value);
    } catch (e) {
      const is429 = /429/.test(e.message || "");
      return res.status(is429 ? 429 : 502).json({ error: `offer-hold failed: ${e.message}`, retryAfter: is429 ? "30" : undefined });
    }
  }
  const task = (async () => {
    const doFetch = async () => fetch("https://api.duffel.com/air/offer_requests", {
      method: "POST",
      headers: { Authorization: `Bearer ${duffelKey}`, "Duffel-Version": "v2", "Content-Type": "application/json" },
      body: JSON.stringify({ data: { slices: [{ origin: from, destination: to, departure_date: departIso }], passengers: [{ type: "adult" }], cabin_class: "economy" } }),
    });
    let offerReq = await doFetch();
    if (offerReq.status === 429) {
      // Honor Duffel's own backoff, then fail fast with 429 so callers back off —
      // holding the connection open on repeated retries burns quota faster.
      const retryAfter = offerReq.headers.get("retry-after") || "30";
      console.warn(`[booking-provider] Duffel 429, retry-after=${retryAfter} for ${cacheKey}`);
      _offer429Cache.set(cacheKey, { ts: Date.now() });
      const err = new Error(`Duffel offer_requests 429 (retry after ${retryAfter}s)`);
      err.retryAfter = retryAfter;
      throw err;
    }
    if (!offerReq.ok) throw new Error(`Duffel offer_requests ${offerReq.status}`);
    const offerJson = await offerReq.json();
    const offer = offerJson.data?.offers?.[0] ?? offerJson.data?.offer_requests?.[0]?.offers?.[0];
    if (!offer?.id) throw new Error("Duffel returned no offers");
    const passengerId = offer.passengers?.[0]?.id ?? "pas_00000000000000";
    const itineraryJson = JSON.stringify({ slices: offer.slices, passengers: offer.passengers, cabin_class: "economy" });
    const value = { offerId: offer.id, passengerId, itinerary_json: itineraryJson, expiresAt: offer.expires_at ?? null, totalAmount: offer.total_amount, totalCurrency: offer.total_currency };
    _offerCache.set(cacheKey, { ts: Date.now(), value });
    _offer429Cache.delete(cacheKey);
    return value;
  })();
  _offerInflight.set(cacheKey, task);
  try {
    const value = await task;
    return res.json(value);
  } catch (e) {
    console.error("[booking-provider] offer-hold failed:", e.message);
    const is429 = /429/.test(e.message || "");
    const ra = (e.retryAfter || "30").toString();
    if (is429) {
      _offer429Cache.set(cacheKey, { ts: Date.now() });
      res.set("Retry-After", ra);
    }
    return res.status(is429 ? 429 : 502).json({ error: `offer-hold failed: ${e.message}`, retryAfter: is429 ? ra : undefined });
  } finally {
    _offerInflight.delete(cacheKey);
  }
});

// Confirm — creates real Duffel order after escrow. Caller must have held offer.
app.post("/confirm", limiter, requireProviderAuth, async (req, res) => {
  const offerId = String(req.body?.offerId ?? req.body?.offer_id ?? "").trim();
  const pasId = String(req.body?.passengerId ?? req.body?.passenger_id ?? "").trim();
  const totalAmount = String(req.body?.totalAmount ?? req.body?.total_amount ?? "").trim();
  const totalCurrency = String(req.body?.totalCurrency ?? req.body?.total_currency ?? "USD").trim() || "USD";
  const passenger = req.body?.passenger ?? null;
  if (!offerId.startsWith("off_")) return res.status(400).json({ error: "offerId required" });
  if (!pasId.startsWith("pas_")) return res.status(400).json({ error: "passengerId must be a Duffel pas_… from offer-hold" });
  if (!totalAmount) return res.status(400).json({ error: "totalAmount required (from offer-hold)" });
  const piiErr = validPassenger(passenger);
  if (piiErr) return res.status(400).json({ error: piiErr });
  const duffelKey = String(process.env.DUFFEL_API_KEY || "").trim();
  if (!duffelKey) return res.status(503).json({ error: "booking provider not configured: DUFFEL_API_KEY missing" });
  try {
    // Re-fetch the offer live and verify the caller's amount matches Duffel's
    // own total — never trust a caller-supplied price for the balance payment.
    const offerLookup = await fetch(`https://api.duffel.com/air/offers/${encodeURIComponent(offerId)}`, {
      headers: { Authorization: `Bearer ${duffelKey}`, "Duffel-Version": "v2" },
    });
    if (!offerLookup.ok) {
      return res.status(502).json({ error: `Duffel offer lookup failed (${offerLookup.status})` });
    }
    const offerJson = await offerLookup.json();
    const live = offerJson.data ?? {};
    if (String(live.total_amount ?? "") !== totalAmount || String(live.total_currency ?? "").toUpperCase() !== totalCurrency.toUpperCase()) {
      return res.status(409).json({ error: "offer total changed since hold; re-hold required" });
    }
    const orderRes = await fetch("https://api.duffel.com/air/orders", {
      method: "POST",
      headers: { Authorization: `Bearer ${duffelKey}`, "Duffel-Version": "v2", "Content-Type": "application/json" },
      body: JSON.stringify({ data: { type: "instant", selected_offers: [offerId], passengers: [{ id: pasId, given_name: String(passenger.given_name).trim(), family_name: String(passenger.family_name).trim(), born_on: String(passenger.born_on).trim(), gender: String(passenger.gender).trim(), title: String(passenger.title).trim(), email: String(passenger.email).trim(), phone_number: String(passenger.phone_number).trim() }], payments: [{ type: "balance", amount: totalAmount, currency: totalCurrency }] } }),
    });
    if (!orderRes.ok) {
      const txt = await orderRes.text().catch(() => "");
      throw new Error(`Duffel create order ${orderRes.status}: ${txt.slice(0, 200)}`);
    }
    const orderJson = await orderRes.json();
    const locator = String(orderJson.data?.booking_reference ?? orderJson.data?.id ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
    return res.json({ duffelOrderId: orderJson.data?.id ?? null, locator, refundPolicy: refundPolicyFrom(orderJson.data?.conditions) });
  } catch (e) {
    return res.status(502).json({ error: `confirm failed: ${e.message}` });
  }
});

// Cancel a Duffel order (reaper path for orphan paid orders never sealed
// on-chain). Best-effort: test-mode cancellations refund balance automatically;
// live non-refundable fares may still charge — the response always says how.
app.post("/cancel", limiter, requireProviderAuth, async (req, res) => {
  const orderId = String(req.body?.orderId ?? req.body?.order_id ?? "").trim();
  if (!orderId.startsWith("ord_")) return res.status(400).json({ error: "orderId must be a Duffel ord_…" });
  const duffelKey = String(process.env.DUFFEL_API_KEY || "").trim();
  if (!duffelKey) return res.status(503).json({ error: "booking provider not configured: DUFFEL_API_KEY missing" });
  try {
    const cancelRes = await fetch("https://api.duffel.com/air/order_cancellations", {
      method: "POST",
      headers: { Authorization: `Bearer ${duffelKey}`, "Duffel-Version": "v2", "Content-Type": "application/json" },
      body: JSON.stringify({ data: { order_id: orderId } }),
    });
    const j = await cancelRes.json().catch(() => ({}));
    if (!cancelRes.ok) {
      const txt = typeof j === "object" ? JSON.stringify(j).slice(0, 200) : String(j).slice(0, 200);
      return res.status(502).json({ error: `Duffel cancel failed (${cancelRes.status}): ${txt}` });
    }
    return res.json({ orderId, cancelled: true, refund: j.data?.refund_amount ?? j.data?.refund_to ?? null });
  } catch (e) {
    return res.status(502).json({ error: `cancel failed: ${e.message}` });
  }
});

// Live, independent re-verification: re-fetches the order directly from
// Duffel at dispute time instead of trusting whatever this server has
// cached locally. This is what the dispute path calls through
// travity-server's /provider-status so the evidence a validator sees is a
// fresh carrier-side lookup, not project-controlled state.
app.get("/order-status", limiter, requireProviderAuth, async (req, res) => {
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
    // Actual carrier completion: all ticketed segments arrived in the past.
    // A merely confirmed (paid, future) order stays "confirmed" — elapsed
    // date alone never promotes to completed here.
    let completed = false;
    try {
      const segs = [];
      for (const sl of (j.data?.slices ?? [])) {
        for (const sg of (sl?.segments ?? [])) segs.push(sg);
      }
      if (segs.length > 0) {
        completed = segs.every((sg) => {
          const arr = Date.parse(String(sg?.arriving_at ?? ""));
          return Number.isFinite(arr) && arr < Date.now();
        });
      }
    } catch { completed = false; }
    return res.json({
      duffelOrderId: orderId,
      status: cancelled ? "cancelled" : completed ? "completed" : "confirmed",
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
