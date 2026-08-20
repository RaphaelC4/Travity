import { useState } from "react";
import { client, fmtGen } from "../lib/genlayer";
import { useWallet } from "../hooks/useWallet";

const OWNER = String(import.meta.env.VITE_GENLAYER_OWNER_ADDRESS || "").trim();
const FEED_URL = String(import.meta.env.VITE_QUOTE_API || "").trim().replace(/\/+$/, "");

// Hard blockers: unusable as a feed no matter what.
function hardBlock() {
  if (!FEED_URL) return "VITE_QUOTE_API is empty — set it to the public HTTPS server origin and rebuild.";
  if (!/^https:\/\/[^/]+/.test(FEED_URL)) return "VITE_QUOTE_API must be an https:// URL.";
  if (/localhost|127\.0\.0\.1|0\.0\.0\.0/i.test(FEED_URL)) return "GenLayer validators cannot reach localhost. Deploy the server publicly first.";
  return null;
}

// Soft warnings: usable, but the feed breaks on server restart.
function softWarnings() {
  const out = [];
  if (/\btrycloudflare\.com\b/i.test(FEED_URL)) out.push("trycloudflare.com is ephemeral: the URL changes on every server restart, so the feed breaks until you update VITE_QUOTE_API and set it again. Use a stable host for a persistent feed.");
  return out;
}

/** Owner-only admin control: call set_feed_url with the value of
 * VITE_QUOTE_API. Never rendered for visitors — it appears only when the
 * connected wallet matches VITE_GENLAYER_OWNER_ADDRESS (the contract owner
 * does the deploy → it "just works" when the app owner is signed in). */
