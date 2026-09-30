#!/usr/bin/env node
// Scheduler-side caller for the quote server's /api/reaper (see render.yaml).
// Usage:
//   REAPER_URL=https://travity-server.onrender.com OPERATOR_SECRET=... \
//     node scripts/reaper-ping.mjs [--dry-run]
// Posts {"execute": true} unless --dry-run. Exits nonzero on HTTP failure so
// cron-job.org / CI marks the run failed; prints a one-line verdict summary
// plus a detail line for every orphan that needs human attention.
const base = String(process.env.REAPER_URL || "https://travity-server.onrender.com").replace(/\/+$/, "");
const secret = String(process.env.OPERATOR_SECRET || "");
if (!secret) {
  console.error("reaper-ping: OPERATOR_SECRET is required");
  process.exit(2);
}
const execute = !process.argv.includes("--dry-run");
try {
  const res = await fetch(`${base}/api/reaper`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
    body: JSON.stringify({ execute }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`reaper-ping: HTTP ${res.status} ${j.error || ""}`.trim());
    process.exit(1);
  }
  const expired = Array.isArray(j.expired) ? j.expired : [];
  const orphans = Array.isArray(j.orphans) ? j.orphans : [];
  const cancelled = Array.isArray(j.cancelled) ? j.cancelled : [];
  const failedCancels = orphans.filter((o) => o.cancelError);
  console.log(
    `reaper: expired=${expired.length} orphans=${orphans.length} ` +
      (execute ? `cancelled=${cancelled.length}` : "dry-run (no cancels sent)") +
      ` failedCancels=${failedCancels.length}`
  );
  for (const o of orphans) {
    if (o.cancelError) console.log(`  CANCEL FAILED ${o.ref} ${o.orderId || ""}: ${o.cancelError}`);
    else if (o.action === "already-confirmed") console.log(`  reconciled ${o.ref} ${o.orderId || ""}: booking already confirmed on chain`);
    else if (o.reason) console.log(`  skipped ${o.ref} ${o.orderId || ""}: ${o.reason}`);
  }
  for (const e of expired) {
    console.log(`  expired hold ${e.ref}: run on-chain cancel_hold for ${e.bookingId || "unknown booking"}`);
  }
} catch (e) {
  console.error(`reaper-ping: ${e.message}`);
  process.exit(1);
}
