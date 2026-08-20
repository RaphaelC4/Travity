#!/usr/bin/env node
/**
 * Travity quote server.
 *
 * - POST/GET /api/quote : rate-limited flight search converted USD -> GEN
 *   (wei) using a cached GEN/USD rate. Fares come from ONE provider, chosen
 *   explicitly via QUOTE_PROVIDER: `rapid` (RapidAPI google-flights2, real
 *   Google Flights fares), `kiwi` (Kiwi.com Tequila) or `omkarcloud`
 *   (OmkarCloud Expedia Scraper). No fallback chain, no demo feed.
 * - GET /quote          : plain-JSON alias a GenLayer contract leader can
 *   fetch from `quote_feed`. Same handler, no date param defaults.
 * - GET /status         : synthetic completion feed for the contract's
 *   confirm_completion / escalate consensus blocks.
 *
 * NO MOCK: with no configured provider it returns 503 rather than fabricating
 * a price. Without a usable GEN price (GEN_USD_RATE or CoinGecko) it returns
 * 503 too.
 *
 * Security notes:
 * - Secrets never leave this process; the browser only ever sees the rounded
 *   price and metadata.
 * - Per-IP rate limiting via express-rate-limit (QUOTE_PROXY_RATE_LIMIT).
 * - Our own quote cache absorbs repeated route/date lookups.
 */
import "dotenv/config";
import express from "express";
import rateLimit from "express-rate-limit";

const PORT = Number(process.env.PORT || 8080);
const OMKAR = {
  host: process.env.OMKAR_BASE_URL || "https://expedia-scraper.omkar.cloud",
  apiKey: process.env.OMKAR_API_KEY || "",
};
const KIWI = {
  host: process.env.KIWI_BASE_URL || "https://tequila-api.kiwi.com",
  apiKey: process.env.KIWI_API_KEY || "",
};
const RAPID = {
  host: process.env.RAPID_API_HOST || "google-flights2.p.rapidapi.com",
  apiKey: process.env.RAPID_API_KEY || "",
};
// Exactly one provider. `rapid` uses RapidAPI google-flights2 (real Google
// Flights fares); `kiwi` uses Kiwi.com Tequila; `omkarcloud` uses the
// OmkarCloud Expedia scraper. Anything else is rejected at boot.
const QUOTE_PROVIDER = String(process.env.QUOTE_PROVIDER || "rapid").toLowerCase();
if (!["rapid", "kiwi", "omkarcloud"].includes(QUOTE_PROVIDER)) {
  throw new Error(`QUOTE_PROVIDER must be one of 'rapid'|'kiwi'|'omkarcloud', got '${QUOTE_PROVIDER}'`);
}
const ACTIVE = QUOTE_PROVIDER === "rapid" ? RAPID : QUOTE_PROVIDER === "kiwi" ? KIWI : OMKAR;
const ACTIVE_KEY_ENV =
  QUOTE_PROVIDER === "rapid" ? "RAPID_API_KEY" : QUOTE_PROVIDER === "kiwi" ? "KIWI_API_KEY" : "OMKAR_API_KEY";
if (!ACTIVE.apiKey) {
  console.error(`[quote-server] WARNING: ${ACTIVE_KEY_ENV} is empty; quotes will 503.`);
}
const WEI_PER_GEN = 10n ** 18n;
const QUOTE_TTL_MS = Number(process.env.QUOTE_TTL_MS || 30 * 60 * 1000);
const GEN_TTL_MS = Number(process.env.GEN_TTL_MS || 5 * 60 * 1000);
const RATE_LIMIT = Number(process.env.QUOTE_PROXY_RATE_LIMIT || 30);
// After the upstream proves itself down (5xx/network/429), skip further
// upstream calls for this window instead of hot-looping a dead provider.
const OUTAGE_COOLDOWN_MS = Number(process.env.OUTAGE_COOLDOWN_MS || 30 * 1000);
// Max age of a last-known-good quote we will still serve (marked `stale`)
// when the live provider is unavailable. Real prices only ever come from an
// actual upstream response; stale only means "not freshly fetched".
const QUOTE_STALE_MAX_MS = Number(process.env.QUOTE_STALE_MAX_MS || 7 * 24 * 60 * 60 * 1000);

