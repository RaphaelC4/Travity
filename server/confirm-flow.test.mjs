#!/usr/bin/env node
// Integration test for the live-booking pipeline with every real dependency
// replaced by an in-process fake:
//   - child quote server (the real server/index.js on an ephemeral port)
//   - fake booking-provider (offer-hold / confirm / cancel / order-status)
//   - fake GenLayer JSON-RPC speaking the REAL genlayer-js calldata codec
// Covers: reserve -> confirm-purchase happy path (exactly one provider charge,
// cached idempotent re-confirm), every fail-closed confirm branch (RPC down,
// unknown booking, wrong offer, expired hold, no escrow, provider 500 with
// retry), airline phone rejection fixed in place (422 invalid_phone ->
// corrected contact_phone on the same escrow, no second hold/charge), and the
// reaper's trust boundary: an orphan order backed by an
// on-chain-confirmed booking is kept and reconciled, never cancelled; failed
// chain reads are fail-closed; cancels are idempotent.
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { toHex, fromRlp } from "viem";

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
const GL = await import("genlayer-js"); // real codec — fake RPC speaks the same wire format
const PII = {
  given_name: "Ada", family_name: "Lovelace", born_on: "1990-12-10",
  gender: "F", title: "MS", email: "ada@example.com", phone_number: "+2348012345678",
};
const OPS = "op-secret-test";
const PNR_SECRET = "pnr-secret-test";
const PROV_KEY = "prov-key-test";
const CONTRACT = "0x" + "42".repeat(20);
const WEI = "120000000000000000";

