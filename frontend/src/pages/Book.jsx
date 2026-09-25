import { useEffect, useState } from "react";
import { client, fmtGen, fmtUsd } from "../lib/genlayer";
import { useWallet } from "../hooks/useWallet";
import { WalletButton } from "../components/WalletButton";

const BOOK_KEY = "travity.book.v1";

const TRAVELER_FIELDS = ["given_name", "family_name", "born_on", "gender", "title", "email", "phone_number"];
const emptyTraveler = () => ({ given_name: "", family_name: "", born_on: "", gender: "", title: "", email: "", phone_number: "" });

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
        traveler: { ...emptyTraveler(), ...((raw.form?.traveler && typeof raw.form.traveler === "object") ? raw.form.traveler : {}) },
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
  const [form, setForm] = useState(() => {
    const base = restored?.form ?? { origin: "JFK", destination: "LHR", depart: "", ret: "" };
    const t = base.traveler && typeof base.traveler === "object" ? base.traveler : {};
    return { ...base, traveler: { ...emptyTraveler(), ...t } };
  });
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

  useEffect(() => {
    // Sync with on-chain status (held/confirmed/completed) on mount and after writes
    let cancelled = false;
    (async () => {
      try {
        const list = await client.bookings();
        if (cancelled) return;
        if (booking && list.length) {
          const live = list.find((b) => b.id === booking.id || b.onChainId === booking.id);
          if (live && live.status && live.status !== booking.status) {
            setBooking((prev) => prev ? { ...prev, status: live.status, completion: live.completion, reservationRef: live.reservationRef || prev.reservationRef } : prev);
          }
        }
      } catch {}
    })();
    return () => { cancelled = true; };
  }, []);

  const set = (k) => (e) => {
    setErrors((prev) => ({ ...prev, [k]: undefined }));
    setForm((f) => ({ ...f, [k]: e.target.value }));
  };

  const setTraveler = (k) => (e) => {
    const v = e.target.value;
    setErrors((prev) => ({ ...prev, [`traveler.${k}`]: undefined }));
    setForm((f) => ({ ...f, traveler: { ...f.traveler, [k]: v } }));
  };

  const validateTraveler = (t) => {
    const errs = {};
    for (const f of TRAVELER_FIELDS) {
      if (!String(t?.[f] ?? "").trim()) errs[`traveler.${f}`] = "Required.";
    }
    if (t?.born_on && Number.isNaN(Date.parse(t.born_on))) errs["traveler.born_on"] = "Must be a valid date (YYYY-MM-DD).";
    if (t?.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(t.email)) errs["traveler.email"] = "Invalid email.";
    return errs;
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
    const tErrs = validateTraveler(form.traveler);
    if (Object.keys(tErrs).length > 0) {
      setErrors((prev) => ({ ...prev, ...tErrs }));
      showToast("Booking failed: traveler details are incomplete.", "alert");
      return;
    }
    setBusy(true);
    try {
      // Two-step: 1) hold offer (no Duffel charge), 2) escrow on-chain, 3) purchase Duffel, 4) seal receipt
      // Pre-flight first: a quote restored from localStorage can look live while the server is down.
      try {
        const base = (import.meta.env.VITE_QUOTE_API || "").replace(/\/+$/, "");
        await fetch(`${base}/health`, { headers: { Accept: "application/json" } });
      } catch {
        throw Object.assign(
          new Error(
            "Quote server unreachable — the price shown may be a cached quote. " +
            "Start the server (`cd server && npm run dev`) or wait ~30s for the Render free tier to wake, then Get quote again before booking."
          ),
          { code: "SERVER_UNREACHABLE", status: 0 }
        );
      }
      let hold;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          hold = await client.createReservation({
            origin: form.origin, destination: form.destination,
            depart: form.depart, ret: form.ret,
            passenger: { ...form.traveler },
          });
          break;
        } catch (e) {
          const is429 = e.status === 429 || /429/.test(e.message || "");
          if (is429 && attempt < 2) {
            const waitS = Math.max(3, Math.min(60, parseInt(e.retryAfter, 10) || 5));
            showToast(`Duffel is busy (429) — retrying in ${waitS}s… (attempt ${attempt + 2}/3)`, "status");
            await new Promise((r) => setTimeout(r, waitS * 1000));
            continue;
          }
          throw e;
        }
      }
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
      // Purchase Duffel after escrow is locked (dual-auth: wallet identity, operator cron uses bearer)
      const walletSig = await client.signConfirmPurchase({ bookingId: holdRes.id, offerId, account: wallet.account, provider: wallet.provider });
      const base = (import.meta.env.VITE_QUOTE_API || "").replace(/\/+$/, "");
      const confRes = await fetch(`${base}/api/confirm-purchase`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Wallet-Address": wallet.account,
          "X-Wallet-Signature": walletSig,
        },
        body: JSON.stringify({ bookingId: holdRes.id, offerId, passengerId: pasId }),
      });
      const confJson = await confRes.json().catch(() => ({}));
      if (!confRes.ok) throw new Error(confJson.error || `Duffel purchase failed (${confRes.status})`);
      const orderId = String(confJson.duffelOrderId || confJson.orderId || "");
      const locator = String(confJson.locator || "");
      if (!orderId || !locator) throw new Error("Confirm purchase failed — no order/locator returned");
      await client.confirmPurchase({ bookingId: holdRes.id, orderId, locator, account: wallet.account, provider: wallet.provider });
      const sealedRef = locator.toUpperCase();
      setBooking({ id: holdRes.id, route: quote.route, priceWei: holdRes.agreedWei, reservationRef: sealedRef, status: "confirmed", completion: false });
      // pull live confirmed status to ensure chain view matches
      try { const live = await client.bookings(); const found = live.find((b) => b.id === holdRes.id); if (found) setBooking((prev) => ({ ...prev, status: found.status || "confirmed" })); } catch {}
      setQuote(null);
      showToast(`Trip booked (PNR ${sealedRef}): fare escrowed at the on-chain agreed price (network gas was charged separately).`, "status");
    } catch (err) {
      showToast(
        err.code === "SERVER_UNREACHABLE" || err.status === 0
          ? "Booking failed: server unreachable. " + (err.message || "")
          : "Booking failed: " + (err.message || "unknown error"),
        "alert"
      );
    } finally {
      setBusy(false);
    }
  }

  async function verifyTrip() {
    if (!booking) return;
    setBusy(true);
    try {
      // Settlement verifies booking-specific completed evidence (duffel-live/aviation) and 6h window
      await client.settleBooking(booking.id, wallet.account, wallet.provider);
      setBooking((b) => ({ ...b, done: true, status: "completed", completion: true }));
      try { const live = await client.bookings(); const found = live.find((x) => x.id === booking.id); if (found) setBooking((prev) => ({ ...prev, status: found.status, completion: found.completion })); } catch {}
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
            <h2>Traveler details</h2>
            <p className="hint">Ticketed verbatim on the Duffel order — no placeholders.</p>
            <div className="form-row two">
              <div className="form-field">
                <label htmlFor="t-given">Given name</label>
                <input id="t-given" value={form.traveler.given_name} onChange={setTraveler("given_name")} autoComplete="given-name" />
                {errors["traveler.given_name"] && <p className="err-msg" role="alert">{errors["traveler.given_name"]}</p>}
              </div>
              <div className="form-field">
                <label htmlFor="t-family">Family name</label>
                <input id="t-family" value={form.traveler.family_name} onChange={setTraveler("family_name")} autoComplete="family-name" />
                {errors["traveler.family_name"] && <p className="err-msg" role="alert">{errors["traveler.family_name"]}</p>}
              </div>
            </div>
            <div className="form-row three">
              <div className="form-field">
                <label htmlFor="t-dob">Born on (YYYY-MM-DD)</label>
                <input id="t-dob" value={form.traveler.born_on} onChange={setTraveler("born_on")} placeholder="1990-01-01" autoComplete="bday" />
                {errors["traveler.born_on"] && <p className="err-msg" role="alert">{errors["traveler.born_on"]}</p>}
              </div>
              <div className="form-field">
                <label htmlFor="t-gender">Gender (m/f)</label>
                <input id="t-gender" value={form.traveler.gender} onChange={setTraveler("gender")} maxLength={1} autoComplete="off" />
                {errors["traveler.gender"] && <p className="err-msg" role="alert">{errors["traveler.gender"]}</p>}
              </div>
              <div className="form-field">
                <label htmlFor="t-title">Title (mr/ms)</label>
                <input id="t-title" value={form.traveler.title} onChange={setTraveler("title")} maxLength={4} autoComplete="honorific-prefix" />
                {errors["traveler.title"] && <p className="err-msg" role="alert">{errors["traveler.title"]}</p>}
              </div>
            </div>
            <div className="form-row two">
              <div className="form-field">
                <label htmlFor="t-email">Email</label>
                <input id="t-email" type="email" value={form.traveler.email} onChange={setTraveler("email")} autoComplete="email" />
                {errors["traveler.email"] && <p className="err-msg" role="alert">{errors["traveler.email"]}</p>}
              </div>
              <div className="form-field">
                <label htmlFor="t-phone">Phone</label>
                <input id="t-phone" value={form.traveler.phone_number} onChange={setTraveler("phone_number")} autoComplete="tel" />
                {errors["traveler.phone_number"] && <p className="err-msg" role="alert">{errors["traveler.phone_number"]}</p>}
              </div>
            </div>
          </div>

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
                <div className="list-line"><span className="k">Status</span><span className="v"><span className={`pill ${booking.status === "completed" ? "pill-completed" : booking.status === "held" ? "pill-held" : "pill-accepted"}`}>{(booking.status || (booking.done ? "completed" : "confirmed")).toUpperCase()}</span></span></div>
                {(booking.status !== "completed" && !booking.done) ? (
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
                  <span className={`step ${booking.status === "held" ? "is-active" : ""}`}><b>1</b> Held</span><span className="connector" aria-hidden="true" />
                  <span className={`step ${booking.status === "confirmed" ? "is-active" : booking.status === "completed" ? "" : ""}`}><b>2</b> Confirmed</span><span className="connector" aria-hidden="true" />
                  <span className={`step ${booking.status === "completed" || booking.done ? "is-active" : ""}`}><b>3</b> Completed</span>
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
