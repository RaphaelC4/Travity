/**
 * Travity -> GenLayer client.
 *
 * Talks to the deployed TravelAgent Intelligent Contract through genlayer-js.
 * All changes are signed by the connected wallet; reads come straight from
 * the contract.
 *
 * Amounts are GEN denominated in wei (1 GEN = 10^18 wei) end to end. The UI
 * renders human-readable GEN via `fmtGen`.
 *
 * SECURITY NOTES:
 * - Live quotes come from the server-side, rate-limited /api/quote proxy
 *   (flight offers -> GEN), never fabricated client-side and never
 *   from the browser directly to the provider.
 * - Live writes go through the connected wallet (WalletConnect or injected
 *   provider) and are signed by the user, not the server.
 * - All client-supplied values are validated before use and before display;
 *   nothing from the network is injected into the DOM without escaping.
 */

import { createClient } from "genlayer-js";
import { studionet } from "genlayer-js/chains";
import { TransactionStatus } from "genlayer-js/types";
import { CalldataAddress } from "genlayer-js/types";
import { fromHex, getAddress } from "viem";
import { ensureStudionetChain } from "./wallet";

export const WEI_PER_GEN = 10n ** 18n;

/** Render a wei amount as human-readable GEN (1 GEN = 10^18 wei). */
export const fmtGen = (wei) => {
  const v = BigInt(wei ?? 0n);
  const whole = v / WEI_PER_GEN;
  const frac = (v % WEI_PER_GEN).toString().padStart(18, "0").slice(0, 6).replace(/0+$/, "");
  return `${whole}.${frac || "0"} GEN`;
};

/** Render a US-dollar price. */
export const fmtUsd = (usd, currency = "USD") => {
  const n = Number(usd ?? 0);
  const fmt = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
  return currency && currency.toUpperCase() !== "USD" ? `${fmt.format(n)} ${currency}` : fmt.format(n);
};

/** Bookings from this browser, persisted to localStorage so Recent trips
 * survives reloads. Live on-chain status is refreshed per stored id at read
 * time (see bookings()). The contract has no enumerate view, so this mirrors
 * the wallet's own bookings. Bookings are stored per contract address so
 * redeploying (a new address) starts a clean list instead of showing trips
 * from an older deployment that the current contract can never resolve. */
const BOOKINGS_KEY_PREFIX = "travity.bookings.";

const bookingsKey = () =>
  BOOKINGS_KEY_PREFIX + (contractAddress || "none").toLowerCase();

const persistBookings = (list) => {
  try {
    localStorage.setItem(
      bookingsKey(),
      JSON.stringify(list.map((b) => ({ ...b, priceWei: b.priceWei.toString() })))
    );
  } catch {
    /* storage unavailable (private mode / quota) — session-only */
  }
};

const loadBookings = () => {
  try {
    // NOTE: deliberately NO cross-contract migration. Bookings are scoped to
    // one deployed address; pulling trips from an older deployment here made
    // them look actionable when the current contract can never resolve their
    // ids ("unknown booking" revert on confirm_completion/disputes).
    const raw = JSON.parse(localStorage.getItem(bookingsKey()) || "[]");
    if (!Array.isArray(raw)) return [];
    return raw.map((b) => ({
      id: String(b.id || ""),
      onChainId: String(b.onChainId || b.id || ""),
      route: String(b.route || ""),
      depart: Number(b.depart ?? 0),
      ret: Number(b.ret ?? 0),
      priceWei: BigInt(b.priceWei ?? 0n),
      status: String(b.status || "confirmed"),
      completion: Boolean(b.completion),
      reservationRef: b.reservationRef ? String(b.reservationRef) : "",
    }));
  } catch {
    return [];
  }
};

const sessionBookings = [];

/** Last known loyalty balance per account, persisted so the Loyalty page can
 * render instantly and survive brief RPC failures (Studionet rate-limits to
 * 30 reads/min) instead of flashing as if the account had no rewards. */
const BALANCE_KEY = "travity.balance.v1";