export function OwnerFeedPanel() {
  const wallet = useWallet();
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null);
  const [done, setDone] = useState(false);

  const isOwner = wallet.status === "connected" && wallet.account?.toLowerCase() === OWNER.toLowerCase();

  // Provider settlement address + auth token: typed in at runtime, never
  // baked into the build. An address isn't secret, but the token would be
  // bundled into the public JS if it ever went through import.meta.env —
  // both live in local component state only, entered by the owner per
  // session. This must stay below the OWNER/isOwner check for hooks order,
  // but the check itself happens after, same as the feed panel below.
  const [providerAddr, setProviderAddr] = useState("");
  const [providerToken, setProviderToken] = useState("");
  const [providerBusy, setProviderBusy] = useState(false);
  const [providerDone, setProviderDone] = useState({ addr: false, token: false });

  const [reagree, setReagree] = useState({ origin: "", destination: "", depart: "", ret: "" });
  const [reagreeBusy, setReagreeBusy] = useState(false);
  const [reagreeAgreed, setReagreeAgreed] = useState(null);

  if (!OWNER || !client.live || !isOwner) return null;

  const block = hardBlock();
  const warns = softWarnings();

  const showToast = (msg, kind = "status") => setToast({ msg, kind });

  async function setFeed() {
    setBusy(true);
    setDone(false);
    try {
      const pushed = await client.setFeedUrl(FEED_URL, wallet.account, wallet.provider);
      setDone(true);
      showToast(`Feed set to ${pushed}`, "status");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Could not set feed URL.", "alert");
    } finally {
      setBusy(false);
    }
  }

  async function setProviderAddress() {
    setProviderBusy(true);
    try {
      const pushed = await client.setProvider(providerAddr, wallet.account, wallet.provider);
      setProviderDone((s) => ({ ...s, addr: true }));
      showToast(`Settlement payout address set to ${pushed}`, "status");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Could not set provider address.", "alert");
    } finally {
      setProviderBusy(false);
    }
  }

  async function setProviderAuthToken() {
    setProviderBusy(true);
    try {
      await client.setProviderAuth(providerToken, wallet.account, wallet.provider);
      setProviderDone((s) => ({ ...s, token: true }));
      setProviderToken("");
      showToast("Provider auth token set.", "status");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Could not set provider auth token.", "alert");
    } finally {
      setProviderBusy(false);
    }
  }

  const reagreeInputsValid =
    /^[A-Za-z]{3}$/.test(reagree.origin.trim()) &&
    /^[A-Za-z]{3}$/.test(reagree.destination.trim()) &&
    /^\d{8}$/.test(String(reagree.depart).trim()) &&
    /^\d{8}$/.test(String(reagree.ret).trim());

  async function reAgreePrice() {
    if (!reagreeInputsValid) return;
    setReagreeBusy(true);
    setReagreeAgreed(null);
    try {
      const priceWei = await client.refreshQuote(
        reagree.origin, reagree.destination,
        reagree.depart, reagree.ret,
        wallet.account, wallet.provider
      );
      setReagreeAgreed(priceWei);
      showToast(
        priceWei ? `Price re-agreed: ${fmtGen(priceWei)}` : "Price re-agreed (read it back via a quote to confirm).",
        "status"
      );
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Could not re-agree price.", "alert");
    } finally {
      setReagreeBusy(false);
    }
  }

  return (
    <section className="section-tight" aria-labelledby="owner-feed-heading">
      <div className="container">
        <div className="panel">
          <h2 id="owner-feed-heading">Owner · Contract feed</h2>
          <p style={{ margin: "12px 0", color: "var(--ink-soft)" }}>
            Target feed (from <span className="mono">VITE_QUOTE_API</span>):
          </p>
          <p className="mono" style={{ margin: "4px 0 12px", wordBreak: "break-all" }}>
            {FEED_URL || <em>not configured</em>}
          </p>
          {block ? (
            <p style={{ color: "var(--amber-ink)", margin: "4px 0", fontSize: "0.85rem" }}>{block}</p>
          ) : (
            warns.map((w) => (
              <p key={w} style={{ color: "var(--amber-ink)", margin: "4px 0", fontSize: "0.85rem" }}>
                {w}
              </p>
            ))
          )}
          <button
            type="button"
            className="btn btn-accent"
            onClick={setFeed}
            disabled={busy || Boolean(block)}
            title="Call set_feed_url with VITE_QUOTE_API"
          >
            {busy ? "Setting feed…" : done ? "Feed set ✓" : "Set feed URL on contract"}
          </button>
          <p style={{ margin: "10px 0 0", color: "var(--ink-soft)", fontSize: "0.85rem" }}>
            This calls owner-only <span className="mono">set_feed_url</span>. It does not change the server or
            redeploy the contract.
          </p>
        </div>

        <div className="panel" style={{ marginTop: 24 }}>
          <h2 id="owner-provider-heading">Owner · Settlement &amp; authentication</h2>
          <p style={{ margin: "12px 0", color: "var(--ink-soft)" }}>
            <span className="mono">confirm_completion</span> and <span className="mono">escalate</span> both
            refuse to run until these two are set. Neither is bundled from an env var — type them in below,
            per session, so the auth token never ends up in the public JS build.
          </p>

          <div className="form-field" style={{ marginTop: 12 }}>
            <label htmlFor="provider-addr">Settlement payout address (carrier/agency)</label>
            <input
              id="provider-addr"
              className="mono"
              value={providerAddr}
              onChange={(e) => setProviderAddr(e.target.value)}
              placeholder="0x…"
              autoComplete="off"
            />
          </div>
          <button
            type="button"
            className="btn btn-accent"
            onClick={setProviderAddress}
            disabled={providerBusy || !/^0x[0-9a-fA-F]{40}$/.test(providerAddr.trim())}
            title="Call set_provider"
            style={{ marginTop: 8 }}
          >
            {providerBusy ? "Setting…" : providerDone.addr ? "Payout address set ✓" : "Set payout address"}
          </button>

          <div className="form-field" style={{ marginTop: 20 }}>
            <label htmlFor="provider-token">Provider bearer token</label>
            <input
              id="provider-token"
              type="password"
              value={providerToken}
              onChange={(e) => setProviderToken(e.target.value)}
              placeholder="min. 8 characters"
              autoComplete="off"
            />
            <p className="hint" style={{ marginTop: 4 }}>
              Stored on-chain in plaintext (see docs/security.md) — use a low-privilege, rotatable,
              status-read-only token, never a token with write access on the provider's own API.
            </p>
          </div>
          <button
            type="button"
            className="btn btn-accent"
            onClick={setProviderAuthToken}
            disabled={providerBusy || providerToken.trim().length < 8}
            title="Call set_provider_auth"
            style={{ marginTop: 8 }}
          >
            {providerBusy ? "Setting…" : providerDone.token ? "Auth token set ✓" : "Set auth token"}
          </button>
        </div>

        <div className="panel" style={{ marginTop: 24 }}>
          <h2 id="owner-reagree-heading">Owner · Re-agree price</h2>
          <p style={{ margin: "12px 0", color: "var(--ink-soft)" }}>
            Forces <span className="mono">refresh_quote</span> to re-fetch and re-agree a live price for a
            route + dates. Use after the feed URL or the server's GEN/USD rate changed: the frontend
            otherwise pays the <em>old on-chain agreed price</em> (a stale inflated agreement keeps
            driving the escrow). This overwrites it with a fresh agreed price.
          </p>
          <div className="form-grid" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div className="form-field">
              <label htmlFor="rag-from">From (IATA)</label>
              <input id="rag-from" className="mono" value={reagree.origin} onChange={(e) => setReagree((s) => ({ ...s, origin: e.target.value }))} placeholder="JFK" autoComplete="off" />
            </div>
            <div className="form-field">
              <label htmlFor="rag-to">To (IATA)</label>
              <input id="rag-to" className="mono" value={reagree.destination} onChange={(e) => setReagree((s) => ({ ...s, destination: e.target.value }))} placeholder="LHR" autoComplete="off" />
            </div>
            <div className="form-field">
              <label htmlFor="rag-depart">Departure (YYYYMMDD)</label>
              <input id="rag-depart" className="mono" inputMode="numeric" value={reagree.depart} onChange={(e) => setReagree((s) => ({ ...s, depart: e.target.value }))} placeholder="20260901" />
            </div>
            <div className="form-field">
              <label htmlFor="rag-ret">Return (YYYYMMDD)</label>
              <input id="rag-ret" className="mono" inputMode="numeric" value={reagree.ret} onChange={(e) => setReagree((s) => ({ ...s, ret: e.target.value }))} placeholder="20260908" />
            </div>
          </div>
          <button
            type="button"
            className="btn btn-accent"
            onClick={reAgreePrice}
            disabled={reagreeBusy || !reagreeInputsValid}
            title="Call refresh_quote"
            style={{ marginTop: 12 }}
          >
            {reagreeBusy ? "Re-agreeing…" : "Re-agree price on-chain"}
          </button>
          {reagreeAgreed != null && (
            <p className="mono" style={{ marginTop: 8, color: "var(--ink-soft)" }}>
              new agreed price: {fmtGen(reagreeAgreed)}
            </p>
          )}
        </div>
      </div>
      {toast && (
        <div className="toast" role={toast.kind === "alert" ? "alert" : "status"}>
          {toast.msg}
        </div>
      )}
    </section>
  );
}

export default OwnerFeedPanel;
