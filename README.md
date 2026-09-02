# Travity

Travity is a GenLayer-powered travel agent: live web fares, escrowed GEN
payments bound to a verifiable Duffel purchase, on-chain loyalty, and
AI-adjudicated one-shot dispute refunds with booking-specific evidence.

## Layout

```
contracts/travel_agent.py   GenLayer Intelligent Contract (Python) — 9-arg bound book, evidence-gated settlement
tests/                      Direct Mode tests on real GenVM (10 tests, no GenLayer mocks)
frontend/                   React + Vite app (Book → 9-arg seal, wallet-signed)
server/                     Express quote + reserve/status proxy (fare -> GEN, booking-provider, Aviationstack)
booking-provider/           Duffel booking service — real offer_requests→orders (no HMAC fallback)
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
python -m pytest tests -v   # 10 passed: binding, reuse, window, evidence, owner, dispute
```

Frontend + servers (live mode needs provider keys in `server/.env` and `booking-provider/.env`):

```
# Terminal 1 — booking provider (real Duffel orders)
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

### 2. Live booking — Duffel, no demo fallback

`POST /api/reserve` on `travity-server` forwards `{from,to,depart,ret,passenger,itinerary_json}` to `travity-booking-provider` `POST /book`, which creates a **real Duffel order** (`POST https://api.duffel.com/air/offer_requests` → `POST /air/orders` with `selected_offers:[off_…]` and `passenger pas_…`, paid from Duffel balance). It returns `{ref, offerId, duffelOrderId, passengerId, itinerary_json, refundPolicy}` — verifiable at `api.duffel.com/air/orders/{id}`. No HMAC fallback: without `DUFFEL_API_KEY` the provider returns `503` and `POST /api/reserve` returns `502`.

Set in `booking-provider/.env` / Render `travity-booking-provider`: `DUFFEL_API_KEY=duffel_test_…`. Set in `server/.env` / Render `travity-server`: `BOOKING_PROVIDER_URL=https://travity-booking-provider.onrender.com/book` (prod) and `AVIATIONSTACK_KEY` for independent `flight_status` enrichment.

### 3. Live on-chain + wallet — GenLayer Studio

1. Deploy the contract from GenLayer Studio and copy its address.
2. Copy `frontend/.env.example` to `frontend/.env`; set
   `VITE_GENLAYER_CONTRACT_ADDRESS` (RPC defaults to Studionet `https://studio.genlayer.com/api`, chainId `61999`).
   Set `VITE_QUOTE_API` to the public `travity-server` origin — owner must call `set_feed_url` with this same value so validators fetch `/quote` + `/provider-status` from a reachable HTTPS host.
3. Owner calls `set_provider` (payout address) and `set_feed_url` — both required before `book`/`settle`/`escalate`.
4. Optional: set `VITE_WC_PROJECT_ID` (free at cloud.walletconnect.com) to get
   a WalletConnect QR on mobile; otherwise an injected wallet (Rabby/MetaMask)
   is used.
5. On the Book/Disputes pages connect your wallet — writes are signed by you
   on Studionet via `genlayer-js`. `POST /api/reserve` must be called first; the returned `ref/off_/ord_/pas_/itinerary_json` are sealed together with the escrow in `book`.

Deployed contracts (Studionet):
- `0x601e602C50bc2048ac8033C21e16Ce4D3712e48D` — current `7283abb` 9-arg bound booking (use this)
- `0x774eFD6bB076fCB270e1bb596d8c0335e5895D27` — legacy 5-arg (kept for reference)

The contract exposes: `refresh_quote` (web price consensus), `book(origin,destination,depart,ret,ref,off_…,ord_…,pas_…,itinerary_json)` (seals quoted itinerary + passenger + offer + ref + escrow; `ref`/`order` globally unique, `2×` grief cap, overpayment → loyalty), `settle_booking` (permissionless but 6h after 23:59:59 UTC of return + booking-specific `provider-status` evidence `ref`+`order`+`passenger`+`offer`+`itinerary_json`+`status==completed`/`aviation.landed` via `prompt_comparative`), `force_complete` (owner-only but same 6h window + evidence, cannot bypass `disputed`), `file_dispute`/`escalate` (one-shot AI refund with `refund_policy` + `aviation.flight_status`), `balance_of`, `view_booking`/`view_dispute`/`view_provider_config`.

## Security

See `docs/security.md`. Highlights: 9-arg bound booking (quoted itinerary + `pas_…` + `off_…` + `ord_…` + `ref` + escrow) before purchase; `ref`/`order` global reuse blocked; consensus-checked quotes and rulings (`prompt_comparative` 5%/10%); settlement verifies booking-specific `provider-status` (`duffel-live`/`aviationstack`) + 6h dispute window, owner cannot bypass; checks-effects-interactions; input validation; dispute rate limit (10m) + settlement window (6h); owner-only pause/kill; rate-limited server proxy (no direct client-to-provider calls in production).
