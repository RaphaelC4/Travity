# Travity frontend

React + Vite reference site and app pages. See the repo `README.md` for the
full picture. Run locally with `npm run dev`, lint with `npm run lint`, build
with `npm run build`.

The dev script proxies `/api` and `/quote` to the quote server on
`http://127.0.0.1:8080` (see `vite.config.js`), so start `server/` first.

## Modes

- **Live quotes:** start `server/` with a fare-provider key — `getQuote`
  goes through the rate-limited `/api/quote` proxy (Expedia -> USD -> GEN wei).
  The server never fabricates a price; missing keys returns 503.
- **Live on-chain + wallet:** copy `.env.example` to `.env` and set
  `VITE_GENLAYER_CONTRACT_ADDRESS` (from GenLayer Studio). Writes
  (book / verify / file dispute / escalate) are then signed by the connected
  wallet through `genlayer-js` on Studionet. WalletConnect QR is used when
  `VITE_WC_PROJECT_ID` is set, otherwise an injected wallet extension.

## Wallet

`src/lib/wallet.js` returns an EIP-1193 provider + account (WalletConnect QR
or injected), which is handed to `createClient({ ..., account, provider })`
for writes. `client.connect()`/Studionet chain handling happens inside
`genlayer-js`; values are BigInt wei end to end (`fmtGen` renders GEN).
