# Travity

Travity is a GenLayer-powered travel agent: live web fares, escrowed GEN
payments, on-chain loyalty credit accounting, and AI-adjudicated one-shot
dispute refunds.

## Layout

```
contracts/travel_agent.py   GenLayer Intelligent Contract (Python)
tests/                      Contract tests (mocked genlayer SDK)
frontend/                   React + Vite app
server/                     Express quote server (fare -> GEN, rate limited)
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
python -m pytest tests -v
```

Frontend + quote server (live quotes require a fare-provider key in `server/.env`):

```
# Terminal 1 — quote server
cd server && npm install && npm run dev     # http://127.0.0.1:8080

# Terminal 2 — frontend (proxies /api to the server)
cd frontend && npm install && npm run dev   # http://localhost:5173
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
- `kiwi` — Kiwi.com Tequila (invitation-only for new devs since 2024; use only
  if you already have a key).
- `omkarcloud` — OmkarCloud Expedia scraper (`free tier: 100 requests/month` at
  `omkar.cloud` → `OMKAR_API_KEY`).

While the chosen provider is down, the server returns a clear 503 (or a stale,
clearly-marked cached quote) — it never fabricates a price or silently switches
sources.

1. Copy `server/.env.example` to `server/.env`; set `QUOTE_PROVIDER`, the
   matching provider key, plus `GEN_USD_RATE` (the server also probes
   CoinGecko first — currently GEN has no listing, so the env rate is the
   reliable source).
2. Restart the server. `GET /api/quote?from=JFK&to=LHR&depart=YYYYMMDD&ret=…`
   returns the cheapest real outbound fare converted to GEN wei. With no
   provider configured the server returns 503 — it never fabricates a price.

### 2. Live on-chain + wallet — GenLayer Studio

1. Deploy the contract from GenLayer Studio and copy its address.
2. Copy `frontend/.env.example` to `frontend/.env`; set
   `VITE_GENLAYER_CONTRACT_ADDRESS` (RPC defaults to Studionet).
3. Optional: set `VITE_WC_PROJECT_ID` (free at cloud.walletconnect.com) to get
   a WalletConnect QR on mobile; otherwise an injected wallet (Rabby/MetaMask)
   is used.
4. On the Book/Disputes pages connect your wallet — writes are signed by you
   on Studionet via `genlayer-js`.

Deployed contract (Studionet):
`0x309b0d59fff1a9203a116f000F533A45cd2eE820`

The contract intentionally exposes: `refresh_quote` (web price via validator
consensus), `book` (payable escrow + overpayment credit), `settle_booking`
(permissionless deterministic settlement once the return date passes) and
`force_complete` (owner override), `file_dispute` / `escalate` (one-shot
AI-adjudicated refund), `balance_of` (internal loyalty-credit balance — not
withdrawable or transferable), and `view_provider_config`.

## Security

See `docs/security.md`. Highlights: consensus-checked quotes and rulings,
checks-effects-interactions ordering, input validation, dispute rate limits,
owner-only pause/kill, and a rate-limited server-side quote proxy (no direct
client-to-contract quote calls in production).