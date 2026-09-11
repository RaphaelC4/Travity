# Travity

Travity is a GenLayer-powered travel agent: live web fares, escrowed GEN
payments bound to a verifiable Duffel purchase, on-chain loyalty, and
AI-adjudicated one-shot dispute refunds with booking-specific evidence.

## Layout

```
contracts/travel_agent.py   GenLayer Intelligent Contract (Python) — hold_booking 7-arg + confirm_purchase 3-arg + cancel_hold, no date-rule escape
tests/                      Direct Mode tests on real GenVM (12 tests, hold→confirm→completion e2e)
frontend/                   React + Vite app (Book → hold_booking escrow → confirm_purchase seal, 3-state HELD/CONFIRMED/COMPLETED)
server/                     Express quote + reserve/status proxy (offer-hold → confirm-purchase, duffel-live/aviationstack)
booking-provider/           Duffel booking service — POST /offer-hold (free) + POST /confirm (paid) + GET /order-status, 5m cache, 429 retry
scripts/deploy.py           Contract deployment smoke flow
docs/security.md            Threat model + hardening notes
```

## Quick start

Contract tests run on GenLayer's official runner (genlayer-test Direct Mode):
contracts execute in the real GenVM — storage, calldata encoding, and
consensus plumbing included; only external web/LLM responses are simulated.
No mocks of GenLayer itself.

```
pip install -r requirements.txt
python -m pytest tests -v   # 12 passed: hold→confirm, reuse, window, evidence, owner, dispute, cancel
```

Frontend + servers (live mode needs provider keys in `server/.env` and `booking-provider/.env`):

```
# Terminal 1 — booking provider (real Duffel holds/orders)
cd booking-provider && npm install && npm run dev   # http://127.0.0.1:3001  (needs DUFFEL_API_KEY=duffel_test_…)

# Terminal 2 — quote + reserve/status server
cd server && npm install && npm run dev             # http://127.0.0.1:8080  (needs BOOKING_PROVIDER_URL=http://127.0.0.1:3001/book, RAPID_API_KEY, GEN_USD_RATE, AVIATIONSTACK_KEY optional)

# Terminal 3 — frontend (proxies /api to server)
cd frontend && npm install && npm run dev           # http://localhost:5173
npm run lint
npm run build
```

The frontend connects to the deployed TravelAgent contract (set
`VITE_GENLAYER_CONTRACT_ADDRESS` in `frontend/.env`).

## Live modes

### 1. Live quotes — single provider, no fallback

The server uses exactly **one** fare source at a time, chosen by `QUOTE_PROVIDER`
in `server/.env`:

- `rapid` (default) — **RapidAPI "google-flights2"** (real Google Flights
  fares). Free account at `rapidapi.com` → subscribe to google-flights2
  (free tier) → copy the `X-RapidAPI-Key` into `RAPID_API_KEY`.

Quotes are live via `QUOTE_PROVIDER=rapid` (`render.yaml:31`) — `GET /api/quote?from=&to=&depart=&ret=` proxied through `travity-server` and agreed on-chain via `refresh_quote` `prompt_comparative` (5% tolerance).

1. Copy `server/.env.example` to `server/.env`; set `RAPID_API_KEY` and `GEN_USD_RATE` (the server also probes CoinGecko first — currently GEN has no listing, so the env rate is the reliable source).
2. Restart the server. `GET /api/quote?from=JFK&to=LHR&depart=YYYYMMDD&ret=…` returns the cheapest real outbound fare converted to GEN wei — no fabricated price, live RapidAPI success path.

### 2. Live booking — Duffel hold → escrow → confirm, no demo fallback

Two-step, escrow before purchase (hold 900s = Duffel offer window):

1. `POST /api/reserve` → `travity-booking-provider` `POST /offer-hold` — **free** `POST https://api.duffel.com/air/offer_requests` → returns `{offerId, passengerId, itinerary_json, totalAmount, holdExpiry}` (cached 5m, `429` retry, no `ord_…` yet).
2. `hold_booking(origin,destination,depart,ret,off_…,pas_…,itinerary_json)` — **payable** locks escrow, `status:"held"`, `hold_expiry=now+900`, `offer_used` set, no `ref`/`ord_…`.
3. `POST /api/confirm-purchase {bookingId, offerId}` → `POST /confirm` — **paid** `POST https://api.duffel.com/air/orders` with `selected_offers:[off_…]` + `payments:[{type:"balance", amount:totalAmount}]` → `{locator, duffelOrderId}`.
4. `confirm_purchase(bookingId, ord_…, locator)` — **customer-only** seals `ref`/`ord_…` first time, `order_used`/`ref_used` uniqueness, reverts if `hold expired` or `order already used`. `cancel_hold(bookingId)` refunds escrow after `900s` if never confirmed.

