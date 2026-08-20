import { useState } from "react";
import { useWallet } from "../hooks/useWallet";
import { shortAddress } from "../lib/wallet";

/**
 * Connect wallet button. Shows a short address + disconnect when connected.
 * WalletConnect QR (mobile) or injected provider, per lib/wallet.js.
 */
export function WalletButton({ label = "Connect wallet", className = "", onError }) {
  const { status, account, connect, disconnect } = useWallet();
  const [busy, setBusy] = useState(false);

  if (status === "connected") {
    return (
      <span className="wallet-connected">
        <button
          type="button"
          className="btn btn-secondary wallet-btn wallet-addr"
          title={account}
          aria-label={`Connected wallet ${account}`}
          disabled
        >
          <span className="dot" aria-hidden="true" />
          {shortAddress(account)}
        </button>
        <button
          type="button"
          className="btn wallet-btn wallet-disconnect"
          onClick={disconnect}
          aria-label="Disconnect wallet"
        >
          Disconnect
        </button>
      </span>
    );
  }

  return (
    <button
      type="button"
      className={`btn btn-primary wallet-btn ${className}`}
      onClick={async () => {
        setBusy(true);
        try {
          await connect();
        } catch (err) {
          onError?.(err instanceof Error ? err.message : "Wallet connection failed.");
        } finally {
          setBusy(false);
        }
      }}
      disabled={busy}
    >
      {busy ? "Connecting…" : label}
    </button>
  );
}