const loadBalanceCache = (account) => {
  try {
    if (!account) return null;
    const raw = JSON.parse(localStorage.getItem(BALANCE_KEY) || "{}")[String(account).toLowerCase()] || {};
    const v = raw[contractAddress.toLowerCase()];
    return v != null ? BigInt(v) : null;
  } catch {
    return null;
  }
};

const saveBalanceCache = (account, value) => {
  try {
    if (!account) return;
    const all = JSON.parse(localStorage.getItem(BALANCE_KEY) || "{}");
    const per = all[String(account).toLowerCase()] || {};
    per[contractAddress.toLowerCase()] = value.toString();
    all[String(account).toLowerCase()] = per;
    localStorage.setItem(BALANCE_KEY, JSON.stringify(all));
  } catch {
    /* storage unavailable — session-only */
  }
};

// ---- validation ------------------------------------------------------------

const isValidRoute = (o, d) =>
  typeof o === "string" && /^[A-Za-z]{3}$/.test(o) &&
  typeof d === "string" && /^[A-Za-z]{3}$/.test(d) &&
  o.toUpperCase() !== d.toUpperCase();

const isValidDates = (depart, ret) =>
  Number.isInteger(Number(depart)) && Number.isInteger(Number(ret)) &&
  Number(depart) < Number(ret);

/** A reservation reference is accepted only if it came from the server's
 * /api/reserve (a 4-12 char uppercase PNR like "9K2F7Q"). It anchors the
 * escrow to a real, agency-issued reservation — confirm_completion/escalate
 * later verify it against authenticated /status evidence, so a made-up ref
 * (as would happen if the client generated one) is never treated as proof. */
const isValidRef = (ref) =>
  typeof ref === "string" && /^[A-Z0-9]{4,12}$/.test(ref.trim());

/** Issues a real reservation (PNR) at the quote server, returning the ref
 * the contract will store in `book()`. The ref is the anchor that
 * confirm_completion/escalate later verify against authenticated `/status`
 * evidence — it cannot be made up, it must come from the agency. */
async function createReservation({ origin, destination, depart, ret }) {
  const base = (import.meta.env.VITE_QUOTE_API || "").replace(/\/+$/, "");
  const res = await fetch(`${base}/api/reserve`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      from: String(origin).toUpperCase(),
      to: String(destination).toUpperCase(),
      depart: String(depart),
      ret: String(ret),
    }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || `Reservation failed (${res.status})`);
  return String(j.ref || "").toUpperCase();
}

// ---- live helpers (genlayer-js) ---------------------------------------------

const DEFAULT_RPC = "https://studio.genlayer.com/api";

async function runWrite(client, { functionName, args, value = 0n }) {
  const hash = await client.writeContract({
    address: contractAddress,
    functionName,
    args,
    value,
  });
  await client.waitForTransactionReceipt({
    hash,
    status: TransactionStatus.FINALIZED,
    interval: 2000,
    retries: 90,
  });
  return hash;
}

async function runRead(client, functionName, args) {
  return client.readContract({ address: contractAddress, functionName, args });
}

let contractAddress = "";

// ---- contract adapter ------------------------------------------------------

export class TravityClient {
  constructor({ endpoint = import.meta.env.VITE_GENLAYER_RPC || "", address = "" } = {}) {
    this.live = Boolean(address);
    this.address = address || "";
    this.rpc = endpoint || DEFAULT_RPC;
    contractAddress = this.address;
    sessionBookings.push(...loadBookings());
  }

  readClient() {
    // Always pin the chain: genlayer-js defaults createClient to localnet when
    // only an endpoint is given (id 61127), which would send a wrong chainId in
    // tx params and get rejected by a wallet that is correctly on Studionet.
    const base = import.meta.env.VITE_GENLAYER_RPC
      ? { chain: studionet, endpoint: this.rpc }
      : { chain: studionet };
    return createClient(base);
  }

  async writeClient(account, provider) {
    if (!account || !provider) {
      throw new Error("Connect a wallet before on-chain changes.");
    }
    await ensureStudionetChain(provider);
    const base = import.meta.env.VITE_GENLAYER_RPC
      ? { chain: studionet, endpoint: this.rpc }
      : { chain: studionet };
    return createClient({ ...base, account, provider });
  }

