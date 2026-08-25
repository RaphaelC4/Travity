# Changelog

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
`0x3D3F1dd4fe7f044DBA73BE7A434603282638965C`

## v1 — initial submission

GenLayer travel agent: intelligent contract (quote consensus, escrow,
loyalty, AI-adjudicated disputes), rate-limited fare quote server, React +
wallet frontend.
