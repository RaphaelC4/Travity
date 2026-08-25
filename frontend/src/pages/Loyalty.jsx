import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { client, fmtGen } from "../lib/genlayer";
import { useWallet } from "../hooks/useWallet";

export default function Loyalty() {
  const { status, account } = useWallet();
  const live = client.live;
  const cached = client.cachedBalance(live ? account : undefined);
  const [balance, setBalance] = useState(cached ?? 0n);
  const [bookings, setBookings] = useState([]);

  useEffect(() => {
    let alive = true;
    (async () => {
      // Load balance and trips independently: a failed on-chain read on
      // Studionet (30 reads/min rate limit) or a transient error must not
      // blank the whole page and drop the persisted trips list.
      try {
        const bal = await client.balance(live ? account : undefined);
        if (alive) setBalance(bal);
      } catch {
        /* keep cached balance */
      }
      try {
        const list = await client.bookings();
        if (alive) setBookings(list);
      } catch {
        /* keep stored trips on the next mount */
      }
    })();
    return () => { alive = false; };
  }, [live, account]);

  return (
    <>
      <section className="app-hero">
        <div className="container">
          <p className="eyebrow">Loyalty</p>
          <h1>Credits that add up</h1>
          <p className="lede">
            Every settled trip and every overpayment refund adds credits to
            your on-chain account automatically.
          </p>
        </div>
      </section>

      <section className="container page-grid">
        <div>
          <div className="panel">
            <h2>Your balance</h2>
            <p style={{ fontSize: "2.2rem", fontWeight: 800, color: "var(--forest)", margin: "8px 0" }}>
              {fmtGen(balance)}
            </p>
            <p style={{ color: "var(--ink-soft)", margin: 0, fontSize: "0.9rem" }}>
              {live && status !== "connected"
                ? "Connect a wallet to read your balance."
                : "Credits accrue when a trip settles or you overpay (the difference is credited)."}
            </p>
          </div>

          <div className="panel" style={{ marginTop: 24 }}>
            <h2>Recent trips</h2>
            {bookings.length === 0 ? (
              <p style={{ color: "var(--ink-soft)" }}>
                No trips yet. Book one from the <Link to="/book">booking page</Link>.
              </p>
            ) : (
              <div className="table-scroll">
                <table className="data-table">
                  <thead>
                    <tr><th scope="col">Route</th><th scope="col">Status</th><th scope="col">Fare</th></tr>
                  </thead>
                  <tbody>
                    {bookings.map((b) => (
                      <tr key={b.id}>
                        <td className="mono">{b.route}</td>
                        <td><span className={`pill ${b.status === "completed" ? "pill-finalized" : "pill-accepted"}`}>{b.status}</span></td>
                        <td className="mono">{fmtGen(b.priceWei)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

        <aside className="panel" aria-label="Loyalty notes">
          <h2>How credits work</h2>
          <p style={{ color: "var(--ink-soft)", fontSize: "0.9rem", margin: 0 }}>
            Credits are an internal balance recorded on the contract. Today
            they can't be withdrawn as GEN or transferred between wallets —
            they're a per-account accounting of your completed trips and
            overpayment refunds, read live from the network.
          </p>
        </aside>
      </section>
    </>
  );
}