// Guard tests for booking-provider auth + validation: real HTTP against a
// live app instance. No mocks: every assertion below fires before any Duffel
// call (auth -> input validation -> key presence), except where noted.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = 18082;
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
  child = spawn(process.execPath, ["index.js"], {
    cwd: here,
    env: {
      ...process.env,
      PORT: String(PORT),
      PROVIDER_API_KEY: "test-provider-key",
      NODE_ENV: "test",
    },
    stdio: "ignore",
  });
  await waitForHealth();
});

after(() => {
  child?.kill();
});

async function post(p, { headers = {}, body = {} } = {}) {
  const res = await fetch(`${BASE}${p}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const j = await res.json().catch(() => ({}));
  return { status: res.status, body: j };
}

test("offer-hold without auth -> 401", async () => {
  const r = await post("/offer-hold", { body: { from: "JFK", to: "LHR", depart: "20261201" } });
  assert.equal(r.status, 401);
});

test("offer-hold with auth but no DUFFEL_API_KEY -> 503, no fallback", async () => {
  const r = await post("/offer-hold", { headers: AUTH, body: { from: "JFK", to: "LHR", depart: "20261201" } });
  assert.equal(r.status, 503);
});

test("confirm with auth but missing passenger id -> 400", async () => {
  const r = await post("/confirm", {
    headers: AUTH,
    body: { offerId: "off_test12345678", totalAmount: "100.00", totalCurrency: "USD", passenger: { given_name: "A" } },
  });
  assert.equal(r.status, 400);
});

test("confirm with auth but incomplete PII -> 400", async () => {
  const r = await post("/confirm", {
    headers: AUTH,
    body: {
      offerId: "off_test12345678",
      passengerId: "pas_test12345678",
      totalAmount: "100.00",
      totalCurrency: "USD",
      passenger: { given_name: "Ada", family_name: "Lovelace" },
    },
  });
  assert.equal(r.status, 400);
});

test("order-status without auth -> 401", async () => {
  const res = await fetch(`${BASE}/order-status?orderId=ord_test12345678`);
  assert.equal(res.status, 401);
});
