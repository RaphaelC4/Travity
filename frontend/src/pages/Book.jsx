import { useEffect, useState } from "react";
import { client, fmtGen, fmtUsd } from "../lib/genlayer";
import { useWallet } from "../hooks/useWallet";
import { WalletButton } from "../components/WalletButton";

const BOOK_KEY = "travity.book.v1";

const persistBookState = (form, quote, booking) => {
  try {
    localStorage.setItem(
      BOOK_KEY,
      JSON.stringify({
        form,
        quote: quote
          ? { ...quote, escrowWei: quote.escrowWei.toString(), priceWei: quote.priceWei.toString(), agreedWei: quote.agreedWei == null ? null : quote.agreedWei.toString() }
          : null,
        booking: booking
          ? { ...booking, priceWei: booking.priceWei.toString() }
          : null,
      })
    );
  } catch {
    /* storage unavailable — session-only */
  }
};

const loadBookState = () => {
  try {
    const raw = JSON.parse(localStorage.getItem(BOOK_KEY) || "null");
    if (!raw) return null;
    return {
      form: {
        origin: String(raw.form?.origin ?? "JFK"),
        destination: String(raw.form?.destination ?? "LHR"),
        depart: String(raw.form?.depart ?? ""),
        ret: String(raw.form?.ret ?? ""),
      },
      quote: raw.quote
        ? {
            ...raw.quote,
            escrowWei: BigInt(raw.quote.escrowWei ?? 0n),
            priceWei: BigInt(raw.quote.priceWei ?? 0n),
            agreedWei: raw.quote.agreedWei == null ? null : BigInt(raw.quote.agreedWei),
          }
        : null,
      booking: raw.booking
        ? { ...raw.booking, priceWei: BigInt(raw.booking.priceWei ?? 0n) }
        : null,
    };
  } catch {
    return null;
  }
};

