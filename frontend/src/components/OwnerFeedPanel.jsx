import { useState } from "react";
import { client } from "../lib/genlayer";
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