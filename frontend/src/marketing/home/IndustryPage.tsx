// /for/<industry>: one page per industry, built from the FICTIONAL example company for it
// (design/examples/companies.json). Ported from the canvas design (Industry.dc.html).
import { MouseEvent, useEffect } from "react";
import "./industry.css";
import { COMPANIES, companyBySlug, docTitle, lowerFirst } from "./companies";

const HERO: Record<string, [string, string]> = {
  dental: ["Clinic answers, from your own protocols.", "Sterilization, intake, billing and front-desk questions answered from the documents your clinics already follow."],
  logistics: ["Drivers get answers. Dispatch gets peace.", "Hours rules, dangerous goods, delivery terms and incident steps, answered from your own handbook."],
  skincare: ["Support answers that match your policy.", "Returns, ingredients, shipping and tone of voice, answered from the documents your team already wrote."],
  saas: ["Fewer pings. Faster onboarding.", "Incidents, security, setup and expenses, answered from your runbooks and handbook, with the page it came from."],
  architecture: ["Studio standards, answered.", "Drawing standards, delivery stages and site safety, answered from your own studio documents."],
  restaurants: ["Every shift, the same right answer.", "Temperatures, allergens, opening checks and shift rules, answered from your food-safety plan and handbook."],
  accounting: ["Firm procedures, at every desk.", "Client onboarding, tax season steps and retention rules, answered from your own procedures."],
  solar: ["Safe crews. Clean installs.", "Roof safety, install checklists, warranties and permits, answered from your own manuals."],
};

interface IndustryPageProps {
  slug: string;
  onNavigate: (path: string) => void;
}