export default function Book() {
  const restored = loadBookState();
  const [form, setForm] = useState(restored?.form ?? { origin: "JFK", destination: "LHR", depart: "", ret: "" });
  const [errors, setErrors] = useState({});
  const [quote, setQuote] = useState(restored?.quote ?? null);
  const [quoting, setQuoting] = useState(false);
  const [booking, setBooking] = useState(restored?.booking ?? null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null);
  const wallet = useWallet();
  const live = client.live;
  const needsWallet = live && wallet.status !== "connected";

  useEffect(() => {
    persistBookState(form, quote, booking);
  }, [form, quote, booking]);

  const set = (k) => (e) => {
    setErrors((prev) => ({ ...prev, [k]: undefined }));
    setForm((f) => ({ ...f, [k]: e.target.value }));
  };

  const showToast = (msg, kind = "status") => setToast({ msg, kind });

  async function fetchQuote(e) {
    e.preventDefault();
    const origin = form.origin.trim().toUpperCase();
    const destination = form.destination.trim().toUpperCase();
    setQuote(null);
    if (!/^[A-Z]{3}$/.test(origin) || !/^[A-Z]{3}$/.test(destination) || origin === destination) {
      setErrors({ origin: "Use two distinct 3-letter IATA codes (e.g. JFK / LHR)." });
      return;
    }
    if (!form.depart || !form.ret || Number(form.ret) <= Number(form.depart)) {
      setErrors({ depart: "Return date must be after departure date." });
      return;
    }
    setQuoting(true);
    try {
      const q = await client.getQuote(origin, destination, { depart: form.depart, ret: form.ret });
      setQuote(q);
      setErrors({});
    } catch (err) {
      setErrors({ origin: err.message || "Quote failed." });
    } finally {
      setQuoting(false);
    }
  }

  async function confirmBooking() {
    if (!quote) return;
    setBusy(true);
    try {
      // Two-step: 1) hold offer (no Duffel charge), 2) escrow on-chain, 3) purchase Duffel, 4) seal receipt
      const hold = await client.createReservation({
        origin: form.origin, destination: form.destination,
        depart: form.depart, ret: form.ret,
      });
      const offerId = hold.offerId || hold.offer_id || "";
      const pasId = hold.passengerId || hold.passenger_id || "";
      const itin = hold.itineraryJson || hold.itinerary_json || "";
      if (!offerId) throw new Error("Offer hold failed — no offerId returned");
      const holdRes = await client.holdBooking({
        origin: form.origin, destination: form.destination,
        depart: form.depart, ret: form.ret,
        duffelOfferId: offerId,
        passengerId: pasId,
        itineraryJson: itin,
        paymentWei: quote.escrowWei.toString(),
        account: wallet.account,
        provider: wallet.provider,
      });
      // Purchase Duffel after escrow is locked
      const base = (import.meta.env.VITE_QUOTE_API || "").replace(/\/+$/, "");
      const confRes = await fetch(`${base}/api/confirm-purchase`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bookingId: holdRes.id, offerId, passengerId: pasId }),
      });
      const confJson = await confRes.json().catch(() => ({}));
      if (!confRes.ok) throw new Error(confJson.error || `Duffel purchase failed (${confRes.status})`);
      const orderId = String(confJson.duffelOrderId || confJson.orderId || "");
      const locator = String(confJson.locator || "");
      if (!orderId || !locator) throw new Error("Confirm purchase failed — no order/locator returned");
      await client.confirmPurchase({ bookingId: holdRes.id, orderId, locator, account: wallet.account, provider: wallet.provider });
      const sealedRef = locator.toUpperCase();
      setBooking({ id: holdRes.id, route: quote.route, priceWei: holdRes.agreedWei, reservationRef: sealedRef });
      setQuote(null);
      showToast(`Trip booked (PNR ${sealedRef}): fare escrowed at the on-chain agreed price (network gas was charged separately).`, "status");
    } catch (err) {
      showToast("Booking failed: " + (err.message || "unknown error"), "alert");
    } finally {
      setBusy(false);
    }
  }

  async function verifyTrip() {
    if (!booking) return;
    setBusy(true);
    try {
      // Settlement verifies booking-specific completed evidence via provider-status consensus
      // and respects the 6h dispute window after 23:59:59 UTC of the return day.
      await client.settleBooking(booking.id, wallet.account, wallet.provider);
      setBooking((b) => ({ ...b, done: true }));
      showToast("Trip settled: fare paid to the operator and loyalty credits minted to your wallet.", "status");
    } catch (err) {
      const msg = err?.message || "unknown error";
      showToast(
        /dispute window/i.test(msg)
          ? `Settlement blocked: ${msg} — try after 05:59 UTC on the day after return, or file a dispute if eligible.`
          : /completion evidence/i.test(msg)
          ? `Settlement blocked: ${msg} — carrier completed evidence (ref+order+passenger+itinerary) required.`
          : /return date/i.test(msg)
          ? "Settlement unlocks 6h after 23:59:59 UTC of your return day."
          : "Settlement failed: " + msg,
        "alert"
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <section className="app-hero">
        <div className="container">
          <p className="eyebrow">Book a trip</p>
          <h1>Book your trip</h1>
          <p className="lede">
            Search real-time fares, pay securely in GEN, and your payment is
            held safely until your journey is complete.
          </p>
        </div>
      </section>

      <section className="container page-grid">
        <div>
          <form className="panel" onSubmit={fetchQuote} noValidate>
            <h2>1 · Search your trip</h2>
            <div className="form-row three">
              <div className="form-field">
                <label htmlFor="origin">From (IATA)</label>
                <input id="origin" value={form.origin} onChange={set("origin")} maxLength={3} autoComplete="off" aria-describedby="origin-hint" />
                <p className="hint" id="origin-hint">3-letter code</p>
                {errors.origin && <p className="err-msg" role="alert">{errors.origin}</p>}
              </div>
              <div className="form-field">
                <label htmlFor="destination">To (IATA)</label>
                <input id="destination" value={form.destination} onChange={set("destination")} maxLength={3} autoComplete="off" />
                {errors.destination && <p className="err-msg" role="alert">{errors.destination}</p>}
              </div>
              <div className="form-field">
                <label htmlFor="quote-btn" className="sr-only">Fetch quote</label>
                <button id="quote-btn" className="btn btn-primary" type="submit" disabled={quoting}>
                  {quoting ? "Finding prices…" : "Get quote"}
                </button>
              </div>
            </div>
            <div className="form-row two">
              <div className="form-field">
                <label htmlFor="depart">Departure (YYYYMMDD)</label>
                <input id="depart" type="number" value={form.depart} onChange={set("depart")} inputMode="numeric" placeholder="20261001" />
                {errors.depart && <p className="err-msg" role="alert">{errors.depart}</p>}
              </div>
              <div className="form-field">
                <label htmlFor="ret">Return (YYYYMMDD)</label>
                <input id="ret" type="number" value={form.ret} onChange={set("ret")} inputMode="numeric" placeholder="20261010" />
              </div>
            </div>

            {quote && (
              <div role="status" className="quote-result">
                <p>
                  <strong>{quote.route}</strong>
                  {quote.agreed ? (
                    <span className="mono">{fmtGen(quote.escrowWei)}</span>
                  ) : quote.usdTotal != null ? (
                    <span className="mono quote-usd">{fmtUsd(quote.usdTotal, quote.usdCurrency)}</span>
                  ) : (
                    <span className="mono">{fmtGen(quote.escrowWei)}</span>
                  )}
                  <span className="quote-src">{quote.stale ? "cached price" : "live price"}</span>
                  <span className="quote-agreed">{quote.agreed ? "agreed on-chain" : "verified"}</span>
                </p>
                <p className="quote-fiat-hint">
                  escrow (fare) ≈ {fmtGen(quote.escrowWei)}
                  {quote.usdTotal != null && <> · {fmtUsd(quote.usdTotal, quote.usdCurrency)}</>}
                  {quote.stale && quote.staleAgeS != null
                    ? ` · cached price from ${Math.round(quote.staleAgeS / 60)} min ago (provider outage)`
                    : " · network gas is charged separately by your wallet"}
                </p>
                {quote.carrier && <p className="quote-carrier">operated by {quote.carrier}</p>}
              </div>
            )}
          </form>

          <div className="panel" style={{ marginTop: 24 }}>
            <h2>2 · Review &amp; pay</h2>
            {!quote ? (
              <p style={{ color: "var(--ink-soft)", margin: 0 }}>
                Fetch a quote above to see the escrow amount and confirm your booking.
              </p>
            ) : needsWallet ? (
              <div>
                <WalletButton label="Connect a wallet to pay" onError={(m) => showToast(m, "alert")} />
                <p className="hint" style={{ marginTop: 10 }}>
                  Live bookings are signed by your wallet on Studionet — no funds leave your control until you approve.
                </p>
              </div>
            ) : (
              <button className="btn btn-accent" onClick={confirmBooking} disabled={busy}>
                {quote.agreed
                  ? `Pay ${fmtGen(quote.escrowWei)} and book`
                  : `Pay ${quote.usdTotal != null ? fmtUsd(quote.usdTotal, quote.usdCurrency) : fmtGen(quote.escrowWei)} and book`}
              </button>
            )}

            {booking && (
              <div role="status" style={{ marginTop: 16 }}>
                <div className="list-line"><span className="k">Booking</span><span className="v mono">{booking.id}</span></div>
                {booking.reservationRef && (
                  <div className="list-line"><span className="k">Reservation ref</span><span className="v mono">{booking.reservationRef}</span></div>
                )}
                <div className="list-line"><span className="k">Status</span><span className="v"><span className="pill pill-accepted">CONFIRMED</span></span></div>
                {!booking.done ? (
                  needsWallet ? (
                    <WalletButton label="Connect to settle trip" onError={(m) => showToast(m, "alert")} />
                  ) : (
                    <>
                      <button className="btn btn-secondary" style={{ marginTop: 16 }} onClick={verifyTrip} disabled={busy}>
                        Settle completed trip
                      </button>
                      <p className="hint" style={{ marginTop: 6 }}>
                        Settlement unlocks 6h after 23:59:59 UTC of your return day and requires carrier completed evidence — otherwise file a dispute.
                      </p>
                    </>
                  )
                ) : (
                  <div className="list-line"><span className="k">Rewards</span><span className="v">Loyalty minted</span></div>
                )}
                <div className="lifecycle" aria-label="Booking lifecycle">
                  <span className={`step ${booking.done ? "" : "is-active"}`}><b>1</b> Pending</span><span className="connector" aria-hidden="true" />
                  <span className="step is-active"><b>2</b> Accepted</span><span className="connector" aria-hidden="true" />
                  <span className={`step ${booking.done ? "is-active" : ""}`}><b>3</b> Finalized</span>
                </div>
              </div>
            )}
          </div>
        </div>

        <aside className="panel" aria-label="How booking works">
          <h2>How it works</h2>
          <div className="list-line"><span className="k">Quote</span><span className="v">real-time price</span></div>
          <div className="list-line"><span className="k">Fare</span><span className="v">held safely</span></div>
          <div className="list-line"><span className="k">Verification</span><span className="v">deterministic, on-chain</span></div>
          <div className="list-line"><span className="k">Reward</span><span className="v">added automatically</span></div>
          <p style={{ marginTop: 16, color: "var(--ink-soft)", fontSize: "0.9rem" }}>
            Prices are verified automatically — you only ever pay the fare you
            agreed to.
          </p>
        </aside>
      </section>

      {toast && (
        <div
          className={`toast ${toast.kind === "alert" ? "toast-alert" : ""}`}
          role={toast.kind}
          tabIndex={-1}
        >
          {toast.msg}
        </div>
      )}
    </>
  );
}
