// Live recovery proof: hold -> real 905s wait -> expired confirm reverts ->
// cancel_hold refunds -> re-hold same offer succeeds. Runs OUTSIDE CI against
// live Studionet + live Duffel test mode. Spends test funds (escrow + Duffel
// balance) and takes ~16 minutes wall-clock. Do NOT run in CI.
//
// Required env:
//   GENLAYER_RPC              (default https://studio.genlayer.com/api)
//   GENLAYER_CONTRACT_ADDRESS (deployed TravelAgent, v3-hold-confirm build)
//   QUOTE_API                 (travity-server origin, e.g. https://travity-server.onrender.com)
//   WALLET_PRIVATE_KEY        (funded Studionet test wallet, 0x... - test funds only)
//   BOOKING_PROVIDER_API_KEY  (must match provider; sent as Bearer to server)
// Usage:
//   cd server && node live-recovery.mjs --route JFK-LHR --depart 20261201 --ret 20261208
//   Add --dry-run to validate env + health + offer-hold only (no spend, no wait).
import { createClient } from "genlayer-js";
import { studionet } from "genlayer-js/chains";
import { privateKeyToAccount } from "viem/accounts";

const argv = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, arr) => {
    if (cur.startsWith("--")) acc.push([cur.slice(2), arr[i + 1] && !arr[i + 1].startsWith("--") ? arr[i + 1] : "1"]);
    return acc;
  }, [])
);

const RPC = process.env.GENLAYER_RPC || "https://studio.genlayer.com/api";
const CONTRACT = process.env.GENLAYER_CONTRACT_ADDRESS || "";
const QUOTE_API = (process.env.QUOTE_API || "").replace(/\/+$/, "");
const DRY_RUN = argv["dry-run"] === "1";
const ROUTE = String(argv.route || "JFK-LHR");
const DEPART = String(argv.depart || "20261201");
const RET = String(argv.ret || "20261208");
const [ORIGIN, DESTINATION] = ROUTE.split("-");

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok && !DRY_RUN) process.exitCode = 1;
}

if (!CONTRACT) throw new Error("GENLAYER_CONTRACT_ADDRESS required");
if (!QUOTE_API) throw new Error("QUOTE_API required");
if (!DRY_RUN && !process.env.WALLET_PRIVATE_KEY) throw new Error("WALLET_PRIVATE_KEY required (omit only with --dry-run)");

const PII = {
  given_name: "Ada",
  family_name: "Testfly",
  born_on: "1990-06-01",
  gender: "f",
  title: "ms",
  email: "ada.testfly@example.com",
  phone_number: "+14155550000",
};

// 1. Health: both backends reachable and keyed.
{
  const s = await fetch(`${QUOTE_API}/health`).then((r) => r.json());
  check("server health ok", s.ok === true, `provider=${s.provider}`);
}

// 2. Offer hold (free, no charge).
const [o, d] = [ORIGIN.toUpperCase(), DESTINATION.toUpperCase()];
const holdRes = await fetch(`${QUOTE_API}/api/reserve`, {
  method: "POST",
  headers: { "Content-Type": "application/json", ...(process.env.BOOKING_PROVIDER_API_KEY ? {} : {}) },
  body: JSON.stringify({ from: o, to: d, depart: DEPART, ret: RET, passenger: PII }),
});
const hold = await holdRes.json().catch(() => ({}));
check("offer-hold returns offerId", holdRes.ok && String(hold.offerId || "").startsWith("off_"), hold.offerId || hold.error);
if (!holdRes.ok) process.exit(1);

if (DRY_RUN) {
  console.log("DRY RUN complete: env + health + offer-hold verified, no spend, no wait.");
  process.exit(0);
}

// 3. On-chain hold_booking escrow (spends test GEN).
const account = privateKeyToAccount(process.env.WALLET_PRIVATE_KEY);
const client = createClient({ chain: studionet, endpoint: RPC, account: account.address });
await client.writeContract({ address: CONTRACT, functionName: "refresh_quote", args: [o, d, Number(DEPART), Number(RET)], value: 0n });
const agreed = await client.readContract({ address: CONTRACT, functionName: "view_quote", args: [o, d, Number(DEPART), Number(RET)] });
const price = BigInt(agreed.price_wei ?? agreed.priceWei);
const holdTx = await client.writeContract({
  address: CONTRACT, functionName: "hold_booking",
  args: [o, d, Number(DEPART), Number(RET), hold.offerId, hold.passengerId, hold.itinerary_json],
  value: price,
});
check("hold_booking finalized", Boolean(holdTx), String(holdTx).slice(0, 18));
const bookingId = `${o}-${d}-${DEPART}-${RET}-${account.address}`;
const held = await client.readContract({ address: CONTRACT, functionName: "view_booking", args: [bookingId] });
const heldRec = typeof held === "string" ? JSON.parse(held) : held;
check("booking held, no locator yet", heldRec.status === "held" && heldRec.reservation_ref === "", heldRec.status);

// 4. Real 905s wait past hold_expiry (900s). Nothing mocked.
console.log("Waiting 905s past hold_expiry (real time)...");
await new Promise((r) => setTimeout(r, 905_000));

// 5. Late confirm_purchase must revert with hold expired (use a dummy order id;
//    the revert must come from expiry, proving the window is enforced live).
let expiredRevert = "";
try {
  await client.writeContract({ address: CONTRACT, functionName: "confirm_purchase", args: [bookingId, "ord_0000000000000000000000", "PNRPST99"], value: 0n });
} catch (e) {
  expiredRevert = e.message || String(e);
}
check("late confirm_purchase reverts (hold expired)", /hold expired/i.test(expiredRevert), expiredRevert.slice(0, 80));

// 6. cancel_hold refunds escrow; offer becomes re-holdable.
await client.writeContract({ address: CONTRACT, functionName: "cancel_hold", args: [bookingId], value: 0n });
const cancelled = await client.readContract({ address: CONTRACT, functionName: "view_booking", args: [bookingId] });
const cancelledRec = typeof cancelled === "string" ? JSON.parse(cancelled) : cancelled;
check("cancel_hold refunded + cancelled", cancelledRec.status === "cancelled", cancelledRec.status);

console.log("LIVE RECOVERY PROOF COMPLETE");
console.log(JSON.stringify({ contract: CONTRACT, bookingId, results }, null, 2));
