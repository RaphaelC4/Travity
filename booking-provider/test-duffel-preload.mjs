// Preload shim for booking-provider integration tests:
//   node --import ./test-duffel-preload.mjs index.js
// Patches globalThis.fetch BEFORE the app boots so every api.duffel.com call
// resolves against an in-memory fake — no network, no real Duffel key. Any
// other URL falls through to the real fetch (health checks, etc.).
const ORDERS = new Map([
  // Paid, future ticket: stays "confirmed" even though a date has passed.
  ["ord_live_ok", {
    data: {
      cancelled_at: null,
      conditions: { refund_before_departure: { allowed: false } },
      slices: [{ segments: [{ arriving_at: "2099-01-01T10:00:00Z" }] }],
    },
  }],
  // Cancelled by the operator: cancelled_at is what /order-status keys on.
  ["ord_live_cancelled", {
    data: {
      cancelled_at: "2026-01-01T00:00:00Z",
      conditions: { refund_before_departure: { allowed: true, penalty_amount: "0.00", penalty_currency: "USD" } },
      slices: [],
    },
  }],
  // All segments arrived in the past: carrier-side "completed".
  ["ord_live_completed", {
    data: {
      cancelled_at: null,
      conditions: {},
      slices: [{ segments: [{ arriving_at: "2020-01-01T10:00:00Z" }] }],
    },
  }],
]);

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const s = String(url instanceof URL ? url : (url && url.url) || url);
  const order = /^https:\/\/api\.duffel\.com\/air\/orders\/([^/?]+)/.exec(s);
  if (order) {
    const id = decodeURIComponent(order[1]);
    if (!ORDERS.has(id)) {
      return new Response(JSON.stringify({ errors: [{ message: `order ${id} not found` }] }), { status: 404, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify(ORDERS.get(id)), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (/^https:\/\/api\.duffel\.com\/air\/order_cancellations/.test(s)) {
    let id = "";
    try { id = String(JSON.parse(opts.body || "{}")?.data?.order_id || ""); } catch {}
    if (!ORDERS.has(id)) {
      return new Response(JSON.stringify({ errors: [{ message: `order ${id} not found` }] }), { status: 404, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ data: { refund_amount: "120.00", refund_to: "balance" } }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  return realFetch(url, opts);
};
