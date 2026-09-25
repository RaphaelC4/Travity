// Guard tests for POST /api/confirm-purchase: real HTTP against a live app
// instance, real assertions on rejections. No mocks: these paths never touch
// Duffel or GenLayer (auth/binding guards fire first), except the fail-closed
// chain test which points GENLAYER_RPC at an unreachable host on purpose.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = 18081;
const BASE = `http://127.0.0.1:${PORT}`;
let child;
let tmpdir;

async function waitForHealth(timeoutMs = 20000) {
  const start = Date.now();
  for (;;) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) return;
    } catch { /* not up yet */ }
    if (Date.now() - start > timeoutMs) throw new Error("server did not boot");
    await new Promise((r) => setTimeout(r, 250));
  }
}

before(async () => {
  tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "travity-server-test-"));
  child = spawn(process.execPath, ["index.js"], {
    cwd: here,
    env: {
      ...process.env,
      PORT: String(PORT),
      OPERATOR_SECRET: "test-operator-secret",
      BOOKING_PROVIDER_URL: "http://127.0.0.1:19999/book",
      BOOKING_PROVIDER_API_KEY: "test-key",
      GENLAYER_RPC: "http://127.0.0.1:1/",
      GENLAYER_CONTRACT_ADDRESS: "0x0000000000000000000000000000000000000001",
      RESERVATIONS_FILE: path.join(tmpdir, "reservations.json"),
    },
    stdio: "ignore",
  });
  await waitForHealth();
});

after(() => {
  child?.kill();
});

async function postConfirm({ headers = {}, body = {} }) {
  const res = await fetch(`${BASE}/api/confirm-purchase`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const j = await res.json().catch(() => ({}));
  return { status: res.status, body: j };
}

test("no auth -> 401", async () => {
  const r = await postConfirm({ body: { bookingId: "X", offerId: "off_test1234" } });
  assert.equal(r.status, 401);
});

test("wrong bearer -> 401", async () => {
  const r = await postConfirm({
    headers: { Authorization: "Bearer wrong" },
    body: { bookingId: "X", offerId: "off_test1234" },
  });
  assert.equal(r.status, 401);
});

test("wallet suffix mismatch -> 403", async () => {
  const r = await postConfirm({
    headers: { "X-Wallet-Address": "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "X-Wallet-Signature": "0xbbbb" },
    body: { bookingId: "JFK-LHR-20250101-20250102-0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", offerId: "off_test1234" },
  });
  assert.equal(r.status, 403);
});

test("garbage wallet signature -> 403", async () => {
  const w = "0x1111111111111111111111111111111111111111";
  const r = await postConfirm({
    headers: { "X-Wallet-Address": w, "X-Wallet-Signature": "0x1234" },
    body: { bookingId: `JFK-LHR-20250101-20250102-${w}`, offerId: "off_test1234" },
  });
  assert.equal(r.status, 403);
});

test("operator auth but chain RPC unreachable -> 502 fail-closed, no Duffel spend", async () => {
  const r = await postConfirm({
    headers: { Authorization: "Bearer test-operator-secret" },
    body: { bookingId: "JFK-LHR-20250101-20250102-0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", offerId: "off_test1234" },
  });
  assert.equal(r.status, 502);
  assert.match(r.body.error || "", /chain verification unavailable/);
});