const cache = { genUsd: null, quotes: new Map() };

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Transient upstream failure (network, 5xx, 429): may heal, so it arms the
// outage cooldown and can trigger the stale-cache fallback. Deterministic
// failures (401 key, other 4xx, missing quotes) stay plain ApiError and never
// masquerade as a provider outage.
class TransientError extends ApiError {
  constructor(status, message) {
    super(status, message);
    this.transient = true;
  }
}

const IATA_RE = /^[A-Za-z]{3}$/;

function toIsoDate(yyyymmdd, fallbackOffsetDays) {
  if (!yyyymmdd) {
    const d = new Date(Date.now() + fallbackOffsetDays * 86400000);
    return d.toISOString().slice(0, 10);
  }
  const s = String(yyyymmdd).trim();
  if (!/^\d{8}$/.test(s)) throw new ApiError(400, "dates must be YYYYMMDD");
  const iso = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  if (Number.isNaN(Date.parse(iso))) throw new ApiError(400, "invalid date");
  return iso;
}

function parseUsdPrice(raw) {
  if (typeof raw !== "string") return null;
  const m = raw.replace(/[^0-9.,]/g, "").replace(/,/g, "").match(/\d+(\.\d+)?/);
  const v = m ? Number(m[0]) : Number.NaN;
  return Number.isFinite(v) && v > 0 ? v : null;
}

// The OmkarCloud upstream is intermittently flaky (transient 4xx/5xx, dropped
// connections) while still returning healthy quotes on retries. Retry transient
// errors with short backoff; only give up after exhausting attempts, and then
// say WHY so the UI shows something actionable instead of a bare status code.
const UPSTREAM_ATTEMPTS = 3;                 // initial call + 2 retries
const UPSTREAM_RETRY_DELAY_MS = [500, 1000]; // backoff per retry attempt

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function upstreamErrorDetail(res) {
  try {
    const text = (await res.text()).trim().slice(0, 200);
    return text || null;
  } catch {
    return null;
  }
}

async function fetchExpediaQuote({ origin, destination, depart }) {
  if (!OMKAR.apiKey) {
    throw new ApiError(503, "OMKAR_API_KEY not configured. Add it to server/.env, then restart.");
  }
  const params = new URLSearchParams({
    departure_airport_code: origin,
    arrival_airport_code: destination,
    departure_date: depart,
    cabin_class: "coach",
  });
  const url = `${OMKAR.host}/expedia/flights/one-way?${params}`;
  const headers = { "API-Key": OMKAR.apiKey, Accept: "application/json" };

  let res = null;
  let networkErr = null;
  for (let attempt = 0; attempt < UPSTREAM_ATTEMPTS; attempt++) {
    try {
      res = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
      networkErr = null;
    } catch (err) {
      res = null;
      networkErr = err.message;
    }

    if (res) {
      if (res.status === 401) {
        // Deterministic: a bad key never heals on retry.
        throw new ApiError(502, "Expedia API rejected the key (401). Check OMKAR_API_KEY in server/.env.");
      }
      if (res.ok) break;
      if (res.status < 500 && res.status !== 429) {
        // Other 4xx: a deterministic provider rejection (bad route/date/quota).
        const detail = await upstreamErrorDetail(res);
        throw new ApiError(
          502,
          `Expedia flight search failed (${res.status}${detail ? `: ${detail}` : ""}). ` +
            "Try a different route or dates, or check the API key quota."
        );
      }
      // else 5xx or 429: transient — fall through to retry/backoff below.
    }

    if (attempt < UPSTREAM_ATTEMPTS - 1) {
      await sleep(UPSTREAM_RETRY_DELAY_MS[attempt] ?? 750);
      continue;
    }

    if (networkErr) {
      throw new TransientError(502, `Expedia API unreachable after ${UPSTREAM_ATTEMPTS} attempts: ${networkErr}`);
    }
    const detail = res ? await upstreamErrorDetail(res) : null;
    const status = res?.status === 429 ? 429 : 502;
    throw new TransientError(
      status,
      `Expedia API temporarily unavailable after ${UPSTREAM_ATTEMPTS} attempts (${res?.status ?? "network"}${detail ? `: ${detail}` : ""}). Try again in a moment.`
    );
  }

  const j = await res.json();
  const flights = Array.isArray(j.flights) ? j.flights : [];
  if (!flights.length) throw new ApiError(404, "No quotes from provider for this route/date.");

  let best = null;
  for (const f of flights) {
    const fare = f.fare_options?.[0];
    const price = parseUsdPrice(fare?.price_detail) ?? parseUsdPrice(fare?.display_price) ?? parseUsdPrice(f?.starting_price);
    if (price == null) continue;
    if (best == null || price < best.price) best = { price, f };
  }
  if (!best) throw new ApiError(404, "No priced quotes from provider for this route/date.");

  return {
    usdTotal: best.price,
    usdCurrency: "USD",
    carrier: best.f.airlines?.[0]?.name || "",
  };
}