  /** Free read of the contract's cached agreed price for route+dates (null
   * when the contract has no agreement yet). Serves both the on-chain price
   * shown in the UI and the cache check book() uses to skip a write. */
  async agreedQuote(origin, destination, depart = 0, ret = 0) {
    const client = this.readClient();
    const raw = await runRead(client, "view_quote", [origin, destination, Number(depart), Number(ret)]);
    if (!raw || !raw.price_wei) return null;
    return { priceWei: BigInt(raw.price_gwei ?? raw.price_wei) };
  }

  async getQuote(origin, destination, opts = {}) {
    const o = origin.toUpperCase(), d = destination.toUpperCase();
    if (!isValidRoute(o, d)) throw new Error("Route must be two distinct 3-letter IATA codes (e.g. JFK and LHR).");

    // Real /api/quote proxy (flights -> GEN). The provider never fabricates a
    // price: a failed quote is a hard error surfaced to the user.
    const qs = new URLSearchParams({ from: o, to: d });
    if (opts.depart) qs.set("depart", String(opts.depart));
    if (opts.ret) qs.set("ret", String(opts.ret));
    // VITE_QUOTE_API overrides the origin for /api/quote (e.g. the deployed
    // quote server). Empty -> relative, so the Vite dev proxy handles it.
    const base = (import.meta.env.VITE_QUOTE_API || "").replace(/\/+$/, "");
    const url = `${base}/api/quote?${qs}`;
    // One retry for transient server/upstream errors (5xx/429); the server
    // itself already retries the upstream internally.
    let res;
    let j;
    for (let attempt = 0; attempt < 2; attempt++) {
      res = await fetch(url, { headers: { Accept: "application/json" } });
      j = await res.json().catch(() => ({}));
      if (res.ok || (res.status < 500 && res.status !== 429)) break;
      if (attempt === 0) await new Promise((r) => setTimeout(r, 700));
    }
    if (!res.ok) throw new Error(j.error || `Quote failed (${res.status})`);

    // The spendable price is whatever the contract already agreed on-chain
    // (free read). Prefer it so the escrow the user pays exactly matches the
    // on-chain price; without an agreement yet, the fresh server quote applies.
    let onChain = null;
    try {
      onChain = await this.agreedQuote(o, d, Number(opts.depart || 0), Number(opts.ret || 0));
    } catch {
      onChain = null;
    }

    return {
      route: `${o}-${d}`,
      priceWei: BigInt(j.price_wei),
      agreedWei: onChain ? onChain.priceWei : null,
      escrowWei: onChain ? onChain.priceWei : BigInt(j.price_wei),
      agreed: Boolean(onChain),
      currency: j.currency || "GEN",
      carrier: j.carrier || "",
      provider: j.provider || "omkarcloud",
      stale: Boolean(j.stale),
      staleAgeS: j.stale_age_s ?? null,
      usdTotal: j.usd_total != null ? Number(j.usd_total) : null,
      usdCurrency: j.usd_currency || "USD",
    };
  }

