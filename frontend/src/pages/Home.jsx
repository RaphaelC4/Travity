import { Link } from "react-router-dom";
import { ArrowRight, ClockCounterClockwise, ShieldCheck, Scales, Star } from "@phosphor-icons/react";
import OwnerFeedPanel from "../components/OwnerFeedPanel";

const destinations = [
  {
    tag: "New York",
    title: "JFK to London City",
    copy: "Same-day arrival, city-center drops, seat confirmed the moment you pay.",
    img: "/images/dest-nyc.jpg",
  },
  {
    tag: "Dubai",
    title: "London to Dubai",
    copy: "Airport pickup included. Rewards waiting when you land.",
    img: "/images/dest-dubai.jpg",
  },
  {
    tag: "Singapore",
    title: "Dubai to Singapore",
    copy: "Latte-to-lounge service. Guaranteed minimum rewards after every trip.",
    img: "/images/dest-singapore.jpg",
  },
  {
    tag: "Tokyo",
    title: "Singapore to Tokyo",
    copy: "Seasonal fares, real-time prices, and refunds that are fast and fair.",
    img: "/images/dest-tokyo.jpg",
  },
  {
    tag: "Cape Town",
    title: "London to Cape Town",
    copy: "Payments protected until you fly, with fair cancellation cover.",
    img: "/images/dest-cape.jpg",
  },
  {
    tag: "Lagos",
    title: "London to Lagos",
    copy: "Real-time fares on the West African route, payments held safely until you fly.",
    img: "/images/dest-lagos.jpg",
  },
];

const steps = [
  { t: "Search", c: "Enter your cities and dates for a real-time price." },
  { t: "Select", c: "Compare live fares and pick the trip that fits." },
  { t: "Pay", c: "Pay safely in GEN. Your payment is held until you fly." },
  { t: "Confirm", c: "Seat confirmed the moment payment clears." },
  { t: "Earn rewards", c: "Rewards land in your account when your trip is verified." },
];

