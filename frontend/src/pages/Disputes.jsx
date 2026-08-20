import { useState } from "react";
import { client, fmtGen } from "../lib/genlayer";
import { useWallet } from "../hooks/useWallet";
import { WalletButton } from "../components/WalletButton";

export default function Disputes() {
  const [bookingId, setBookingId] = useState("");
  const [reason, setReason] = useState("");
  const [errors, setErrors] = useState({});
  const [dispute, setDispute] = useState(null); // { id, bookingId, reason, status, rounds, refund }
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null);
  const wallet = useWallet();
  const live = client.live;
  const needsWallet = live && wallet.status !== "connected";

  const showToast = (msg, kind = "status") => setToast({ msg, kind });

  async function file(e) {
    e.preventDefault();
    const trimmed = reason.trim();
    if (trimmed.length < 10) {
      setErrors({ reason: "Reason must be at least 10 characters." });
      return;
    }
    setBusy(true);
    try {
      const id = await client.fileDispute(bookingId.trim(), trimmed, wallet.account, wallet.provider);
      setDispute({ id, bookingId: bookingId.trim(), reason: trimmed, status: "pending", rounds: 0, refund: null });
      setErrors({});
      showToast("Dispute filed. We're reviewing it now.");
    } catch (err) {
      showToast("Could not file: " + (err.message || "unknown error"), "alert");
    } finally {
      setBusy(false);
    }
  }

  async function escalate() {
    if (!dispute) return;
    setBusy(true);
    try {
      const d = await client.escalate(dispute.id, 0n, wallet.account, wallet.provider);
      setDispute((cur) => ({ ...cur, status: d.status, rounds: d.rounds, refund: d.refund }));
      showToast("Ruling finalized.");
    } catch (err) {
      showToast("Ruling failed: " + (err.message || "unknown error"), "alert");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <section className="app-hero">
        <div className="container">
          <p className="eyebrow">Disputes</p>
          <h1>Fast, fair answers</h1>
          <p className="lede">
            File a claim and it's reviewed automatically against your booking
            details. If it's upheld, your refund is capped at the fare you paid.
          </p>
        </div>
      </section>

      <section className="container page-grid">
        <div>
          <form className="panel" onSubmit={file} noValidate>
            <h2>File a dispute</h2>
            <div className="form-field">
              <label htmlFor="bid">Booking reference</label>
              <input id="bid" value={bookingId} onChange={(e) => setBookingId(e.target.value)} placeholder="JFK-SFO-20261201-20261210-0xc048310B6AD26D7cf35eF068A83CBe6793864Fd1" className="mono" aria-describedby="bid-hint" />
            </div>
            <p className="hint" id="bid-hint">Paste the booking id shown after your last successful booking — it ends in your checksummed address.</p>
            <div className={`form-field ${errors.reason ? "is-error" : ""}`}>
              <label htmlFor="reason">Why are you disputing?</label>
              <textarea id="reason" rows={4} value={reason} onChange={(e) => setReason(e.target.value)} aria-describedby="reason-hint" />
              <p className="hint" id="reason-hint">10-500 characters. Example: "Departure delayed beyond policy window."</p>
              {errors.reason && <p className="err-msg" role="alert">{errors.reason}</p>}
            </div>
            {needsWallet ? (
              <WalletButton label="Connect a wallet to file" onError={(m) => showToast(m, "alert")} />
            ) : (
              <button className="btn btn-primary" type="submit" disabled={busy}>
                {busy ? "Filing…" : "File dispute"}
              </button>
            )}
          </form>

          {dispute && (
            <div className="panel" style={{ marginTop: 24 }} role="status">
              <h2>Dispute {dispute.id}</h2>
              <div className="list-line"><span className="k">Booking</span><span className="v mono">{dispute.bookingId}</span></div>
              <div className="list-line"><span className="k">Status</span>
                <span className="v">
                  <span className={`pill ${dispute.status === "pending" ? "pill-pending" : "pill-finalized"}`}>{dispute.status.toUpperCase()}</span>
                </span>
              </div>
              <div className="list-line"><span className="k">Rounds</span><span className="v">{dispute.rounds}</span></div>
              {dispute.refund !== null && (
                <div className="list-line"><span className="k">Refund</span><span className="v mono">{fmtGen(dispute.refund)}</span></div>
              )}
              <div className="lifecycle" aria-label="Dispute lifecycle">
                <span className={`step ${dispute.status === "pending" ? "is-active" : ""}`}><b>1</b> Pending</span><span className="connector" aria-hidden="true" />
                <span className="step is-active"><b>2</b> Accepted</span><span className="connector" aria-hidden="true" />
                <span className={`step ${dispute.status === "ruled" || dispute.status === "finalized" ? "is-active" : ""}`}><b>3</b> Finalized</span>
              </div>
              {dispute.status === "pending" && (
                needsWallet ? (
                  <div style={{ marginTop: 16 }}>
                    <WalletButton label="Connect to escalate" onError={(m) => showToast(m, "alert")} />
                  </div>
                ) : (
                  <button className="btn btn-accent" style={{ marginTop: 16 }} onClick={escalate} disabled={busy}>
                    Ask for a second review
                  </button>
                )
              )}
            </div>
          )}
        </div>

        <aside className="panel" aria-label="How disputes work">
          <h2>Lifecycle</h2>
          <p style={{ color: "var(--ink-soft)", fontSize: "0.9rem", margin: 0 }}>
            Claims move through <strong>pending → accepted → finalized</strong>.
            You can ask for a second review if you disagree. Claims that turn out
            to be fraudulent receive no refund.
          </p>
        </aside>
      </section>

      {toast && (
        <div className={`toast ${toast.kind === "alert" ? "toast-alert" : ""}`} role={toast.kind} tabIndex={-1}>
          {toast.msg}
        </div>
      )}
    </>
  );
}