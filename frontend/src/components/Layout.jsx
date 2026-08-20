import { useState } from "react";
import { Link, NavLink } from "react-router-dom";
import { WalletButton } from "./WalletButton";

function NavLinks() {
  return (
    <>
      <li><NavLink to="/" end>Home</NavLink></li>
      <li><NavLink to="/book">Book</NavLink></li>
      <li><NavLink to="/loyalty">Loyalty</NavLink></li>
      <li><NavLink to="/disputes">Disputes</NavLink></li>
      <li><NavLink to="/journal">Journal</NavLink></li>
    </>
  );
}

export function Header() {
  const [open, setOpen] = useState(false);

  return (
    <header className="site-header">
      <a className="skip-link" href="#main">Skip to content</a>
      <div className="container nav">
        <Link className="brand" to="/" onClick={() => setOpen(false)}>Trav<span>ity</span></Link>

        <nav aria-label="Primary" className={`nav-wrap ${open ? "is-open" : ""}`}>
          <ul className="nav-links">
            <NavLinks />
          </ul>
          <Link className="btn btn-primary nav-cta" to="/book" onClick={() => setOpen(false)}>Book a trip</Link>
          <span className="nav-wallet">
            <WalletButton label="Connect" />
          </span>
        </nav>

        <button
          type="button"
          className="nav-toggle"
          aria-expanded={open}
          aria-controls="primary-nav"
          onClick={() => setOpen((v) => !v)}
        >
          <span className="sr-only">{open ? "Close menu" : "Open menu"}</span>
          <span className="nav-toggle-bar" aria-hidden="true" />
          <span className="nav-toggle-bar" aria-hidden="true" />
          <span className="nav-toggle-bar" aria-hidden="true" />
        </button>
      </div>
    </header>
  );
}

export function Footer() {
  return (
    <footer className="site-footer">
      <div className="container">
        <div className="footer-grid">
          <div>
            <span className="brand">Trav<span>ity</span></span>
            <p style={{ color: "var(--ink-soft)", maxWidth: "34ch" }}>
              A travel agent that finds real-time fares, protects your payment
              until you fly, and rewards every completed trip.
            </p>
          </div>
          <div>
            <h3>Explore</h3>
            <ul>
              <li><Link to="/book">Book a trip</Link></li>
              <li><Link to="/loyalty">Loyalty</Link></li>
              <li><Link to="/disputes">Disputes</Link></li>
              <li><Link to="/journal">Journal</Link></li>
            </ul>
          </div>
          <div>
            <h3>Built on</h3>
            <ul>
              <li><a href="https://genlayer.com" target="_blank" rel="noreferrer">GenLayer</a></li>
              <li><a href="https://cloud.walletconnect.com" target="_blank" rel="noreferrer">WalletConnect</a></li>
            </ul>
          </div>
          <div>
            <h3>Contact</h3>
            <ul>
              <li><a href="mailto:hello@travity.example">hello@travity.example</a></li>
              <li>Susunuck East, Kinshasa</li>
            </ul>
          </div>
        </div>
        <div className="footer-bottom">
          <span>&copy; 2026 Travity. All rights reserved.</span>
        </div>
      </div>
    </footer>
  );
}