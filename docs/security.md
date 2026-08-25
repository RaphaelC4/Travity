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

1. **Unforgeable, reservation-tied evidence.** `book()` requires a
   `reservation_ref` — the PNR the provider issued when the reservation was
   actually created off-chain. PNRs are HMAC-SHA256 derivations over the exact
   trip parameters (route + dates) keyed by a server-only secret (`PNR_SECRET`)
   that never appears on-chain: the contract holds no credentials at all, so
   nothing in public state can be replayed against the provider feed to forge
   or alter refund evidence. The dispute path fetches
   `/status?ref&from&to&depart&ret`, admits only evidence echoing the
   booking's own ref, and treats everything else as unavailable (full-refund
   default). Settlement is fully deterministic and needs no external input:
   `settle_booking` (permissionless) pays out once the return date has passed,
   and `force_complete` (owner-only) settles early as an explicit operator
   override.
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

### Requirement mapping

- **Authenticated carrier/agency evidence tied to a real reservation** —
  reservation references are `HMAC-SHA256(PNR_SECRET, route|depart|ret)`
  rendered into a 6-char alphabet by the agency server (`server/index.js`,
  `pnrFor()`). `/status` recomputes the HMAC from the query parameters and
  answers only on an exact match, so every piece of admitted evidence is tied
  to a reservation the agency actually issued and cannot be forged without
  the server-only secret. No credentials exist anywhere in contract state.
- **Customer-only dispute authorization** — `file_dispute` reverts unless
  `gl.message.sender_address == booking["customer"]`; enforced on-chain and
  proven by `tests/test_travel_agent_glsim.py::test_only_customer_can_dispute`
  on the real GenVM runner.
- **Defined provider settlement path** — `settle_booking`/`force_complete`
  pay the full escrowed fare to the owner-set `provider_address`; `escalate`
  settles the ruled refund and the remainder in the same call. Double-
  settlement is blocked by `booking["settled"]` and
  `dispute["status"] == "ruled"` guards. Proven by
  `test_full_lifecycle_settlement` and `test_double_settlement_blocked`.

## Threat list & mitigations

| Threat | Attack | Mitigation |
|---|---|---|
| Disputed-price / quote injection | Caller submits a self-serving low price | Quotes are produced inside a non-deterministic consensus block (`gl.vm.run_nondet_unsafe`). Validators independently re-fetch the provider and agree within a 5% tolerance before any state changes. `view_quote` is read-only cache of the agreed value. |
| Loyalty spoofing / self-confirmation | User settles their own trip early or fabricates completion | Settlement is rule-based: `settle_booking` pays out only after the return date has passed; `force_complete` is owner-only. Loyalty credits are internal — not withdrawable or transferable — so minting them confers no direct GEN. |
| Refund-evidence forgery via leaked credentials | Attacker reads a bearer token from public contract state and rewrites provider evidence | No credential exists on-chain. Reservation refs are HMACs over the trip parameters keyed by a server-only secret (`PNR_SECRET`); `/status` recomputes the HMAC from the query and answers only on an exact match, so evidence cannot be minted, replayed, or altered from chain data. |
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
| Key leakage | Private key or server secret committed or embedded in client bundle | `.env` gitignored; `GENLAYER_PRIVATE_KEY` and `PNR_SECRET` live only in server-side env; the contract holds no credentials, and the client bundle uses only the contract address + RPC. |
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
- Dispute evidence authenticity rests on HMAC-derived reservation refs keyed
  by a server-only secret (`PNR_SECRET`): the provider feed verifies refs by
  recomputation and answers nothing for unknown ones. The trade-off is
  centralization of that secret on one server — protect it like a key.
- Dispute rulings are **one-shot**: `escalate` runs the ruling and settles
  both legs (refund + remainder) in the same call; there are no appeal rounds
  afterward.
- Loyalty credits (`balance_of`) are an **internal balance**: they accrue from
  overpayment refunds and settlement mints but cannot be withdrawn as GEN or
  transferred between addresses today. They're an accounting primitive, not a
  token.
- Completion settlement uses a deterministic date rule rather than live
  carrier evidence: `settle_booking` unlocks strictly after the return date,
  and `force_complete` is an explicit owner override. This trades real-time
  carrier integration for a settlement path with no external dependencies;
  HMAC-verified evidence still governs the dispute path.

## Release checklist

- [ ] Pin the provider API + response schema (reproducible fixture).
- [ ] Owner calls `set_provider` (payout address) before any settlement or
      `escalate` dispute traffic — both revert until configured.
- [ ] Set `PNR_SECRET` on the quote server (server-only; never on-chain).
- [ ] Replace single owner with multi-sig/time-lock controller.
- [ ] Server-side `/api/quote` proxy implemented and rate-limited (no direct
      contract calls from the browser in production).
- [ ] Re-run negative test suite (`tests/test_travel_agent.py`) against GLSim.
- [ ] Never commit `.env`; keep `GENLAYER_PRIVATE_KEY` server-side only.