async function fetchKiwiFare({ origin, destination, depart }) {
  if (!KIWI.apiKey) {
    throw new ApiError(503, "KIWI_API_KEY not configured. Add it to server/.env, then restart.");
  }
  // Kiwi dates are DD/MM/YYYY and `date_from`..`date_to` is a ranged window;
  // a single-day search uses the same date for both ends.
  const dmy = (iso) => iso.replaceAll("-", "/").split("/").reverse().join("/");
  const d = dmy(depart);
  const params = new URLSearchParams({
    fly_from: origin,
    fly_to: destination,
    date_from: d,
    date_to: d,
    adults: "1",
    curr: "USD",
    max_stopovers: "2",
    limit: "10",
  });
  const url = `${KIWI.host}/v2/search?${params}`;
  const headers = { apikey: KIWI.apiKey, Accept: "application/json" };

  let res = null;
  let networkErr = null;
  for (let attempt = 0; attempt < UPSTREAM_ATTEMPTS; attempt++) {
    try {
      res = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
      networkErr = null;
    } catch (err) {
      res = null;
      networkErr = err.message;
    }

    if (res) {
      if (res.status === 401) {
        // Deterministic: a bad key never heals on retry.
        throw new ApiError(502, "Kiwi rejected the key (401). Check KIWI_API_KEY in server/.env.");
      }
      if (res.ok) break;
      if (res.status < 500 && res.status !== 429) {
        const detail = await upstreamErrorDetail(res);
        throw new ApiError(
          502,
          `Kiwi flight search failed (${res.status}${detail ? `: ${detail}` : ""}). ` +
            "Try a different route or dates, or check the API key quota."
        );
      }
      // else 5xx or 429: transient — fall through to retry/backoff below.
    }

    if (attempt < UPSTREAM_ATTEMPTS - 1) {
      await sleep(UPSTREAM_RETRY_DELAY_MS[attempt] ?? 750);
      continue;
    }

    if (networkErr) {
      throw new TransientError(502, `Kiwi API unreachable after ${UPSTREAM_ATTEMPTS} attempts: ${networkErr}`);
    }
    const detail = res ? await upstreamErrorDetail(res) : null;
    const status = res?.status === 429 ? 429 : 502;
    throw new TransientError(
      status,
      `Kiwi API temporarily unavailable after ${UPSTREAM_ATTEMPTS} attempts (${res?.status ?? "network"}${detail ? `: ${detail}` : ""}). Try again in a moment.`
    );
  }

  const j = await res.json();
  const offers = Array.isArray(j.data) ? j.data : [];
  let best = null;
  for (const o of offers) {
    const price = Number(o.price);
    if (!Number.isFinite(price) || price <= 0) continue;
    if (best == null || price < best.price) best = { price, o };
  }
  if (!best) throw new ApiError(404, "No priced Kiwi quotes for this route/date.");

  const a = best.o.airlines?.[0];
  return {
    usdTotal: best.price,
    usdCurrency: "USD",
    carrier: typeof a === "string" ? a : "",
  };
}

