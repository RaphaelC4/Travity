// Integration tests for the booking-provider's live Duffel endpoints
// (/order-status, /cancel). The real app boots as a child process with
// test-duffel-preload.mjs preloaded via --import, which patches fetch so
// api.duffel.com resolves against an in-memory fake — no network.
// Covers the exact behaviors travity-server's reaper and dispute path rely
// on: cancelled_at -> "cancelled", all-arrived segments -> "completed",
// future ticket -> "confirmed", unknown order -> 502, cancel refund surfaced.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = 18083;
const BASE = `http://127.0.0.1:${PORT}`;
const AUTH = { Authorization: "Bearer test-provider-key" };
let child;

async function waitForHealth(timeoutMs = 20000) {
  const start = Date.now();
  for (;;) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) return;
    } catch { /* not up yet */ }
    if (Date.now() - start > timeoutMs) throw new Error("provider did not boot");
    await new Promise((r) => setTimeout(r, 250));
  }
}

before(async () => {
  child = spawn(process.execPath, ["--import", "./test-duffel-preload.mjs", "index.js"], {
    cwd: here,
    env: {
      ...process.env,
      PORT: String(PORT),
      PROVIDER_API_KEY: "test-provider-key",
      DUFFEL_API_KEY: "fake-test-key",
      NODE_ENV: "test",
    },
    stdio: "ignore",
  });
  await waitForHealth();
});

after(() => {
  child?.kill();
});

async function getStatus(orderId) {
  const res = await fetch(`${BASE}/order-status?orderId=${encodeURIComponent(orderId)}`, { headers: AUTH });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

test("order-status: paid future ticket is confirmed with the carrier refund policy", async () => {
  const r = await getStatus("ord_live_ok");
  assert.equal(r.status, 200);
  assert.equal(r.body.status, "confirmed");
  assert.equal(r.body.source, "duffel-live");
  assert.equal(r.body.refundPolicy.refundable, "non_refundable");
});

test("order-status: cancelled_at maps to cancelled (reaper idempotency pre-check)", async () => {
  const r = await getStatus("ord_live_cancelled");
  assert.equal(r.status, 200);
  assert.equal(r.body.status, "cancelled");
  assert.equal(r.body.refundPolicy.refundable, "refundable");
  assert.equal(r.body.refundPolicy.penalty, "0.00 USD");
});

test("order-status: all segments arrived -> completed (no date-rule promotion)", async () => {
  const r = await getStatus("ord_live_completed");
  assert.equal(r.status, 200);
  assert.equal(r.body.status, "completed");
});

test("order-status: unknown order -> 502 with the Duffel status surfaced", async () => {
  const r = await getStatus("ord_does_not_exist");
  assert.equal(r.status, 502);
  assert.match(r.body.error, /Duffel lookup 404/);
});

test("cancel: cancels a live order and surfaces the refund", async () => {
  const res = await fetch(`${BASE}/cancel`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...AUTH },
    body: JSON.stringify({ orderId: "ord_live_ok" }),
  });
  const j = await res.json().catch(() => ({}));
  assert.equal(res.status, 200);
  assert.equal(j.cancelled, true);
  assert.equal(j.refund, "120.00");
});

test("cancel: unknown order -> 502 with the Duffel status surfaced", async () => {
  const res = await fetch(`${BASE}/cancel`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...AUTH },
    body: JSON.stringify({ orderId: "ord_does_not_exist" }),
  });
  const j = await res.json().catch(() => ({}));
  assert.equal(res.status, 502);
  assert.match(j.error, /Duffel cancel failed \(404\)/);
});

test("cancel: non-ord_ id rejected before any Duffel call", async () => {
  const res = await fetch(`${BASE}/cancel`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...AUTH },
    body: JSON.stringify({ orderId: "nope" }),
  });
  assert.equal(res.status, 400);
});
