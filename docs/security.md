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
- Loyalty credits minted by `confirm_completion()`.
- Live price quotes culled from a single provider API (RapidAPI google-flights2
  by default; Kiwi.com Tequila or OmkarCloud Expedia are valid alternatives —
  one selected via `QUOTE_PROVIDER`). No fallback chain, no demo/polyfill feed:
  an unhealthy provider surfaces as a 503 / stale-marked quote, never a
  fabricated or substituted price.
- Dispute refund rulings (value-bearing).

## Threat list & mitigations

| Threat | Attack | Mitigation |
|---|---|---|
| Disputed-price / quote injection | Caller submits a self-serving low price | Quotes are produced inside a non-deterministic consensus block (`gl.vm.run_nondet_unsafe`). Validators independently re-fetch the provider and agree within a 5% tolerance before any state changes. `view_quote` is read-only cache of the agreed value. |
| Loyalty spoofing / self-confirmation | User marks their own trip complete | `confirm_completion` is owner-only and verdicts also run through consensus — validators check live status before loyalty mints. |
| Reentrancy | Nested call into `book()` / `escalate()` re-entering state mutators | Checks-effects-interactions: all state mutations happen only after the consensus block resolves. No external calls occur after a write; intra-tx re-entry is not possible because state writes are terminal for the receiver. (GenVM serializes writes; the pattern is preserved for clarity.) |
| Input validation | Malformed route, dates out of order, payment below/above quote | `_valid_route`, `_valid_dates`; `book` enforces `sent >= price` and rejects payments `> 2x` quote. All args validated before logic runs. |
| Dispute spam / rate abuse | Address floods disputes to drain validation compute | `last_dispute_block` rate gate per address; appeal bond grows with `rounds`. |
| Faulty validator consensus | One malicious leader proposes a bad ruling | `validator_fn` re-checks against the leader's response within a 10% tolerance and clamps to `[0, price_max]`; appeals re-run with larger sets. |
| XSS from web data | Provider page content rendered into DOM unescaped | React escapes by default. The client also validates every value before display and prefers display of numbers (`fmtGwei`) over raw fetched text. No `dangerouslySetInnerHTML`. |
| Quote-abuse of the LLM pipeline | User hammers `get_quote` from the browser | `getQuote` in the app calls a server-side `/api/quote` proxy (rate-limited), never the contract directly. See `.env.example` `QUOTE_PROXY_RATE_LIMIT`. |
| Key leakage | Private key committed or embedded in client bundle | `.env` gitignored; `GENLAYER_PRIVATE_KEY` touches only `scripts/deploy.py` server-side; the client bundle uses only the contract address + RPC. |
| Owner compromise / protocol freeze | Admin key lost; need to halt | `pause` / `kill` escape hatches. `kill` is irreversible by design. |
| Replay / duplicate booking | Same sender re-submits identical booking | `booking_id` includes route + sender + departure; duplicates revert. |

## Security trade-offs accepted

- `RANGE_PRICE_MAX` (1M wei) is an artificial cap; real deployments would
  derive bounds from provider policies.
- The `owner` check is a single address. Production should use a multi-sig /
  timelock controller for `pause`, `kill`, and `confirm_completion`.
- `gl.message.chain_id` is used as the "current block" proxy where the block
  number is unavailable; this makes the dispute rate-window approximate,
  not exact. Replace with a consensus-provided height when available.
- Provider URLs are placeholders (`api.example-travel-provider.com`). In a
  real deployment the provider endpoint and its response schema must be pinned
  and content-addressed into the suite so evals are reproducible.

## Release checklist

- [ ] Pin the provider API + response schema (reproducible fixture).
- [ ] Replace single owner with multi-sig/time-lock controller.
- [ ] Server-side `/api/quote` proxy implemented and rate-limited (no direct
      contract calls from the browser in production).
- [ ] Re-run negative test suite (`tests/test_travel_agent.py`) against GLSim.
- [ ] Never commit `.env`; keep `GENLAYER_PRIVATE_KEY` server-side only.