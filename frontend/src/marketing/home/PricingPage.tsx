// /pricing: the public plans page. Plan numbers mirror backend/billing.py (PLANS).
import { MouseEvent, useEffect, useState } from "react";
import "./industry.css";
import "./pricing.css";

type Plan = {
  id: string; name: string; inr: number | null; usd: number | null; blurb: string;
  questions: number | null; documents: number | null; seats: number | null; channels: boolean; academy: boolean;
};
const PLANS: Plan[] = [
  { id: "free", name: "Free", inr: 0, usd: 0, blurb: "Try it with your own documents.", questions: 100, documents: 10, seats: 2, channels: false, academy: false },
  { id: "starter", name: "Starter", inr: 999, usd: 15, blurb: "One small team asking questions every day.", questions: 1000, documents: 100, seats: 5, channels: false, academy: false },
  { id: "team", name: "Team", inr: 2999, usd: 39, blurb: "Answers in Slack, WhatsApp and on your website.", questions: 5000, documents: null, seats: 20, channels: true, academy: false },
  { id: "business", name: "Business", inr: null, usd: null, blurb: "Several sites, onboarding with Academy, priority support.", questions: 20000, documents: null, seats: null, channels: true, academy: true },
];

const features = (p: Plan) => [
  `${p.questions?.toLocaleString()} questions a month`,
  p.documents === null ? "Unlimited documents" : `${p.documents} documents`,
  p.seats === null ? "Unlimited people" : `${p.seats} people`,
  "PDF, Word, Excel, slides, photos and audio",
  "Every answer cites the page it came from",
  "Knowledge gaps and weekly summary",
  "Website widget",
  ...(p.channels ? ["Slack and WhatsApp"] : []),
  ...(p.academy ? ["Academy: onboarding courses from your documents"] : []),
];

const FAQ: [string, string][] = [
  ["What counts as a question?", "Each question someone asks, in chat, Slack, WhatsApp or your website widget. Reading the answer, opening sources and rating answers are free."],
  ["What happens if we reach the limit?", "Questions pause until the next month or until you upgrade. Nothing is deleted, and your documents stay searchable for the rest of the team once you upgrade."],
  ["Can it answer in Hindi or other languages?", "Yes. People can ask in their own language and get the answer in it, even when your documents are in English."],
  ["Do you train AI models on our documents?", "No. Your documents are only used to answer your team's questions, and each workspace is kept separate."],
  ["How do we pay?", "Monthly by card, UPI or netbanking through Razorpay. Cancel any time; your plan runs to the end of the paid month."],
];

export default function PricingPage({ onNavigate }: { onNavigate: (path: string) => void }) {
  const [usd, setUsd] = useState(false);
  useEffect(() => {
    const prev = document.title;
    document.title = "Pricing · RAGaaS";
    window.scrollTo(0, 0);
    return () => { document.title = prev; };
  }, []);
  function go(e: MouseEvent<HTMLAnchorElement>, to: string) {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    onNavigate(to);
  }
  const price = (p: Plan) => {
    const v = usd ? p.usd : p.inr;
    if (v === null) return <span className="pr-amt">Let's talk</span>;
    if (v === 0) return <span className="pr-amt">Free</span>;
    return <><span className="pr-amt">{usd ? `$${v}` : `₹${v.toLocaleString("en-IN")}`}</span><span className="pr-per">/month</span></>;
  };
  return (
    <div className="ip pr">
      <header className="nav">
        <div className="wide" style={{ display: "flex", alignItems: "center", gap: 28, height: 52 }}>
          <a href="/" onClick={(e) => go(e, "/")} className="disp" style={{ color: "#f5f5f7", textDecoration: "none", fontWeight: 600, fontSize: 17 }}>RAGaaS</a>
          <nav className="navlinks" aria-label="Site">
            <a className="navlink" href="/ask" onClick={(e) => go(e, "/ask")}>Ask</a>
            <a className="navlink" href="/gaps" onClick={(e) => go(e, "/gaps")}>Gaps</a>
            <a className="navlink" href="/academy" onClick={(e) => go(e, "/academy")}>Academy</a>
            <a className="navlink" href="/pricing" aria-current="page">Pricing</a>
          </nav>
          <div style={{ flex: 1 }} />
          <a className="navlink" href="/signin" onClick={(e) => go(e, "/signin")}>Sign in</a>
          <a className="pill pill-blue" href="/signup" onClick={(e) => go(e, "/signup")} style={{ minHeight: 36, padding: "0 16px", fontSize: 14 }}>Start free</a>
        </div>
      </header>

      <main>
        <section className="pr-hero">
          <div className="wide pr-hero-in">
            <p className="eyebrow">Pricing</p>
            <h1 className="h1 disp">Simple plans. Every answer included.</h1>
            <p className="lede">No per-message charges and no setup fee. Start free with your own documents.</p>
            <div className="pr-cur" role="group" aria-label="Currency">
              <button type="button" aria-pressed={!usd} onClick={() => setUsd(false)}>₹ INR</button>
              <button type="button" aria-pressed={usd} onClick={() => setUsd(true)}>$ USD</button>
            </div>
          </div>
        </section>

        <section className="pr-plans-wrap">
          <div className="wide pr-plans">
            {PLANS.map((p, i) => (
              <article key={p.id} className={`pr-plan${p.id === "team" ? " is-featured" : ""}`} style={{ animationDelay: `${0.05 + i * 0.07}s` }}>
                {p.id === "team" && <span className="pr-badge">Most popular</span>}
                <h2>{p.name}</h2>
                <p className="pr-price">{price(p)}</p>
                <p className="pr-blurb">{p.blurb}</p>
                <ul>{features(p).map((f) => <li key={f}>{f}</li>)}</ul>
                <span style={{ flex: 1 }} />
                {p.id === "business"
                  ? <a className="pill pill-ghost pr-cta" href="/signup" onClick={(e) => go(e, "/signup")}>Start free, then talk to us</a>
                  : <a className={`pill pr-cta ${p.id === "team" ? "pill-blue" : "pill-ghost"}`} href="/signup" onClick={(e) => go(e, "/signup")}>
                      {p.id === "free" ? "Start free" : `Start with ${p.name}`}
                    </a>}
              </article>
            ))}
          </div>
        </section>

        <section className="pr-faq-wrap">
          <div className="wide pr-faq">
            <h2 className="h2 disp">Questions</h2>
            {FAQ.map(([q, a]) => (
              <details key={q}>
                <summary>{q}</summary>
                <p>{a}</p>
              </details>
            ))}
          </div>
        </section>
      </main>
    </div>
  );
}
