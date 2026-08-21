# Travity security notes

Threat model and hardening rationale. The contract is the security boundary
that matters; the frontend is where injection and abuse enter through user and
web-fetched data.

## Scope

- `contracts/travel_agent.py` — Python Intelligent Contract on GenLayer.
- `frontend/` — React + Vite app talking to the contract.
- `scripts/deploy.py` — deployment path.

## Assets

- GEN held in escrow by `book()`.
- Loyalty credits minted by `settle_booking()`/`force_complete()` — an
  internal contract balance, not withdrawable or transferable (see
  trade-offs below).
- Live price quotes culled from a single provider API (RapidAPI google-flights2
  by default; Kiwi.com Tequila or OmkarCloud Expedia are valid alternatives —
  one selected via `QUOTE_PROVIDER`). No fallback chain, no demo/polyfill feed:
  an unhealthy provider surfaces as a 503 / stale-marked quote, never a
  fabricated or substituted price.
- Dispute refund rulings (value-bearing, one-shot — see trade-offs below).
- Settled escrow paid out to the carrier/agency (`provider_address`).

## Trust and payment invariants (settlement + dispute)

These three are enforced together, not independently, because a gap in any
one defeats the others:

1. **Reservation-tied bookings; deterministic settlement.** `book()` requires
   a `reservation_ref` — the PNR/confirmation code the provider issued when
   the reservation was actually created off-chain. It anchors the booking to
   a real off-chain reservation and is the reference the DISPUTE path later
   verifies against authenticated evidence. Settlement itself is fully
   deterministic and needs no external input: `settle_booking` (permissionless)
   pays out once the return date has passed, and `force_complete` (owner-only)
   settles early as an explicit operator override. No web fetch, no LLM, no
   consensus block sits between an ordinary booking and verified settlement,
   so there is nothing to spoof, time out, or disagree about.
2. **Customer-only dispute authorization.** `file_dispute` checks
   `gl.message.sender_address` against `booking["customer"]` before accepting
   a claim — only the person who escrowed the funds for a booking can dispute
   it. It also only accepts a dispute while the booking is still `confirmed`
   (unsettled); once a booking is `completed`/`disputed`/`resolved` there's no
   remaining escrow to reallocate.
3. **Defined provider settlement path.** Funds never sit in the contract
   indefinitely. `settle_booking`/`force_complete` pay the full escrowed fare
   to `provider_address`. `escalate` always settles both legs in the same
   call: the ruled refund to the customer, and the remainder
   (`price − refund`) to `provider_address`. All paths guard against
   double-settlement — `booking["settled"]` for completion,
   `dispute["status"] == "ruled"` (unconditionally, not just when a refund
   was paid) for disputes — and refuse to run until the owner has called
   `set_provider` with a real payout address.

## Threat list & mitigations