let failures = 0;
function ck(cond, msg) {
  if (cond) console.log(`  ok    ${msg}`);
  else { failures++; console.error(`  FAIL  ${msg}`); }
}
function jerr(e) { return String((e && e.message) || e); }
async function req(method, url, body, headers = {}) {
  const r = await fetch(url, {
    method,
    headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, j };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// ---------- fake booking-provider ----------
const prov = { offerHold: [], confirm: [], cancel: [], orders: new Map(), mode: { failConfirm: false } };
let provSeq = 0;
const provSrv = http.createServer((rq, rs) => {
  let b = ""; rq.on("data", (c) => (b += c));
  rq.on("end", () => {
    const url = new URL(rq.url, "http://x");
    const p = url.pathname;
    const reply = (status, obj) => { rs.writeHead(status, { "Content-Type": "application/json" }); rs.end(JSON.stringify(obj)); };
    if (p === "/__mode") {
      const m = JSON.parse(b || "{}");
      if ("failConfirm" in m) prov.mode.failConfirm = Boolean(m.failConfirm);
      if ("failPhone" in m) prov.mode.failPhone = Number(m.failPhone) || 0;
      return reply(200, { ok: true, mode: prov.mode });
    }
    if (String(rq.headers.authorization || "") !== `Bearer ${PROV_KEY}`) return reply(401, { error: "unauthorized" });
    if (p === "/fake/health") return reply(200, { ok: true, service: "fake-provider" });
    if (p === "/fake/offer-hold") {
      prov.offerHold.push(b);
      const n = ++provSeq;
      return reply(200, {
        offerId: `off${n}ABCD`, passengerId: `pas${n}`,
        itineraryJson: JSON.stringify({ slices: [{ origin: "LOS", destination: "JFK" }] }),
        totalAmount: "120.00", totalCurrency: "USD",
      });
    }
    if (p === "/fake/confirm") {
      prov.confirm.push(b);
      if (prov.mode.failPhone > 0) {
        prov.mode.failPhone--;
        return reply(422, { error: "Duffel create order 422 (phone_number): Invalid phone number", code: "invalid_phone" });
      }
      if (prov.mode.failConfirm) return reply(502, { error: "duffel upstream exploded" });
      const n = ++provSeq;
      const id = `ord_${n}`;
      prov.orders.set(id, { status: "pending" });
      return reply(200, { duffelOrderId: id, locator: `TPNR${n}X`, refundPolicy: { refundable: "non_refundable", penalty: null } });
    }
    if (p === "/fake/cancel") {
      prov.cancel.push(b);
      const orderId = String(JSON.parse(b || "{}").orderId || "");
      const o = prov.orders.get(orderId);
      if (!o) return reply(404, { error: "unknown order" });
      if (o.status === "cancelled") return reply(422, { error: "order has already been cancelled" });
      o.status = "cancelled";
      return reply(200, { cancelled: true });
    }
    if (p === "/fake/order-status") {
      const orderId = url.searchParams.get("orderId") || "";
      const o = prov.orders.get(orderId);
      if (!o) return reply(200, { id: orderId, status: "unknown" });
      // Mirrors the booking-provider /order-status shape: a live Duffel
      // lookup always tags itself duffel-live and carries the fare's
      // refund policy. A "pending" status is a merely-confirmed order —
      // exactly what /provider-status must NOT promote or label.
      return reply(200, { id: orderId, status: o.status, source: "duffel-live", refundPolicy: { refundable: "non_refundable", penalty: null } });
    }
    return reply(404, { error: `fake provider: no route ${p}` });
  });
});

// ---------- fake GenLayer JSON-RPC ----------
// Chain state the test mutates directly (mirrors what finalized consensus
// would return from view_booking once the wallet's transactions seal).
const chain = new Map(); // bookingId -> record
let rpcFail = false;
let rpcSeq = 0;
function normId(v) {
  if (v instanceof Uint8Array) {
    const s = Buffer.from(v).toString("utf8");
    if (chain.has(s)) return s;
    return toHex(v);
  }
  return String(v ?? "");
}
const rpcSrv = http.createServer((rq, rs) => {
  let b = ""; rq.on("data", (c) => (b += c));
  rq.on("end", () => {
    const url = new URL(rq.url, "http://x");
    const reply = (status, obj) => { rs.writeHead(status, { "Content-Type": "application/json" }); rs.end(JSON.stringify(obj)); };
    if (url.pathname === "/__control") {
      const m = JSON.parse(b || "{}");
      if ("rpcFail" in m) rpcFail = Boolean(m.rpcFail);
      return reply(200, { ok: true, rpcFail });
    }
    let parsed;
    try { parsed = JSON.parse(b); } catch { return reply(400, { error: "bad json" }); }
    const batch = Array.isArray(parsed) ? parsed : [parsed];
    const out = batch.map((call) => {
      const id = call && call.id !== undefined ? call.id : ++rpcSeq;
      const wrap = (obj) => ({ jsonrpc: "2.0", id, ...(obj.error ? { error: obj.error } : { result: obj.result }) });
      if (rpcFail) return wrap({ error: { code: -32000, message: "fake rpc down" } });
      try {
        // gen_call params: [{ type, to, from, data: "0x…", transaction_hash_variant }]
        const p0 = Array.isArray(call.params) ? call.params[0] : call.params;
        const cd = p0 && typeof p0 === "object" ? String(p0.data || "") : "";
        if (!/^0x[0-9a-fA-F]+$/.test(cd)) throw new Error("no calldata in params");
        // genlayer-js sends serialize([calldata, leaderOnly]) = RLP list of hex
        // strings; unwrap the container, then decode the inner calldata blob.
        const container = fromRlp(cd, "hex");
        const inner = Array.isArray(container) ? container[0] : container;
        const m = GL.abi.calldata.decode(Buffer.from(String(inner).slice(2), "hex"));
        const fn = String(m.get("method") || m.get("fn") || "");
        if (fn === "view_booking") {
          const argsRaw = m.get("args");
          const first = Array.isArray(argsRaw) ? argsRaw[0] : argsRaw instanceof Map ? (argsRaw.get(0) ?? [...argsRaw.values()][0]) : argsRaw;
          const idArg = normId(first);
          const rec = chain.get(idArg);
          const payload = rec && Object.keys(rec).length ? { ...rec } : {};
          // The SDK prepends "0x" to the result — return bare hex.
          return wrap({ result: toHex(GL.abi.calldata.encode(payload)).slice(2) });
        }
        return wrap({ error: { code: -32601, message: `fake rpc: fn ${fn} not served` } });
      } catch (e) {
        return wrap({ error: { code: -32000, message: jerr(e) } });
      }
    });
    reply(200, Array.isArray(parsed) ? out : out[0]);
  });
});
// ---------- bootstrap ----------
const listen = (srv) => new Promise((res) => srv.listen(0, "127.0.0.1", res));
await listen(provSrv);
await listen(rpcSrv);
const PROV_PORT = provSrv.address().port;
const RPC_PORT = rpcSrv.address().port;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "travity-test-"));
const RES_FILE = path.join(DATA_DIR, "reservations.json");
// Pre-seed an aged, never-purchased hold so the reaper's expired list has a
// candidate from boot (the file format is the flat {ref: record} object).
fs.writeFileSync(RES_FILE, JSON.stringify({
  SEEDOLD: {
    ref: "SEEDOLD", route: "LOS-JFK", depart: "2026-09-15", ret: "2026-09-22",
    status: "offer_held", offerId: "offseed0001", providerOrderId: null,
    bookingId: null, createdAt: Date.now() - 2 * 3600_000, updatedAt: Date.now() - 2 * 3600_000,
  },
}), "utf8");
const PORT = 3000 + Math.floor(Math.random() * 2000);
const BASE = `http://127.0.0.1:${PORT}`;
const child = spawn(process.execPath, ["index.js"], {
  cwd: SERVER_DIR,
  env: {
    ...process.env, PORT: String(PORT), NODE_ENV: "test",
    OPERATOR_SECRET: OPS, PNR_SECRET, GENLAYER_RPC: `http://127.0.0.1:${RPC_PORT}`,
    GENLAYER_CONTRACT_ADDRESS: CONTRACT,
    BOOKING_PROVIDER_URL: `http://127.0.0.1:${PROV_PORT}/fake`,
    BOOKING_PROVIDER_API_KEY: PROV_KEY,
    RESERVE_RATE_LIMIT: "1000", STATUS_RATE_LIMIT: "1000", REAPER_MIN_AGE_MS: "0",
    RESERVATIONS_FILE: RES_FILE,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let childErr = "";
child.stdout.on("data", (d) => (childErr += d));
child.stderr.on("data", (d) => (childErr += d));
const opHeaders = { Authorization: `Bearer ${OPS}` };
let up = false;
for (let i = 0; i < 100 && !up; i++) {
  await sleep(150);
  up = await fetch(`${BASE}/health`).then((r) => r.ok).catch(() => false);
}
function bid(n) { return `LOS-JFK-0x${"1".repeat(38)}${String(n).padStart(2, "0")}`; }
function seedChain(n, over = {}) {
  chain.set(bid(n), {
    status: "held", hold_expiry: Math.floor(Date.now() / 1000) + 3600,
    price_wei: WEI, paid_wei: WEI, customer: `0x${"a".repeat(39)}${n}`,
    offer_id: `off_seed_${n}`, passenger_id: `pas_seed_${n}`, ...over,
  });
}
function readRecs() { return JSON.parse(fs.readFileSync(RES_FILE, "utf8")); }

console.log("== reserve =="); {
  const r = await req("POST", `${BASE}/api/reserve`, { from: "LOS", to: "JFK", depart: "20260915", ret: "20260922", passenger: PII });
  ck(r.status === 201 && /^HOLD-[A-Z0-9]{4,12}$/.test(r.j.ref || ""), `reserve issues a HOLD- ref (${r.status} ${JSON.stringify(r.j).slice(0, 120)})`);
  ck(r.j.offerId === "off1ABCD" && prov.offerHold.length === 1, "reserve hits the provider hold exactly once");
  const bad = await req("POST", `${BASE}/api/reserve`, { from: "LOS", to: "JFK", depart: "20260915", ret: "20260922", passenger: { ...PII, phone_number: "08012345678" } });
  ck(bad.status === 400 && /passenger\.phone_number/.test(bad.j.error || ""), "invalid phone rejected before any provider call");
  ck(prov.offerHold.length === 1, "no provider hold was burned by the invalid request");
}
console.log("== confirm-purchase: happy path + idempotency =="); {
  seedChain(1, { offer_id: "off1ABCD", passenger_id: "pas1" });
  const offer1 = "off1ABCD";
  const c = await req("POST", `${BASE}/api/confirm-purchase`, { bookingId: bid(1), offerId: offer1 }, opHeaders);
  ck(c.status === 200 && c.j.duffelOrderId === "ord_2" && c.j.locator === "TPNR2X", `confirm purchases the held offer (${c.status} ${JSON.stringify(c.j).slice(0, 140)})`);
  ck(prov.confirm.length === 1, "exactly one provider charge for the first confirm");
  const rec = Object.values(readRecs()).find((v) => v.providerOrderId === "ord_2");
  ck(rec && rec.status === "confirmed" && rec.bookingId === bid(1), "record persisted with order id, confirmed status and booking link");
  const again = await req("POST", `${BASE}/api/confirm-purchase`, { bookingId: bid(1), offerId: offer1 }, opHeaders);
  ck(again.status === 200 && again.j.cached === true && prov.confirm.length === 1, "re-confirm returns the cached receipt without a second charge");
}
console.log("== confirm-purchase: fail-closed branches =="); {
  await req("POST", `http://127.0.0.1:${RPC_PORT}/__control`, { rpcFail: true });
  const r2 = await req("POST", `${BASE}/api/reserve`, { from: "LOS", to: "JFK", depart: "20260915", ret: "20260922", passenger: PII });
  ck(r2.status === 201 && r2.j.offerId === "off3ABCD", "second reserve works (offer off3ABCD)");
  const f = await req("POST", `${BASE}/api/confirm-purchase`, { bookingId: bid(2), offerId: "off3ABCD" }, opHeaders);
  ck(f.status === 502 && /chain verification unavailable/.test(f.j.error || ""), `RPC failure -> 502 fail-closed (${f.status} ${f.j.error})`);
  ck(prov.confirm.length === 1, "no provider charge when chain verification fails");
  await req("POST", `http://127.0.0.1:${RPC_PORT}/__control`, { rpcFail: false });
  seedChain(2, { offer_id: "off3ABCD" });
  const ok = await req("POST", `${BASE}/api/confirm-purchase`, { bookingId: bid(2), offerId: "off3ABCD" }, opHeaders);
  ck(ok.status === 200 && ok.j.duffelOrderId === "ord_4", `retry after RPC recovery succeeds (${ok.status})`);
  ck(prov.confirm.length === 2, "one new charge after recovery, none wasted");
  const nf = await req("POST", `${BASE}/api/confirm-purchase`, { bookingId: bid(99), offerId: "off3ABCD" }, opHeaders);
  ck(nf.status === 404 && /not found in finalized/.test(nf.j.error || ""), "unknown booking -> 404");
  seedChain(3, { offer_id: "offOTHER" });
  const wo = await req("POST", `${BASE}/api/confirm-purchase`, { bookingId: bid(3), offerId: "off3ABCD" }, opHeaders);
  ck(wo.status === 409 && /offer does not match/.test(wo.j.error || ""), "offer mismatch -> 409");
  seedChain(4, { hold_expiry: Math.floor(Date.now() / 1000) - 10 });
  const ex = await req("POST", `${BASE}/api/confirm-purchase`, { bookingId: bid(4), offerId: "off_seed_4" }, opHeaders);
  ck(ex.status === 410 && /hold expired/.test(ex.j.error || ""), "expired hold on chain -> 410");
  seedChain(5, { paid_wei: "0" });
  const ne = await req("POST", `${BASE}/api/confirm-purchase`, { bookingId: bid(5), offerId: "off_seed_5" }, opHeaders);
  ck(ne.status === 409 && /no locked escrow/.test(ne.j.error || ""), "no escrow -> 409");
}
console.log("== confirm-purchase: provider failure keeps the offer retryable =="); {
  const r3 = await req("POST", `${BASE}/api/reserve`, { from: "LOS", to: "JFK", depart: "20260915", ret: "20260922", passenger: PII });
  ck(r3.status === 201 && r3.j.offerId === "off5ABCD", "third reserve (offer off5ABCD)");
  await req("POST", `http://127.0.0.1:${PROV_PORT}/__mode`, { failConfirm: true });
  seedChain(6, { offer_id: "off5ABCD" });
  const f = await req("POST", `${BASE}/api/confirm-purchase`, { bookingId: bid(6), offerId: "off5ABCD" }, opHeaders);
  ck(f.status === 502 && /Duffel purchase failed/.test(f.j.error || ""), `provider 500 -> 502 verbatim (${f.status} ${f.j.error})`);
  const recAfterFail = Object.values(readRecs()).find((v) => v.offerId === "off5ABCD");
  ck(recAfterFail && !recAfterFail.providerOrderId && recAfterFail.status === "offer_held", "failed confirm leaves the hold untouched and retryable");
  await req("POST", `http://127.0.0.1:${PROV_PORT}/__mode`, { failConfirm: false });
  const ok = await req("POST", `${BASE}/api/confirm-purchase`, { bookingId: bid(6), offerId: "off5ABCD" }, opHeaders);
  ck(ok.status === 200 && ok.j.duffelOrderId, `same offer confirms after provider recovers (${ok.status})`);
}
console.log("== confirm-purchase: airline phone rejection is fixable on the same escrow =="); {
  const r4 = await req("POST", `${BASE}/api/reserve`, { from: "LOS", to: "JFK", depart: "20260915", ret: "20260922", passenger: PII });
  const offerR = String(r4.j.offerId || "");
  const seqN = parseInt(offerR.replace(/^off/, "").replace(/ABCD$/, ""), 10);
  ck(r4.status === 201 && !Number.isNaN(seqN), `reserve for phone-retry flow (${r4.status} ${offerR})`);
  seedChain(seqN, { offer_id: offerR });
  const confirmsBefore = prov.confirm.length;
  const holdsBefore = prov.offerHold.length;
  await req("POST", `http://127.0.0.1:${PROV_PORT}/__mode`, { failPhone: 2 });
  // (1) Duffel rejects the airline-side phone -> structured 422, escrow untouched
  const p1 = await req("POST", `${BASE}/api/confirm-purchase`, { bookingId: bid(seqN), offerId: offerR }, opHeaders);
  ck(p1.status === 422 && p1.j.code === "invalid_phone" && /corrected contact_phone/i.test(p1.j.error || ""), `airline phone rejection -> 422 invalid_phone with fix guidance (${p1.status} ${JSON.stringify(p1.j).slice(0, 120)})`);
  ck(prov.confirm.length === confirmsBefore + 1, "exactly one provider attempt for the rejected confirm");
  const rec1 = Object.values(readRecs()).find((v) => v.offerId === offerR);
  ck(rec1 && !rec1.providerOrderId && rec1.status === "offer_held", "rejected confirm leaves the hold unconfirmed and retryable");
  // (2) Blind retry (same stored phone) hits the airline again — still fixable, no new hold
  const p2 = await req("POST", `${BASE}/api/confirm-purchase`, { bookingId: bid(seqN), offerId: offerR }, opHeaders);
  ck(p2.status === 422 && p2.j.code === "invalid_phone", `retry with unchanged phone fails the same way (${p2.status})`);
  ck(prov.offerHold.length === holdsBefore, "no new offer hold was created by the retries (same escrow)");
  // (3) Malformed corrected phone is caught by OUR validator before the provider
  const beforeBad = prov.confirm.length;
  const badFix = await req("POST", `${BASE}/api/confirm-purchase`, { bookingId: bid(seqN), offerId: offerR, contact_phone: "08012345678" }, opHeaders);
  ck(badFix.status === 422 && badFix.j.code === "invalid_phone" && /international format/i.test(badFix.j.error || ""), `malformed correction rejected locally (${badFix.status} ${badFix.j.error})`);
  ck(prov.confirm.length === beforeBad, "malformed correction never reached the provider");
  // (4) Corrected phone: validated, persisted, order created on the SAME escrow
  await req("POST", `http://127.0.0.1:${PROV_PORT}/__mode`, { failPhone: 0 });
  const p3 = await req("POST", `${BASE}/api/confirm-purchase`, { bookingId: bid(seqN), offerId: offerR, contact_phone: "+12125550123" }, opHeaders);
  ck(p3.status === 200 && /^ord_/.test(p3.j.duffelOrderId || ""), `corrected phone completes the purchase (${p3.status} ${p3.j.duffelOrderId})`);
  const lastConfirmBody = JSON.parse(prov.confirm[prov.confirm.length - 1] || "{}");
  ck(lastConfirmBody.passenger?.phone_number === "+12125550123", "provider received the corrected E.164 phone");
  ck(prov.offerHold.length === holdsBefore, "no second escrow: same hold purchased");
  const rec2 = Object.values(readRecs()).find((v) => v.offerId === offerR);
  ck(rec2 && rec2.status === "confirmed" && rec2.providerOrderId === p3.j.duffelOrderId && rec2.bookingId === bid(seqN), "record confirmed on the corrected phone");
  ck(rec2.passengerPII?.phone_number === "+12125550123", "corrected phone persisted on the held record");
  // (5) Idempotent after recovery
  const p4 = await req("POST", `${BASE}/api/confirm-purchase`, { bookingId: bid(seqN), offerId: offerR, contact_phone: "+12125550123" }, opHeaders);
  ck(p4.status === 200 && p4.j.cached === true, "re-confirm after fix returns the cached receipt");
}
console.log("== confirm-purchase: auth + unheld guards (review) =="); {
  const r = await req("POST", `${BASE}/api/reserve`, { from: "LOS", to: "JFK", depart: "20260915", ret: "20260922", passenger: PII });
  const noAuth = await req("POST", `${BASE}/api/confirm-purchase`, { bookingId: bid(9), offerId: r.j.offerId });
  ck(noAuth.status === 401, `unauthenticated purchase -> 401 (no operator token, no wallet signature) (${noAuth.status})`);
  seedChain(9, { status: "created", offer_id: r.j.offerId }); // escrow not locked yet
  const before = prov.confirm.length;
  const unheld = await req("POST", `${BASE}/api/confirm-purchase`, { bookingId: bid(9), offerId: r.j.offerId }, opHeaders);
  ck(unheld.status === 409 && /not held/.test(unheld.j.error || ""), `booking not yet held on chain -> 409 (${unheld.status} ${unheld.j.error})`);
  ck(prov.confirm.length === before, "no provider charge for the rejected attempts");
}
console.log("== reaper: auth, dry-run, expired holds =="); {
  await sleep(25);
  const noAuth = await req("POST", `${BASE}/api/reaper`, {});
  ck(noAuth.status === 401, "reaper without operator token -> 401");
  const dry = await req("POST", `${BASE}/api/reaper`, {}, opHeaders);
  ck(dry.status === 200 && dry.j.cancelled === undefined, "dry run performs no cancels");
  ck(Array.isArray(dry.j.expired) && dry.j.expired.some((e) => e.ref === "SEEDOLD"), "aged never-purchased hold listed as expired");
  const knownActive = ["ord_2", "ord_4", "ord_6"].every((id) => dry.j.orphans.some((o) => o.orderId === id && /hold still active/.test(o.reason || "")));
  ck(knownActive && dry.j.orphans.every((o) => /hold still active/.test(o.reason || "")), "fresh orders with active chain holds are skipped, not cancelled");
  ck(prov.cancel.length === 0, "dry run made no provider cancel calls");
}
console.log("== reaper: confirmed booking keeps its paid order (regression) =="); {
  chain.set(bid(1), { ...chain.get(bid(1)), status: "confirmed" });
  const dry = await req("POST", `${BASE}/api/reaper`, {}, opHeaders);
  const e = dry.j.orphans.find((o) => o.orderId === "ord_2");
  ck(e && e.action === "already-confirmed", "orphan backed by a confirmed chain booking is marked already-confirmed");
  const run = await req("POST", `${BASE}/api/reaper`, { execute: true }, opHeaders);
  ck(run.j.cancelled.length === 0 && prov.cancel.length === 0, "confirmed booking's order was NOT cancelled");
  ck(prov.orders.get("ord_2").status === "pending", "order ord_2 still live at the provider");
  const rec = Object.values(readRecs()).find((v) => v.providerOrderId === "ord_2");
  ck(rec && rec.reconciled === true, "record reconciled after chain said confirmed");
}
console.log("== reaper: idempotent cancel (already-cancelled order) =="); {
  chain.set(bid(2), { ...chain.get(bid(2)), status: "cancelled" });
  await req("POST", `http://127.0.0.1:${PROV_PORT}/fake/cancel`, { orderId: "ord_4" }, { Authorization: `Bearer ${PROV_KEY}` });
  ck(prov.cancel.length === 1, "manual pre-cancel of ord_4 registered");
  const run = await req("POST", `${BASE}/api/reaper`, { execute: true }, opHeaders);
  const e = run.j.orphans.find((o) => o.orderId === "ord_4");
  ck(e && e.cancelled === true && e.alreadyCancelled === true, "already-cancelled order reconciles without a second cancel call");
  ck(prov.cancel.length === 1, "no duplicate provider cancel was sent");
  const rec = Object.values(readRecs()).find((v) => v.providerOrderId === "ord_4");
  ck(rec && rec.reconciled === true && rec.status === "cancelled", "record marked cancelled + reconciled");
}
console.log("== reaper: cancels unsealable orders (chain says cancelled) =="); {
  chain.set(bid(6), { ...chain.get(bid(6)), status: "cancelled" });
  const run = await req("POST", `${BASE}/api/reaper`, { execute: true }, opHeaders);
  const e = run.j.orphans.find((o) => o.orderId === "ord_6");
  ck(e && e.cancelled === true && !e.alreadyCancelled, "live order cancelled exactly once");
  ck(prov.cancel.length === 2 && prov.orders.get("ord_6").status === "cancelled", "provider order ord_6 is cancelled");
}
console.log("== reaper: fail-closed on chain verification failure =="); {
  const r4 = await req("POST", `${BASE}/api/reserve`, { from: "LOS", to: "JFK", depart: "20260915", ret: "20260922", passenger: PII });
  seedChain(7, { offer_id: r4.j.offerId });
  const c = await req("POST", `${BASE}/api/confirm-purchase`, { bookingId: bid(7), offerId: r4.j.offerId }, opHeaders);
  const ordId = c.j.duffelOrderId; // fake's ord counter is shared with offer ids — never hardcode
  ck(c.status === 200 && Boolean(ordId), `fourth booking confirmed (${c.status} ${ordId})`);
  await req("POST", `http://127.0.0.1:${RPC_PORT}/__control`, { rpcFail: true });
  const run = await req("POST", `${BASE}/api/reaper`, { execute: true }, opHeaders);
  const e = run.j.orphans.find((o) => o.orderId === ordId);
  ck(e && /chain verification failed/.test(e.reason || ""), `failed chain read -> reason surfaced (${e && e.reason})`);
  ck(!run.j.cancelled.includes(ordId) && prov.cancel.length === 2, "fail-closed: no order touched while the chain is unreachable");
  await req("POST", `http://127.0.0.1:${RPC_PORT}/__control`, { rpcFail: false });
}
console.log("== review: confirmed-not-completed labeling + expiry recovery =="); {
  // Future-dated trip so the date rule cannot complete it either.
  const r = await req("POST", `${BASE}/api/reserve`, { from: "LOS", to: "JFK", depart: "20270115", ret: "20270122", passenger: PII });
  seedChain(10, { offer_id: r.j.offerId });
  const c = await req("POST", `${BASE}/api/confirm-purchase`, { bookingId: bid(10), offerId: r.j.offerId }, opHeaders);
  const orderId = c.j.duffelOrderId;
  ck(c.status === 200 && Boolean(orderId), `purchase made for booking 10 (${c.status} ${orderId})`);
  const rec10 = Object.values(readRecs()).find((v) => v.providerOrderId === orderId);
  // (a) Merely confirmed, every segment in the future: the live Duffel lookup
  // returns a tagged duffel-live "pending" order, but /provider-status must
  // keep the date rule and NOT promote to completed or label it duffel-live.
  const ps1 = await req("GET", `${BASE}/provider-status?ref=${encodeURIComponent(rec10.ref)}&from=LOS&to=JFK&depart=2027-01-15&ret=2027-01-22`);
  ck(ps1.status === 200 && ps1.j.status === "confirmed" && ps1.j.source === "date-rule", `confirmed-but-not-completed stays date-rule, never duffel-live (${ps1.status} ${JSON.stringify(ps1.j).slice(0, 110)})`);
  // (b) confirm_purchase never seals (chain still held) and the hold expires:
  // the paid order can no longer seal, so reconciliation cancels it.
  chain.set(bid(10), { ...chain.get(bid(10)), hold_expiry: Math.floor(Date.now() / 1000) - 30 });
  const run = await req("POST", `${BASE}/api/reaper`, { execute: true }, opHeaders);
  const e = run.j.orphans.find((o) => o.orderId === orderId);
  ck(e && e.cancelled === true, `expired hold after purchase -> order cancelled (confirm can no longer seal)`);
  ck(prov.orders.get(orderId) && prov.orders.get(orderId).status === "cancelled", "provider order actually cancelled");
  const recAfter = Object.values(readRecs()).find((v) => v.providerOrderId === orderId);
  ck(recAfter && recAfter.status === "cancelled" && recAfter.reconciled === true, "record reconciled after expiry recovery");
  // (c) Positive control: a live CANCELLED order is genuine carrier evidence
  // and IS labeled duffel-live.
  const rec6 = Object.values(readRecs()).find((v) => v.providerOrderId === "ord_6");
  const ps2 = await req("GET", `${BASE}/provider-status?ref=${encodeURIComponent(rec6.ref)}&from=LOS&to=JFK&depart=2026-09-15&ret=2026-09-22`);
  ck(ps2.status === 200 && ps2.j.status === "cancelled" && ps2.j.source === "duffel-live", `live cancelled order labeled duffel-live (${ps2.status} ${ps2.j.source})`);
}
console.log("== operator override + /status =="); {
  const ref2 = Object.keys(readRecs()).find((k) => readRecs()[k].providerOrderId === "ord_4");
  const ov = await req("POST", `${BASE}/api/reservations/${ref2}/status`, { status: "completed" }, { Authorization: `Bearer ${PNR_SECRET}` });
  ck(ov.status === 200 && ov.j.status === "completed", "operator override accepted");
  const st = await req("GET", `${BASE}/status?ref=${ref2}&from=LOS&to=JFK&depart=2026-09-15&ret=2026-09-22`);
  ck(st.status === 200 && st.j.status === "completed", `/status derives the override (${st.status} ${JSON.stringify(st.j).slice(0, 100)})`);
}
// ---------- cleanup ----------
try { child.kill(); } catch {}
provSrv.close(); rpcSrv.close();
try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch {}
console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
if (failures > 0 && childErr.trim()) console.error("--- child output ---\n" + childErr.slice(-4000));
process.exit(failures === 0 ? 0 : 1);