export default function Home() {
  return (
    <>
      <header className="container">
        <div className="hero">
          <div>
            <p className="eyebrow">Real-time fares. Protected payments.</p>
            <h1>
              Book your trip, then <em>keep the rewards</em>
            </h1>
            <p className="hero-sub">
              Real-time flight prices, payments held safely until you fly, and
              automatic rewards after every verified trip.
            </p>
            <div className="hero-actions">
              <Link className="btn btn-primary" to="/book">
                Book a trip <ArrowRight weight="bold" aria-hidden="true" />
              </Link>
              <a className="btn btn-secondary" href="#how">
                See how it works
              </a>
            </div>
          </div>
          <div className="hero-visual" role="img" aria-label="A jet lifting off into a golden evening sky">
            <img alt="" src="/images/hero.jpg" />
            <span className="float-chip float-chip-1"><span className="dot" aria-hidden="true" /> Live price · from 0.52 GEN</span>
            <span className="float-chip float-chip-2"><span className="dot" aria-hidden="true" /> Rewards after every trip</span>
          </div>
        </div>
      </header>

      {/* Book-now flow — the traveler path, front and center */}
      <section id="how" aria-labelledby="how-heading" className="section" style={{ background: "var(--paper-2)" }}>
        <div className="container">
          <p className="eyebrow" style={{ textAlign: "center" }}>How it works</p>
          <h2 id="how-heading" style={{ textAlign: "center" }}>Book in minutes</h2>
          <p className="lede" style={{ textAlign: "center", margin: "0 auto" }}>
            Search, choose, pay, fly, and get rewarded — five simple steps.
          </p>
          <ol className="flow-steps">
            {steps.map((s, i) => (
              <li className="step-card" key={s.t}>
                <span className="step-badge" aria-hidden="true">{i + 1}</span>
                <h3>{s.t}</h3>
                <p>{s.c}</p>
              </li>
            ))}
          </ol>
          <div className="flow-cta">
            <Link className="btn btn-accent" to="/book">
              Book now <ArrowRight weight="bold" aria-hidden="true" />
            </Link>
          </div>
        </div>
      </section>

      {/* Flights — booking first */}
      <section aria-labelledby="dest-heading" className="section">
        <div className="container">
          <p className="eyebrow">Popular routes</p>
          <h2 id="dest-heading">Where are you headed?</h2>
          <div className="card-grid">
            {destinations.map((d) => (
              <Link className="card" to="/book" key={d.tag + d.title}>
                <div className="card-media">
                  <img alt={`${d.title} — scenic preview`} src={d.img} />
                </div>
                <div className="card-body">
                  <span className="card-tag">{d.tag}</span>
                  <h3>{d.title}</h3>
                  <p>{d.copy}</p>
                  <span className="card-foot">
                    Explore <ArrowRight weight="bold" aria-hidden="true" />
                  </span>
                </div>
              </Link>
            ))}
          </div>
        </div>
      </section>

      {/* Why Travity */}
      <section aria-labelledby="about-heading" className="section" style={{ background: "var(--paper-2)" }}>
        <div className="container split">
          <div className="split-media" role="img" aria-label="A warm, calm airport lounge">
            <img alt="" src="/images/about.jpg" />
          </div>
          <div>
            <p className="eyebrow">Why Travity</p>
            <h2 id="about-heading">Fly now, get rewarded automatically</h2>
            <p className="lede">
              Travity finds real-time fares, keeps your payment safe until you
              travel, and adds rewards to your account after every completed
              trip. No points that expire, no fine print.
            </p>
            <div className="stat-row">
              <div className="stat">
                <div className="stat-num">0.52 GEN</div>
                <div className="stat-label">Average fare</div>
              </div>
              <div className="stat">
                <div className="stat-num">2 min</div>
                <div className="stat-label">Typical dispute answer</div>
              </div>
              <div className="stat">
                <div className="stat-num">&infin;</div>
                <div className="stat-label">Rewards that never expire</div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Features strip */}
      <section aria-label="Why book with Travity" className="section-tight">
        <div className="container card-grid cols-2">
          {[
            { icon: <ClockCounterClockwise size={22} weight="duotone" aria-hidden="true" />, t: "Real-time, verified prices", c: "Prices are checked against live data — you always see the real fare." },
            { icon: <ShieldCheck size={22} weight="duotone" aria-hidden="true" />, t: "Your payment is protected", c: "Your money is held safely until your trip is confirmed, then released." },
            { icon: <Scales size={22} weight="duotone" aria-hidden="true" />, t: "Disputes that resolve quickly", c: "File a claim, get a fair answer fast, with refunds capped at what you paid." },
            { icon: <Star size={22} weight="duotone" aria-hidden="true" />, t: "Rewards without the fine print", c: "Every completed trip adds to your rewards. No expiry dates, no hidden rules." },
          ].map((f) => (
            <div className="panel" key={f.t} style={{ display: "flex", gap: 14, alignItems: "flex-start" }}>
              <span style={{ color: "var(--forest-2)", flex: "none" }}>{f.icon}</span>
              <span>
                <h3 style={{ marginBottom: 4, fontSize: "1.05rem" }}>{f.t}</h3>
                <p style={{ margin: 0, color: "var(--ink-soft)", fontSize: "0.92rem" }}>{f.c}</p>
              </span>
            </div>
          ))}
        </div>
      </section>

      {/* Newsletter */}
      <section aria-labelledby="newsletter-heading" className="section-tight">
        <div className="container newsletter">
          <div>
            <h2 id="newsletter-heading">Deals before departure</h2>
            <p>One email a month. Never more. No fine print.</p>
          </div>
          <form className="newsletter-form" onSubmit={(e) => e.preventDefault()}>
            <label className="sr-only" htmlFor="nl-email">Email address</label>
            <input id="nl-email" type="email" required placeholder="you@example.com" autoComplete="email" />
            <button className="btn btn-accent" type="submit">
              <ArrowRight weight="bold" aria-hidden="true" /> Subscribe
            </button>
          </form>
        </div>
      </section>

      {/* Owner-only: point the contract feed at the public quote server */}
      <OwnerFeedPanel />
    </>
  );
}