| Threat | Attack | Mitigation |
|---|---|---|
| Disputed-price / quote injection | Caller submits a self-serving low price | Quotes are produced inside a non-deterministic consensus block (`gl.vm.run_nondet_unsafe`). Validators independently re-fetch the provider and agree within a 5% tolerance before any state changes. `view_quote` is read-only cache of the agreed value. |
| Loyalty spoofing / self-confirmation | User marks their own trip complete | `settle_booking`/`force_complete` are the settlement paths, authenticated with a bearer token and checked against the booking's own `reservation_ref` — a generic or unauthenticated read is never accepted as evidence. |
| Third-party dispute filing | Non-customer files a dispute against someone else's booking to grief it or manufacture a refund path | `file_dispute` requires `gl.message.sender_address == booking["customer"]`; any other caller reverts. |
| Dispute after settlement | Customer disputes a booking that's already been paid out in full to the provider | `file_dispute` only accepts bookings still in `confirmed` status; `completed`/`disputed`/`resolved` bookings are rejected since there's no escrow left to split. |
| Escrow stranded / no settlement | Funds sit in the contract forever with no defined recipient | `settle_booking`/`force_complete` and `escalate` all refuse to run until `provider_address` is set, and both pay out to it (full fare, or the post-refund remainder) in the same call that resolves the booking/dispute. |
| Dispute replay | `escalate` called twice on the same dispute to double-pay | Guarded by `dispute["status"] == "ruled"`, checked unconditionally — not gated on `paid_out`, so a zero-refund ruling still blocks replay. |
| Reentrancy | Nested call into `book()` / `escalate()` re-entering state mutators | Checks-effects-interactions: all state mutations happen only after the consensus block resolves. No external calls occur after a write; intra-tx re-entry is not possible because state writes are terminal for the receiver. (GenVM serializes writes; the pattern is preserved for clarity.) |
| Input validation | Malformed route, dates out of order, payment below/above quote, malformed reservation ref | `_valid_route`, `_valid_dates`, `_valid_ref`; `book` enforces `sent >= price` and rejects payments `> 2x` quote. All args validated before logic runs. |
| Dispute spam / rate abuse | Address floods disputes to drain validation compute | `last_dispute_time` rate gate per address; appeal bond grows with `rounds`. |
| Faulty validator consensus | One malicious leader proposes a bad ruling | `prompt_comparative` re-checks the leader's response within a 10% tolerance and clamps to `[0, price_max]`. Rulings are one-shot: there are no appeal rounds after `escalate` settles. |
| XSS from web data | Provider page content rendered into DOM unescaped | React escapes by default. The client also validates every value before display and prefers display of numbers (`fmtGwei`) over raw fetched text. No `dangerouslySetInnerHTML`. |
| Quote-abuse of the LLM pipeline | User hammers `get_quote` from the browser | `getQuote` in the app calls a server-side `/api/quote` proxy (rate-limited), never the contract directly. See `.env.example` `QUOTE_PROXY_RATE_LIMIT`. |
| Key leakage | Private key or provider bearer token committed or embedded in client bundle | `.env` gitignored; `GENLAYER_PRIVATE_KEY` and the provider auth token touch only `scripts/deploy.py` / owner-only setters server-side; the client bundle uses only the contract address + RPC. |
| Owner compromise / protocol freeze | Admin key lost; need to halt | `pause` / `kill` escape hatches. `kill` is irreversible by design. |
| Replay / duplicate booking | Same sender re-submits identical booking | `booking_id` includes route + sender + departure; duplicates revert. |

## Security trade-offs accepted

- `RANGE_PRICE_MAX` (1M wei) is an artificial cap; real deployments would
  derive bounds from provider policies.
- The `owner` check is a single address. Production should use a multi-sig /
  timelock controller for `pause`, `kill`, and `force_complete`.
- `gl.message.chain_id` is used as the "current block" proxy where the block
  number is unavailable; this makes the dispute rate-window approximate,
  not exact. Replace with a consensus-provided height when available.
- Provider URLs are placeholders (`api.example-travel-provider.com`). In a
  real deployment the provider endpoint and its response schema must be pinned
  and content-addressed into the suite so evals are reproducible.
- The provider bearer token is stored on-chain in plaintext
  (`provider_auth_token`), visible to anyone reading contract storage. This is
  a known limitation, not a secret-management solution — it authenticates the
  contract's reads to the provider, it does not hide the token from chain
  observers. A production deployment should treat it as a low-privilege,
  rotatable, read-only token scoped to status lookups, never a token with
  write/booking-creation privileges on the provider's own API.
- Dispute rulings are **one-shot**: `escalate` runs the ruling and settles
  both legs (refund + remainder) in the same call; there are no appeal rounds
  afterward. The pre-ruling rate limit and escalating bond are the only
  spam/abuse levers.
- Loyalty credits (`balance_of`) are an **internal balance**: they accrue from
  overpayment refunds and completion mints but cannot be withdrawn as GEN or
  transferred between addresses today. They're an accounting primitive, not a
  token.
- Completion settlement uses a deterministic date rule rather than live
  carrier evidence: `settle_booking` unlocks strictly after the return date,
  and `force_complete` is an explicit owner override. This trades real-time
  carrier integration for a settlement path with no external dependencies;
  authenticated evidence still governs the dispute path.

## Release checklist

- [ ] Pin the provider API + response schema (reproducible fixture).
- [ ] Owner calls `set_provider` (payout address) and `set_provider_auth`
      (bearer token) before any `escalate` dispute traffic —
      both revert until configured.
- [ ] Replace single owner with multi-sig/time-lock controller.
- [ ] Server-side `/api/quote` proxy implemented and rate-limited (no direct
      contract calls from the browser in production).
- [ ] Re-run negative test suite (`tests/test_travel_agent.py`) against GLSim.
- [ ] Never commit `.env`; keep `GENLAYER_PRIVATE_KEY` server-side only.
