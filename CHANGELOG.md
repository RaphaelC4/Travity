# Changelog

## v3.1 — reaper safety + integration tests (`v3.1-reaper-safety`)

`POST /api/reaper` no longer cancels paid Duffel orders on its own authority.
Every orphan (paid order, record not reconciled) is first re-read from
**finalized** GenLayer state via `view_booking`:

| Chain state | Reaper action |
|---|---|
| `confirmed` | Keep the order; mark the record `reconciled` (previous behavior cancelled exactly these — paid tickets behind on-chain-confirmed bookings) |
| `cancelled` | Order can never seal → cancel it (escrow already refunded on-chain) |
| `held`, hold expired | Late confirms revert → cancel the order |
| `held`, hold active | Confirm can still land → skip |
| RPC failure / unknown booking / record without `bookingId` | **Fail closed** — never touch the order; reason surfaced per entry |

Cancels are idempotent: the live provider order is checked first, and a
Duffel "already been cancelled" rejection counts as reconciled instead of an
error. Every trust-critical read (`/api/confirm-purchase` gating and the
reaper) pins `view_booking` to consensus-**finalized** state
(`transactionHashVariant: "latest-final"`) instead of the SDK's
`latest-nonfinal` default, so a still-finalizing escrow can never satisfy a
pre-spend check. New env knobs: `RESERVE_RATE_LIMIT`, `STATUS_RATE_LIMIT`,
`REAPER_MIN_AGE_MS`. Ref-shape validation widened to `A-Z0-9-` on
`/status`, `/provider-status`, and the operator override so the server's own
`HOLD-…` refs pass. `live-recovery.mjs` now actually sends the provider
Bearer header.

New integration tests (no network, no mocks of the unit under test):
`server/confirm-flow.test.mjs` (51 checks — boots the real server against a
fake GenLayer JSON-RPC speaking the real `genlayer-js` calldata codec and a
fake booking-provider; covers reserve→confirm happy path, fail-closed chain
reads, idempotency, expired/mismatched/escrow-less holds, unauthorized and
unheld purchase attempts, all five reaper verdicts, expiry recovery after a
paid purchase, and confirmed-but-not-completed trips never being labeled
`duffel-live`) and `booking-provider/order-status.test.mjs` +
`test-duffel-preload.mjs` (7 tests — real app with `--import` fetch shim;
`cancelled_at`→`cancelled`, all-arrived→`completed`, future→`confirmed`,
cancel refund surfaced). Run with `npm test` in either service.
`scripts/reaper-ping.mjs` is the ready-made scheduler caller for the
cron-job.org/Render pattern documented in `render.yaml` (`REAPER_URL` +
`OPERATOR_SECRET`, `--dry-run` supported, nonzero exit on HTTP failure).

## v3 — hold→confirm booking protection (`v3-hold-confirm`)

Two-step `hold_booking` 7-arg (escrow, no `ref`, `900s`) → Duffel purchase →
`confirm_purchase` customer-only seals `order_used`/`ref_used`; `cancel_hold`
refunds after expiry. Settlement requires live `duffel-live`/`aviationstack`
`completed`/`landed` (no `date-rule` escape, no relabel); `POST
/api/confirm-purchase` dual-auth + idempotent. `14 passed` Direct Mode.

Deployed contract for this build (Studionet):
`0x93917fdeb92E31B108F002368229d8bbE9C7406e`

## v2 — resubmission addressing review feedback

Reviewer request: *"The settlement-authority fix is present, but the requested
integration proof and disclosure alignment are still incomplete: the test
replaces GenLayer with mocks, and the disputes UI still advertises a second
review. The refund evidence can also be changed using a bearer token exposed
in public contract state."*

| Feedback point | Resolution |
|---|---|
| Integration proof replaced GenLayer with mocks | Mock harness deleted. `tests/test_travel_agent_glsim.py` runs on **genlayer-test Direct Mode** — GenLayer's official runner executing the contract in the real GenVM (real storage, calldata encoding, consensus plumbing); only external web/LLM responses are simulated. Includes the requested proof: an ordinary booking reaches verified settlement with exactly-once provider payout and customer loyalty mint (`test_full_lifecycle_settlement`). 7/7 passing. |
| Disputes UI advertised a second review | The "Ask for a second review" button is now "Escalate for final ruling"; toast, lede, and lifecycle copy state the one-shot ruling everywhere. Contract behavior unchanged: `escalate` settles refund + remainder in one call, replay blocked. |
| Refund evidence alterable via bearer token in public contract state | The on-chain credential was removed entirely (`set_provider_auth`/`provider_auth_token` deleted). Reservation references are issued by `POST /api/reserve` on a **dedicated booking-provider service** (`travity-booking-provider`, `BOOKING_PROVIDER_URL`) — an actual provider transaction whose secret never touches the chain. Status evidence comes from `GET /provider-status`, enriched from an **independent carrier source** (`Aviationstack`, `AVIATIONSTACK_KEY` → `flight_status`) and verified deterministically by `escalate`. No secret exists in contract state. |

Also included (from the prior feedback round): deterministic settlement path —
permissionless `settle_booking` (return-date rule) + owner-only
`force_complete`; requirement-to-code mapping in `docs/security.md`.

Deployed contract for this build (Studionet):
`0x774eFD6bB076fCB270e1bb596d8c0335e5895D27`

## v1 — initial submission

GenLayer travel agent: intelligent contract (quote consensus, escrow,
loyalty, AI-adjudicated disputes), rate-limited fare quote server, React +
wallet frontend.