async function fetchRapidFare({ origin, destination, depart }) {
  if (!RAPID.apiKey) {
    throw new ApiError(503, "RAPID_API_KEY not configured. Add it to server/.env, then restart.");
  }
  const params = new URLSearchParams({
    departure_id: origin,
    arrival_id: destination,
    outbound_date: depart, // YYYY-MM-DD (ISO from toIsoDate)
    adults: "1",
    travel_class: "ECONOMY",
    currency: "USD",
  });
  const url = `https://${RAPID.host}/api/v1/searchFlights?${params}`;
  const headers = { "X-RapidAPI-Key": RAPID.apiKey, "X-RapidAPI-Host": RAPID.host, Accept: "application/json" };

  let res = null;
  let networkErr = null;
  for (let attempt = 0; attempt < UPSTREAM_ATTEMPTS; attempt++) {
    try {
      res = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
      networkErr = null;
    } catch (err) {
      res = null;
      networkErr = err.message;
    }

    if (res) {
      if (res.status === 401 || res.status === 403) {
        // Deterministic: a bad key never heals on retry.
        throw new ApiError(502, "RapidAPI rejected the key (401/403). Check RAPID_API_KEY in server/.env.");
      }
      if (res.ok) break;
      if (res.status < 500 && res.status !== 429) {
        const detail = await upstreamErrorDetail(res);
        throw new ApiError(
          502,
          `RapidAPI google-flights2 search failed (${res.status}${detail ? `: ${detail}` : ""}). ` +
            "Try a different route or dates, or check the subscription/quota."
        );
      }
      // else 5xx or 429: transient — fall through to retry/backoff below.
    }

    if (attempt < UPSTREAM_ATTEMPTS - 1) {
      await sleep(UPSTREAM_RETRY_DELAY_MS[attempt] ?? 750);
      continue;
    }

    if (networkErr) {
      throw new TransientError(502, `RapidAPI unreachable after ${UPSTREAM_ATTEMPTS} attempts: ${networkErr}`);
    }
    const detail = res ? await upstreamErrorDetail(res) : null;
    const status = res?.status === 429 ? 429 : 502;
    throw new TransientError(
      status,
      `RapidAPI temporarily unavailable after ${UPSTREAM_ATTEMPTS} attempts (${res?.status ?? "network"}${detail ? `: ${detail}` : ""}). Try again in a moment.`
    );
  }

  const j = await res.json();
  const topFlights = j?.data?.itineraries?.topFlights ?? j?.data?.itineraries?.flights ?? [];
  let best = null;
  for (const f of topFlights) {
    const price = Number(f.price);
    if (!Number.isFinite(price) || price <= 0) continue;
    if (best == null || price < best.price) best = { price, f };
  }
  if (!best) throw new ApiError(404, "No priced RapidAPI quotes for this route/date.");

  return {
    usdTotal: best.price,
    usdCurrency: "USD",
    carrier: Array.isArray(best.f.airlines) ? best.f.airlines.join("/") : String(best.f.airlines || ""),
  };
}

async function fetchFare({ origin, destination, depart }) {
  if (QUOTE_PROVIDER === "rapid") {
    const fare = await fetchRapidFare({ origin, destination, depart });
    return { ...fare, provider: "rapid" };
  }
  if (QUOTE_PROVIDER === "kiwi") {
    const fare = await fetchKiwiFare({ origin, destination, depart });
    return { ...fare, provider: "kiwi" };
  }
  const fare = await fetchExpediaQuote({ origin, destination, depart });
  return { ...fare, provider: "omkarcloud" };
}

async function getGenUsdRate() {
  if (cache.genUsd && Date.now() < cache.genUsd.fetchedAt + GEN_TTL_MS) {
    return cache.genUsd.rate;
  }
  const configured = Number(process.env.GEN_USD_RATE);
  if (Number.isFinite(configured) && configured > 0) {
    cache.genUsd = { rate: configured, fetchedAt: Date.now() };
    return configured;
  }
  const ids = (process.env.COINGECKO_TOKEN_IDS || "genlayer")
    .split(",").map((s) => s.trim()).filter(Boolean);
  for (const id of ids.slice(0, 5)) {
    try {
      const url = `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(id)}&vs_currencies=usd`;
      const j = await (await fetch(url, { signal: AbortSignal.timeout(8000) })).json();
      const v = Number(j?.[id]?.usd);
      if (Number.isFinite(v) && v > 0) {
        cache.genUsd = { rate: v, fetchedAt: Date.now() };
        return v;
      }
    } catch {
      /* try next id */
    }
  }
  throw new ApiError(503, "GEN/USD price unavailable. Set GEN_USD_RATE in server/.env or a CoinGecko token id via COINGECKO_TOKEN_IDS.");
}

