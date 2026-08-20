import { useState } from "react";
import { ArrowDown, ArrowUp } from "@phosphor-icons/react";

const articles = [
  {
    id: "how-rewards-work",
    category: "Rewards",
    type: "guide",
    date: "14 May 2026",
    readTime: "4 min",
    img: "/images/journal-boarding.jpg",
    alt: "Passengers boarding a plane at the gate",
    title: "How your rewards actually work",
    excerpt: "A plain-English guide to what you earn, when you get it, and why it never expires.",
    body: [
      "Rewards sound complicated until you see them in action. Here is the simple version of how Travity rewards work.",
      {
        h: "When you earn",
        p: "Book a trip, fly it, and when your trip's completion is verified, rewards are added to your account automatically. No forms, no calling in, no points that quietly vanish.",
      },
      {
        h: "What it's worth",
        p: "Every reward is held in GEN — the currency you book with. You can see it move in real time: a typical fare is around 0.52 GEN, and completed trips earn you more each time.",
      },
      {
        h: "No expiry, no fine print",
        p: "Rewards don't expire and there are no hidden terms. Your balance is always current and always yours — read it whenever you like.",
      },
      "The short version: book, fly, get rewarded. That's the whole promise.",
    ],
  },
  {
    id: "schedule-change-story",
    category: "Disputes",
    type: "story",
    date: "22 Apr 2026",
    readTime: "3 min",
    img: "/images/journal-lounge.jpg",
    alt: "A calm airport lounge with comfortable seating",
    title: "A last-minute schedule change, resolved in minutes",
    excerpt: "When a connection fell apart, the claim process turned out to be the smoothest part of the trip.",
    body: [
      "The flight was fine. The connection after it — less so. A delayed first leg meant the second one was never going to work, and the airline's own desk said it would take days to sort out.",
      "Instead of an email queue, the claim went through Travity's dispute flow. File it with the booking reference and a short reason, and the review is automatic: the booking details and the situation are checked right away.",
      {
        h: "The answer, fast",
        p: "The refund was capped at the fare paid — nothing more, nothing less. What mattered was the speed: a decision in minutes instead of a fortnight of chasing.",
      },
      "Disputes will never be fun. But they don't have to be a second holiday all to themselves.",
    ],
  },
  {
    id: "deals-that-pay-you-back",
    category: "Destinations",
    type: "news",
    date: "30 Mar 2026",
    readTime: "3 min",
    img: "/images/journal-terminal.jpg",
    alt: "A busy airport terminal in warm light",
    title: "Why travel deals now pay you back",
    excerpt: "Real-time prices, protected payments, and rewards that follow you between trips — the booking rail is changing.",
    body: [
      "For most of travel's history, the price you saw was a starting point, your money left the moment you paid, and rewards evaporated with a change of terms.",
      {
        h: "The price you see is the price you pay",
        p: "Fares are checked against live data, so the number on your screen is the real one. No single source is trusted blindly — the price is verified before it reaches you.",
      },
      {
        h: "Your money is held until you fly",
        p: "Instead of moving out of your control at payment, your fare sits safely held until your trip is confirmed. If something goes wrong, that protection shows up in how refunds are handled too.",
      },
      {
        h: "Rewards that stick around",
        p: "Rewards are added after every completed trip and they don't expire. That's the difference from the fine-print points of the past.",
      },
      "If this is where booking is heading, the trip itself is the only hard part.",
    ],
  },
];

export default function Journal() {
  const [openId, setOpenId] = useState(null);

  return (
    <>
      <section className="app-hero">
        <div className="container">
          <p className="eyebrow">Journal</p>
          <h1>Stories &amp; ideas</h1>
          <p className="lede">
            How Travity works, what it's like to travel with it, and what's
            changing in the way we book.
          </p>
        </div>
      </section>

      <section className="container" aria-label="Journal articles">
        <ul className="journal-grid">
          {articles.map((a) => {
            const open = openId === a.id;
            const bodyId = `journal-body-${a.id}`;
            return (
              <li className="journal-card" key={a.id}>
                <div className="card-media">
                  <img alt={a.alt} src={a.img} />
                </div>
                <div className="card-body">
                  <span className="card-tag">{a.category}</span>
                  <span className="journal-meta">
                    <span className="journal-type">{a.type}</span>
                    <span>{a.date}</span>
                    <span>{a.readTime} read</span>
                  </span>
                  <h3>{a.title}</h3>
                  <p className="journal-excerpt">{a.excerpt}</p>
                  <button
                    type="button"
                    className="journal-toggle"
                    aria-expanded={open}
                    aria-controls={bodyId}
                    onClick={() => setOpenId(open ? null : a.id)}
                  >
                    {open ? "Collapse" : "Read the story"}
                    {open
                      ? <ArrowUp weight="bold" aria-hidden="true" />
                      : <ArrowDown weight="bold" aria-hidden="true" />}
                  </button>
                  {open && (
                    <div className="journal-body" id={bodyId} role="region" aria-label={a.title}>
                      {a.body.map((b, i) =>
                        typeof b === "string" ? (
                          <p key={i}>{b}</p>
                        ) : (
                          <div key={i}>
                            <h4>{b.h}</h4>
                            <p>{b.p}</p>
                          </div>
                        )
                      )}
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </section>
    </>
  );
}