No HMAC fallback: without `DUFFEL_API_KEY` the provider returns `503` and `POST /api/reserve` returns `502`.

Set in `booking-provider/.env` / Render `travity-booking-provider`: `DUFFEL_API_KEY=duffel_test_…`. Set in `server/.env` / Render `travity-server`: `BOOKING_PROVIDER_URL=https://travity-booking-provider.onrender.com/book` (prod) and `AVIATIONSTACK_KEY` for `flight_status` enrichment.

### 3. Live on-chain + wallet — GenLayer Studio

1. Deploy the contract from GenLayer Studio and copy its address.
2. Copy `frontend/.env.example` to `frontend/.env`; set
   `VITE_GENLAYER_CONTRACT_ADDRESS` (RPC defaults to Studionet `https://studio.genlayer.com/api`, chainId `61999`).
   Set `VITE_QUOTE_API` to the public `travity-server` origin — owner must call `set_feed_url` with this same value so validators fetch `/quote` + `/provider-status` from a reachable HTTPS host.
3. Owner calls `set_provider` (payout address) and `set_feed_url` — both required before `hold_booking`/`confirm_completion`.
4. Optional: set `VITE_WC_PROJECT_ID` (free at cloud.walletconnect.com) to get
   a WalletConnect QR on mobile; otherwise an injected wallet (Rabby/MetaMask)
   is used.
5. On the Book page connect your wallet — **Hold** locks escrow (`HELD`), **Confirm purchase** seals Duffel `ord_…`/`PNR` (`CONFIRMED`), **Settle** after `duffel-live completed`/`aviation landed` + `6h` window → `COMPLETED` + loyalty. `Review & pay` pills derive `HELD`/`CONFIRMED`/`COMPLETED` from `view_booking` and refresh on mount + after each write.

Deployed contracts (Studionet):
- `0x601e602C50bc2048ac8033C21e16Ce4D3712e48D` — `105ed6a` hold→confirm build (current, use this)
- `0x774eFD6bB076fCB270e1bb596d8c0335e5895D27` — legacy 9-arg book (deprecated)

The contract exposes: `hold_booking(origin,destination,depart,ret,off_…,pas_…,itinerary_json)` payable 7-arg (no `ref`/`ord_…`, `900s` hold, `offer_used`), `confirm_purchase(bookingId,ord_…,locator)` customer-only 3-arg seals receipt (`order_used`/`ref_used` uniqueness, `hold_expired` check), `cancel_hold(bookingId)` refunds after `900s`, `confirm_completion`/`settle_booking`/`force_complete` (permissionless/owner but same `6h` + `provider-status` `source in (duffel-live,aviationstack)` + `completed`/`landed` via `prompt_comparative`, no `date-rule` escape, no operator bypass), `book` 9-arg — **deprecated, reverts "use hold_booking then confirm_purchase"** — plus `file_dispute`/`escalate` (one-shot AI refund with `refund_policy` + `aviation.flight_status`), `balance_of`, `view_booking`/`view_dispute`/`view_provider_config`.

## Security

See `docs/security.md`. Highlights: `hold_booking` 7-arg + `confirm_purchase` 3-arg bound booking (`off_…` + `pas_…` + `itinerary_json` + escrow before purchase, `ref`/`ord_…` sealed only at confirm, `900s` hold); `offer`/`ref`/`order` global reuse blocked; `confirm_purchase` customer-only; settlement verifies live `provider-status` (`duffel-live`/`aviationstack` `completed`/`landed`, `source` check, `prompt_comparative`) + `6h` window, no `date-rule` alone, no operator bypass (emergency → `escalate`); consensus-checked quotes/rulings 5%/10%; checks-effects-interactions; input validation; dispute limit 10m + settlement 6h; pause/kill; rate-limited proxy (no direct client-to-provider calls, `429` retry, `5m` offer cache).