export default function IndustryPage({ slug, onNavigate }: IndustryPageProps) {
  const co = companyBySlug(slug) ?? COMPANIES[0];
  const [title, sub] = HERO[co.slug] ?? HERO.dental;
  const short = lowerFirst(co.short);
  const cite = `${docTitle(co, co.qa.doc)} · p. ${co.qa.page}`;

  useEffect(() => {
    const prev = document.title;
    document.title = `RAGaaS for ${co.plural}`;
    window.scrollTo(0, 0);
    return () => { document.title = prev; };
  }, [co.plural]);

  function go(e: MouseEvent<HTMLAnchorElement>, to: string) {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    onNavigate(to);
  }

  return (
    <div className="ip">
      <header className="nav">
        <div className="wide" style={{ display: "flex", alignItems: "center", gap: 28, height: 52 }}>
          <a href="/" onClick={(e) => go(e, "/")} className="disp" style={{ color: "#f5f5f7", textDecoration: "none", fontWeight: 600, fontSize: 17 }}>RAGaaS</a>
          <nav className="navlinks" aria-label="Page">
            <a className="navlink" href="#docs">Documents</a>
            <a className="navlink" href="#ask">Answers</a>
            <a className="navlink" href="#gaps">Gaps</a>
            <a className="navlink" href="#path">Onboarding</a>
          </nav>
          <div style={{ flex: 1 }} />
          <a className="pill pill-blue" href="/signup" onClick={(e) => go(e, "/signup")} style={{ minHeight: 36, padding: "0 16px", fontSize: 14 }}>Start free</a>
        </div>
      </header>

      <main id="top">
        <section className="dark" style={{ padding: "104px 0 96px" }}>
          <div className="wide" style={{ display: "flex", flexDirection: "column", gap: 22 }}>
            <nav className="inds" aria-label="Industry">
              {COMPANIES.map((c) => (
                <a key={c.slug} className="ind" href={`/for/${c.slug}`} aria-current={c.slug === co.slug ? "page" : undefined}
                  onClick={(e) => go(e, `/for/${c.slug}`)}>{c.short}</a>
              ))}
            </nav>
            <div key={co.slug} className="swap" style={{ display: "flex", flexDirection: "column", gap: 22 }}>
              <p className="eyebrow">RAGaaS for {co.plural}</p>
              <h1 className="h1 disp" style={{ maxWidth: "15ch" }}>{title}</h1>
              <p className="lede" style={{ maxWidth: "46ch" }}>{sub}</p>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 14 }}>
                <a className="pill pill-blue" href="/signup" onClick={(e) => go(e, "/signup")}>Start free</a>
                <a className="pill pill-ghost" href="#ask">See an answer</a>
              </div>
              <p style={{ margin: 0, fontSize: 13, color: "#a1a1a6" }}>Example: {co.name}, a fictional {co.size} {short}.</p>
            </div>
          </div>
        </section>

        <section id="docs" style={{ background: "#f5f5f7", padding: "112px 0" }}>
          <div className="wide" style={{ display: "flex", flexDirection: "column", gap: 32 }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 14, maxWidth: 700 }}>
              <p className="eyebrow">Start with what you have</p>
              <h2 className="h2 disp">The {co.documents.length} documents a {short} already has.</h2>
              <p className="lede">No rewriting. Upload them as they are and tag who each one is for.</p>
            </div>
            <div key={co.slug} className="docs swap">
              {co.documents.map((d) => (
                <div key={d.file} className={d.restricted ? "doc locked" : "doc"}>
                  <div className="doc-top"><b>{d.title}</b><small>{d.pages} pp</small></div>
                  <span className="aud">{d.restricted ? `${d.audience} · never searched for anyone else` : `For ${d.audience.toLowerCase()}`}</span>
                  <p>{d.summary}</p>
                  <span className="dq">{d.questions[0] ? `“${d.questions[0]}”` : "Private: never appears in anyone else's answers"}</span>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section id="ask" className="dark" style={{ padding: "112px 0" }}>
          <div className="wide" style={{ display: "flex", flexDirection: "column", gap: 32 }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 14, maxWidth: 700 }}>
              <p className="eyebrow">Day one</p>
              <h2 className="h2 disp">{co.persona.name} asks. The answer shows its page.</h2>
            </div>
            <div key={co.slug} className="qa swap">
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <div className="ibubble">{co.qa.question}</div>
                <div className="reply">{co.qa.answer}<br /><span className="cite">{cite}</span></div>
              </div>
              <div className="source">
                <p style={{ fontFamily: "-apple-system, sans-serif", fontSize: 13, color: "#6e6e73", marginBottom: 10 }}>{cite}</p>
                <p>{co.qa.excerpt.before}<mark>{co.qa.excerpt.highlight}</mark>{co.qa.excerpt.after}</p>
              </div>
            </div>
          </div>
        </section>

        <section id="gaps" style={{ background: "#fff", padding: "112px 0" }}>
          <div className="wide" style={{ display: "flex", flexDirection: "column", gap: 32 }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 14, maxWidth: 700 }}>
              <p className="eyebrow" style={{ color: "#9a5b00" }}>What the documents miss</p>
              <h2 className="h2 disp">Questions {co.plural} ask that handbooks rarely answer.</h2>
            </div>
            <div className="gaps">
              {co.gaps.map((g, i) => <div key={g.question} className="gap"><span style={{ color: "#6e6e73" }}>{i + 1}</span><span>{g.question}</span><span className="n">{g.asks}</span></div>)}
            </div>
            <p style={{ margin: 0, fontSize: 13, color: "#6e6e73" }}>Asks per month in the example workspace. Write the top one as “{co.new_doc.title}” and it comes off the list.</p>
          </div>
        </section>

        <section id="path" className="dark" style={{ padding: "112px 0" }}>
          <div className="wide" style={{ display: "flex", flexDirection: "column", gap: 32 }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 14, maxWidth: 700 }}>
              <p className="eyebrow">Academy</p>
              <h2 className="h2 disp">Onboard every new {co.academy.role.toLowerCase()} from the same documents.</h2>
              <p className="lede">{co.academy.path}: four lessons, a test after each, review of anything missed, and a manager's sign-off within {co.academy.due_days} days.</p>
            </div>
            <div className="path">
              {co.academy.lessons.map((l, i) => <div key={l.title} className="step"><span>Lesson {i + 1}</span><b>{l.title}</b><small>From {l.source}</small></div>)}
            </div>
            <div className="quiz" style={{ maxWidth: 640 }}>
              <p style={{ margin: 0, fontSize: 13, color: "#a1a1a6" }}>Lesson test</p>
              <p style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>{co.academy.quiz.question}</p>
              {co.academy.quiz.options.map((o, i) => <div key={o} className={i === co.academy.quiz.answer ? "opt right" : "opt"}>{o}</div>)}
              <span className="cite" style={{ alignSelf: "flex-start" }}>{co.academy.quiz.source}</span>
            </div>
          </div>
        </section>

        <section id="start" style={{ background: "#f5f5f7", padding: "128px 0", textAlign: "center" }}>
          <div className="wide" style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 20 }}>
            <h2 className="h2 disp" style={{ maxWidth: "18ch" }}>Upload your {co.documents[0].title.toLowerCase()} and ask it something.</h2>
            <p className="lede" style={{ maxWidth: "42ch" }}>Free to start. Your documents stay in your workspace and are never used to train a model.</p>
            <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "center", gap: 14 }}>
              <a className="pill pill-blue" href="/signup" onClick={(e) => go(e, "/signup")}>Start free</a>
              <a className="pill pill-ghost" href="/" onClick={(e) => go(e, "/")}>See the full journey</a>
            </div>
          </div>
        </section>
      </main>
      <footer style={{ background: "#f5f5f7", borderTop: "1px solid rgba(0,0,0,.08)" }}>
        <div className="wide" style={{ display: "flex", gap: 20, alignItems: "center", minHeight: 72, fontSize: 12, color: "#6e6e73" }}>RAGaaS · Example companies are fictional.</div>
      </footer>
    </div>
  );
}