  async book({ origin, destination, depart, ret, paymentWei, reservationRef, account, provider }) {
    const o = origin.toUpperCase(), d = destination.toUpperCase();
    const dep = Number(depart), r = Number(ret);
    if (!isValidRoute(o, d)) throw new Error("Invalid route.");
    if (!isValidDates(dep, r)) throw new Error("Return date must be after departure date.");
    const priceWei = BigInt(paymentWei ?? 0n);
    if (priceWei <= 0n) throw new Error("Payment must be greater than zero.");
    // The contract rejects book() without a real, agency-issued reservation
    // ref (server /api/reserve). A made-up/client-generated ref is never
    // accepted as evidence later, so require one here.
    const ref = isValidRef(reservationRef) ? reservationRef.trim().toUpperCase() : "";
    if (!ref) {
      throw new Error("A reservation reference is required. Reserve your seat on the agency first.");
    }

    // Cached on-chain agreement for these exact dates. When present we skip the
    // refresh_quote write entirely: repeat bookings drop to a single write per
    // booking (the gas optimization). Else agree a fresh price first.
    const cached = await this.agreedQuote(o, d, dep, r);
    let agreed = cached ? cached.priceWei : null;

    if (!agreed) {
      // NB: the contract must already agree on a quote (via its own feed)
      // before booking. Surface the real GenVM error so a broken feed/
      // deployment is diagnosable instead of a generic message.
      const client = await this.writeClient(account, provider);
      try {
        await runWrite(client, {
          functionName: "refresh_quote",
          args: [o, d, dep, r],
          value: 0n,
        });
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        if (/chainId should be same/i.test(detail)) {
          throw new Error(
            "Wallet chain mismatch: expected the GenLayer Studio Network " +
              "(chainId 61999 / 0xF22F). Make sure your wallet is on that network " +
              "and retry."
          );
        }
        throw new Error(
          `Could not agree a quote on-chain (contract ${contractAddress}): ${detail}. ` +
            "Is the contract quote feed configured via set_feed_url to a URL validators can reach?"
        );
      }
      const after = await this.agreedQuote(o, d, dep, r);
      agreed = after ? after.priceWei : null;
      if (!agreed) throw new Error("On-chain quote agreement returned no price. Try again.");
    }

    const bookValue = agreed > 0n ? agreed : priceWei;
    const client = await this.writeClient(account, provider);
    await runWrite(client, {
      functionName: "book",
      args: [o, d, dep, r, ref],
      value: bookValue,
    });
    // The contract stores bookings under `_quote_key + "-" + str(sender)`
    // (travel_agent.py book()): "ORIG-DEST-depart-ret-0x<lowercase sender>".
    // writeContract returns only the tx hash, so rebuild the id exactly and
    // confirm it exists via the free view_booking read.
    const onChainId = await this.recallBookingId(o, d, dep, r, account);
    const id = onChainId;
    sessionBookings.push({
      id, route: `${o}-${d}`, depart: dep, ret: r,
      priceWei: bookValue, status: "confirmed", completion: false, onChainId,
      reservationRef: ref,
    });
    persistBookings(sessionBookings);
    return { id, onChainId, agreedWei: bookValue, reservationRef: ref };
  }

  /** Rebuilds the contract's booking_id for (route, dates, sender) and confirms
   * it via view_booking. The contract stores the sender with `str(Address)`,
   * which GenVM renders as an EIP-55 checksummed address — so checksum the
   * wallet account exactly. Lowercase is kept as a legacy fallback. */
  async recallBookingId(origin, destination, depart, ret, account) {
    const base = `${origin}-${destination}-${Number(depart)}-${Number(ret)}-`;
    let checksummed = String(account);
    try {
      checksummed = getAddress(String(account));
    } catch {
      /* fall through with the raw account string */
    }
    const client = this.readClient();
    const candidates = [
      base + checksummed,
      base + checksummed.toLowerCase(),
      base + String(account),
    ];
    for (const candidate of candidates) {
      const raw = await runRead(client, "view_booking", [candidate]);
      if (raw && Object.keys(raw).length > 0) return candidate;
    }
    throw new Error(
      "Booking write succeeded but the on-chain booking id could not be resolved from view_booking. " +
        "This is a client/contract id mismatch — report the route, dates and address used."
    );
  }

  /** Owner-only (set_feed_url). Repoints the on-chain quote feed root to the
   * Public HTTPS URL GenLayer validators will fetch (/quote + /status). The
   * value normally comes from VITE_QUOTE_API. Reverts with `only owner` if the
   * connected wallet is not the contract owner. */
  async setFeedUrl(url, account, provider) {
    const clean = String(url || "").trim().replace(/\/+$/, "");
    if (!/^https:\/\/[^/]+/.test(clean)) {
      throw new Error("Feed URL must be a public https:// URL (e.g. https://host.example).");
    }
    if (/localhost|127\.0\.0\.1|0\.0\.0\.0/i.test(clean)) {
      throw new Error("Feed URL must be reachable by GenLayer validators (no localhost/127.0.0.1).");
    }
    const client = await this.writeClient(account, provider);
    await runWrite(client, { functionName: "set_feed_url", args: [clean], value: 0n });
    return clean;
  }