async function buildQuote(origin, destination, depart, ret) {
  const key = `${origin}-${destination}-${depart}-${ret || ""}`;
  const hit = cache.quotes.get(key);
  if (hit && Date.now() < hit.ts + QUOTE_TTL_MS) return hit.value;

  const now = Date.now();

  // Circuit breaker: while the upstream is in a cooldown window after
  // consecutive failures, don't hot-loop a dead provider. Serve a recent
  // last-known-good price if we have one; otherwise fail fast and clearly.
  if (now < (cache.outageUntil || 0)) {
    const stale = cache.quotes.get(key);
    if (stale && now < stale.ts + QUOTE_STALE_MAX_MS) {
      return { ...stale.value, stale: true, stale_age_s: Math.round((now - stale.ts) / 1000) };
    }
    throw new ApiError(
      503,
      "Flight price provider is currently in an outage (persistent server errors). " +
        "The live price will recover automatically once the provider is back. " +
        "Please try again in a moment."
    );
  }

  // Fare provider(s) cover the outbound leg; ret is validated but not
  // used for pricing.
  try {
    const fare = await fetchFare({ origin, destination, depart });
    const { usdTotal, usdCurrency, carrier, provider } = fare;
    const rate = await getGenUsdRate();

    // USD -> GEN (wei). 1 GEN = 10^18 wei. priceWei = (usd / rate) * 10^18.
    const priceWei = BigInt(Math.round((usdTotal / rate) * 1e18));

    const value = {
      route: `${origin}-${destination}`,
      currency: "GEN",
      price_wei: priceWei.toString(),
      usd_total: usdTotal,
      usd_currency: usdCurrency,
      rate_usd_per_gen: rate,
      carrier,
      provider,
    };
    cache.quotes.set(key, { ts: Date.now(), value });
    cache.outageUntil = 0; // upstream healthy again — clear any cooldown
    return value;
  } catch (err) {
    if (err instanceof TransientError) {
      // Persistent outage detected — cool down so the next attempts skip the
      // upstream and instantly hit the clear message / stale fallback above.
      cache.outageUntil = Date.now() + OUTAGE_COOLDOWN_MS;
    }
    // Provider down but we have a real, previously-fetched price for this
    // route/dates: serve it clearly marked stale instead of a hard failure.
    const stale = cache.quotes.get(key);
    if (stale && now < stale.ts + QUOTE_STALE_MAX_MS) {
      return { ...stale.value, stale: true, stale_age_s: Math.round((now - stale.ts) / 1000) };
    }
    throw err;
  }
}

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "16kb" }));

// Browser clients on another origin (e.g. the deployed frontend / Vite dev)
// must be allowed to call this API. GET-only, so a permissive CORS policy is fine.
app.use((req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Accept");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const quoteLimiter = rateLimit({
  windowMs: 60_000,
  limit: RATE_LIMIT,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) =>
    res.status(429).json({ error: "Rate limit exceeded. Try again shortly." }),
});

function parseRoute(req) {
  const from = String(req.query.from || "").trim().toUpperCase();
  const to = String(req.query.to || "").trim().toUpperCase();
  if (!IATA_RE.test(from) || !IATA_RE.test(to) || from === to) {
    throw new ApiError(400, "route must be two distinct 3-letter IATA codes (e.g. from=JFK&to=LHR)");
  }
  const depart = toIsoDate(req.query.depart, 14);
  const ret = toIsoDate(req.query.ret, 21);
  if (depart >= ret) throw new ApiError(400, "return date must be after departure date");
  return { from, to, depart, ret };
}

function quoteEndpoint(req, res, next) {
  try {
    const { from, to, depart, ret } = parseRoute(req);
    buildQuote(from, to, depart, ret)
      .then((v) => res.json(v))
      .catch(next);
  } catch (err) {
    next(err);
  }
}

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    provider: QUOTE_PROVIDER,
    rapid: { configured: Boolean(RAPID.apiKey) },
    kiwi: { configured: Boolean(KIWI.apiKey) },
    omkar: { configured: Boolean(OMKAR.apiKey) },
    outage: Boolean(cache.outageUntil && Date.now() < cache.outageUntil),
    outage_until_ms: cache.outageUntil || null,
  });
});
app.get("/api/quote", quoteLimiter, quoteEndpoint);
app.get("/quote", quoteLimiter, quoteEndpoint);

// Minimal synthetic completion feed for the contract's confirm_completion /
// escalate non-deterministic blocks, which GET `feed_base + "/status?ref=" +
// booking_id` and ask validators whether the trip completed. There is no live
// completion source integrated yet, so return a stable, deterministic body
// that every validator reads identically (owner-gated on-chain anyway).
app.get("/status", (req, res) => {
  res.json({ ref: String(req.query.ref || "").trim(), status: "ok" });
});

app.use((err, _req, res, _next) => {
  const status = err instanceof ApiError ? err.status : 500;
  if (status >= 500) console.error("[quote-server]", err.message);
  res.status(status).json({ error: err.message || "internal error" });
});

app.listen(PORT, () => {
  console.log(`[quote-server] listening on :${PORT} (provider=${QUOTE_PROVIDER}, host=${ACTIVE.host})`);
});