  /** Issues a real reservation (PNR) at the quote server. The returned ref is
   * required by book() and is later verified against authenticated /status
   * evidence by confirm_completion/escalate. This is the "tied to a real
   * reservation" anchor — a made-up ref is never accepted as evidence. */
  async createReservation({ origin, destination, depart, ret }) {
    return createReservation({ origin, destination, depart, ret });
  }

  /** Owner-only (set_provider). The carrier/agency settlement payout
   * address — receives the escrowed fare on verified completion, or the
   * non-refunded remainder after a dispute ruling. Reverts with
   * `only owner` if the connected wallet is not the contract owner. */
  async setProvider(address, account, provider) {
    const clean = String(address || "").trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(clean)) {
      throw new Error("Provider address must be a 0x-prefixed 20-byte address.");
    }
    const client = await this.writeClient(account, provider);
    // Address args must be encoded as raw 20 bytes (CalldataAddress) — see
    // balance(). A plain "0x…" string is serialized as a string and the
    // contract's Address parameter decode fails on the storage setter.
    let who;
    try {
      who = new CalldataAddress(fromHex(clean, "bytes"));
    } catch {
      who = clean;
    }
    await runWrite(client, { functionName: "set_provider", args: [who], value: 0n });
    return clean;
  }

  /** Owner-only (set_provider_auth). Bearer token sent on every
   * confirm_completion/escalate provider read so evidence is authenticated,
   * not a public/spoofable fetch. NOTE: this is stored on-chain in
   * plaintext (see docs/security.md) — treat it as a low-privilege,
   * rotatable, status-read-only token, never a secret you couldn't afford
   * to have public. Never put this in a VITE_ env var: anything with that
   * prefix is bundled into the public JS at build time. */
  async setProviderAuth(token, account, provider) {
    const clean = String(token || "").trim();
    if (clean.length < 8) {
      throw new Error("Provider auth token must be at least 8 characters.");
    }
    const client = await this.writeClient(account, provider);
    await runWrite(client, { functionName: "set_provider_auth", args: [clean], value: 0n });
    return true;
  }

  /** Forces the contract to re-fetch and re-agree a live price for a
   * route+dates (public write, but owner panel only). Use after the feed or
   * price source changed so a stale on-chain agreement (e.g. one agreed at an
   * outdated GEN/USD rate) is overwritten instead of continuing to drive the
   * escrow the frontend pays. Returns the newly agreed price in wei. */
  async refreshQuote(origin, destination, depart, ret, account, provider) {
    const o = String(origin || "").toUpperCase();
    const d = String(destination || "").toUpperCase();
    const dep = Number(depart), r = Number(ret);
    if (!isValidRoute(o, d)) throw new Error("Route must be two distinct 3-letter IATA codes.");
    if (!isValidDates(dep, r)) throw new Error("Return date must be after departure date and both must be YYYYMMDD.");
    const client = await this.writeClient(account, provider);
    await runWrite(client, {
      functionName: "refresh_quote",
      args: [o, d, dep, r],
      value: 0n,
    });
    const agreed = await this.agreedQuote(o, d, dep, r);
    return agreed ? agreed.priceWei : null;
  }

  async confirmCompletion(bookingId, account, provider) {
    // Pre-flight: a booking id from an older deployment (or a typo) reverts
    // on-chain with "unknown booking" and burns gas. Fail here, for free,
    // with an actionable message instead.
    const client = await this.writeClient(account, provider);
    const existing = await runRead(client, "view_booking", [bookingId]);
    if (!existing || Object.keys(existing).length === 0) {
      throw new Error(
        "This booking does not exist on the current contract — it was made on a previous deployment. Book again on this contract, then confirm."
      );
    }
    await runWrite(client, { functionName: "confirm_completion", args: [bookingId], value: 0n });
    const b = sessionBookings.find((x) => x.id === bookingId);
    if (b) { b.status = "completed"; b.completion = true; persistBookings(sessionBookings); }
    return "completed";
  }

  async fileDispute(bookingId, reason, account, provider) {
    if (typeof reason !== "string" || reason.length < 10 || reason.length > 500) {
      throw new Error("Dispute reason must be 10-500 characters.");
    }
    const client = await this.writeClient(account, provider);
    await runWrite(client, { functionName: "file_dispute", args: [bookingId, reason], value: 0n });
    const b = sessionBookings.find((x) => x.id === bookingId);
    if (b) { b.status = "disputed"; persistBookings(sessionBookings); }
    // The contract keys disputes under `booking_id + "-" + str(sender)`, and
    // writes only return the tx hash, so rebuild the id with the EIP-55 form
    // (str(Address) on GenVM) and confirm via the free view_dispute read.
    return this.recallDisputeId(bookingId, account);
  }

  /** Rebuilds the contract's dispute_id for (booking, sender) and confirms it
   * via view_dispute. Same EIP-55 rules as recallBookingId. */
  async recallDisputeId(bookingId, account) {
    let checksummed = String(account);
    try {
      checksummed = getAddress(String(account));
    } catch {
      /* fall through with the raw account string */
    }
    const client = this.readClient();
    const candidates = [
      `${bookingId}-${checksummed}`,
      `${bookingId}-${checksummed.toLowerCase()}`,
      `${bookingId}-${String(account)}`,
    ];
    for (const candidate of candidates) {
      const raw = await runRead(client, "view_dispute", [candidate]);
      if (raw && Object.keys(raw).length > 0) return candidate;
    }
    throw new Error(
      "Dispute write succeeded but the on-chain dispute id could not be resolved from view_dispute. " +
        "This is a client/contract id mismatch — report the booking reference and address used."
    );
  }

  async escalate(disputeId, floorHint = 0n, account, provider) {
    const client = await this.writeClient(account, provider);
    await runWrite(client, { functionName: "escalate", args: [disputeId, BigInt(floorHint ?? 0n)], value: 0n });
    const d = await runRead(client, "view_dispute", [disputeId]);
    return { id: disputeId, status: d.status, rounds: Number(d.rounds), refund: BigInt(d.refund_gwei ?? d.refund_wei ?? 0n) };
  }

  async balance(account) {
    if (!account) return 0n;
    const client = this.readClient();
    // Address args must be encoded as raw 20 bytes (CalldataAddress) — passing
    // a plain "0x…" string makes genlayer-js serialize it as a string and the
    // contract's Address parameter read fails ("Missing or invalid parameters").
    let who;
    try {
      who = new CalldataAddress(fromHex(String(account), "bytes"));
    } catch {
      who = account;
    }
    const raw = await runRead(client, "balance_of", [who]);
    const value = BigInt(raw ?? 0n);
    saveBalanceCache(account, value);
    return value;
  }

  cachedBalance(account) {
    return loadBalanceCache(account);
  }

  async bookings() {
    // Refresh live on-chain status for each stored booking so Recent trips
    // reflects confirmations even after a reload. A successful lookup that
    // returns an empty record means the id belongs to a different contract
    // deployment (redeploy keeps a new address), so drop it rather than show a
    // trip the current contract can never resolve. Failed lookups (RPC) keep
    // stored state so a transient error doesn't wipe the list.
    const client = this.readClient();
    const refreshed = await Promise.all(
      sessionBookings.map(async (b) => {
        try {
          const raw = await runRead(client, "view_booking", [b.onChainId || b.id]);
          if (!raw || Object.keys(raw).length === 0) {
            const idx = sessionBookings.indexOf(b);
            if (idx !== -1) sessionBookings.splice(idx, 1);
            persistBookings(sessionBookings);
            return null;
          }
          if (raw && ("status" in raw) && raw.status !== String(b.status)) {
            b.status = String(raw.status);
            b.completion = Boolean(raw.completion_verified);
            persistBookings(sessionBookings);
          }
        } catch {
          /* keep stored state */
        }
        return b;
      })
    );
    return refreshed.filter(Boolean);
  }

  async disputes() {
    return [];
  }
}

export const client = new TravityClient({
  address: import.meta.env.VITE_GENLAYER_CONTRACT_ADDRESS ?? "",
  endpoint: import.meta.env.VITE_GENLAYER_RPC ?? "",
});
