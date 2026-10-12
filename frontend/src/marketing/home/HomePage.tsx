// The public homepage: a three-month journey told in one scroll-driven scene, built from
// the FICTIONAL example companies (design/examples/companies.json), then try-it, gaps,
// manager view, estimator, security, stories, what's new, FAQ. Ported from the approved
// canvas design (Home.dc.html); motion is transform/opacity with reduced motion respected.
import { ChangeEvent, MouseEvent, ReactNode, useEffect, useMemo, useRef, useState } from "react";
import "./home.css";
import { COMPANIES, docTitle, lowerFirst, shortName } from "./companies";
import { MAX_TRY_BYTES, TryResult, analyzeText, readPdfText } from "./analyze";
import { CHAPTER_COUNT, createJourneyScene } from "./journeyScene";

const WHEN = ["Before", "Day 0", "Day 0", "Day 1", "Day 1", "Week 2", "Week 3", "Week 3", "Week 4", "Week 6", "Month 3"];

const CHANGELOG: [string, string, string][] = [
  ["10 Oct 2026", "Choose which documents to search", "A picker with summaries and starter questions for every document; scoped answers offer to search everything if they come up empty."],
  ["10 Oct 2026", "Steadier answers", "Duplicate uploads no longer crowd out evidence, and an earlier “can't find” no longer sticks to the next question."],
  ["9 Oct 2026", "Academy dashboards and certificates", "Progress for every learner, due dates, manager sign-off and certificates that list their source documents."],
  ["9 Oct 2026", "The learner app", "A daily plan, lessons with sources, graded tests and spaced review of missed questions."],
  ["4 Oct 2026", "Learning paths from your documents", "Pick a role and RAGaaS drafts a path of lessons from the documents that role can read."],
  ["3 Oct 2026", "Clearer sign-up", "A new sign-in and sign-up flow that sets up your workspace in one go."],
];

const FAQS: [string, string][] = [
  ["What documents work best?", "The ones your team already has: handbooks, SOPs, policies, playbooks and guides. PDF or Word, up to 30 MB each."],
  ["How is this different from ChatGPT?", "It's shared by your whole team, answers only from your documents, cites every answer, and shows you the questions your documents can't answer yet."],
  ["Can some documents stay private?", "Yes. Tag a document with who it's for and it's never searched for anyone else, in chat, lessons or tests."],
  ["How long does setup take?", "Upload a few documents and ask your first question in minutes. Learning paths are generated from the same documents."],
  ["Is our data used to train models?", "No. Each workspace is isolated and your documents are never used to train a model."],
  ["What does it cost?", "There is a free tier. Paid plans are priced by seats and analytics: [YOUR PRICING]."],
];

const SAMPLE_COMPANIES = [0, 1, 2, 5];

type TryState = { status: "idle" } | { status: "message"; text: string } | ({ status: "done" } & TryResult);

function useSeen<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || seen) return;
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) { setSeen(true); io.disconnect(); } }, { threshold: 0.15 });
    io.observe(el);
    return () => io.disconnect();
  }, [seen]);
  return [ref, seen ? "is-seen" : ""] as const;
}

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

interface HomePageProps {
  signedIn: boolean;
  onNavigate: (path: string) => void;
}

export default function HomePage({ signedIn, onNavigate }: HomePageProps) {
  const [company, setCompany] = useState(0);
  const [step, setStep] = useState(0);
  const [hint, setHint] = useState(true);
  const [tryOut, setTryOut] = useState<TryState>({ status: "idle" });
  const [calc, setCalc] = useState({ team: 30, qpw: 4, mins: 8, share: 60 });
  const [signed, setSigned] = useState<Record<string, boolean>>({});
  const [faq, setFaq] = useState(0);

  const co = COMPANIES[company];
  const companyRef = useRef(company);
  companyRef.current = company;
  const sectionRef = useRef<HTMLElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<ReturnType<typeof createJourneyScene>>(null);

  const [examplesRef, examplesSeen] = useSeen<HTMLElement>();
  const [tryRef, trySeen] = useSeen<HTMLElement>();
  const [gtRef, gtSeen] = useSeen<HTMLElement>();
  const [mgrRef, mgrSeen] = useSeen<HTMLElement>();
  const [whereRef, whereSeen] = useSeen<HTMLElement>();
  const [vsRef, vsSeen] = useSeen<HTMLElement>();
  const [calcRef, calcSeen] = useSeen<HTMLElement>();
  const [proofRef, proofSeen] = useSeen<HTMLElement>();
  const [storiesRef, storiesSeen] = useSeen<HTMLElement>();
  const [logRef, logSeen] = useSeen<HTMLElement>();

  useEffect(() => {
    const prev = document.title;
    document.title = "RAGaaS · Your company's knowledge, answering back";
    const target = window.location.hash ? document.querySelector(window.location.hash) : null;
    if (target) target.scrollIntoView(); else window.scrollTo(0, 0);
    return () => { document.title = prev; };
  }, []);

  useEffect(() => {
    if (!canvasRef.current || !sectionRef.current) return;
    const scene = createJourneyScene({
      canvas: canvasRef.current, section: sectionRef.current, reduce: reducedMotion(),
      getCompany: () => companyRef.current, onStep: setStep, onHint: setHint,
    });
    sceneRef.current = scene;
    return () => { scene?.dispose(); sceneRef.current = null; };
  }, []);

  function pickCompany(i: number, scrollToJourney: boolean) {
    sceneRef.current?.rippleNow();
    setCompany(i);
    if (scrollToJourney && sectionRef.current) {
      // Land just inside chapter 1 (it starts at 7% of the pinned scroll), so the replay begins at once.
      const section = sectionRef.current;
      const span = section.offsetHeight - window.innerHeight;
      window.scrollTo({
        top: section.getBoundingClientRect().top + window.scrollY + span * 0.09,
        behavior: reducedMotion() ? "auto" : "smooth",
      });
    }
  }

  // In-site links move without a reload; in-page anchors scroll normally.
  function go(e: MouseEvent<HTMLAnchorElement>, to: string) {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    onNavigate(to);
  }

  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (file.size > MAX_TRY_BYTES) { setTryOut({ status: "message", text: "That file is over 15 MB. Try a smaller one here." }); return; }
    const isPdf = /\.pdf$/i.test(file.name) || file.type === "application/pdf";
    if (!isPdf && !/\.(txt|md|markdown)$/i.test(file.name) && !file.type.startsWith("text/")) {
      setTryOut({ status: "message", text: "Try a PDF, text or Markdown file here. Word documents work once you sign up." });
      return;
    }
    setTryOut({ status: "message", text: `Reading ${file.name}…` });
    try {
      const text = isPdf ? await readPdfText(file) : await file.text();
      const out = analyzeText(file.name, text);
      setTryOut(out.items.length
        ? { status: "done", ...out }
        : { status: "message", text: isPdf ? "No selectable text in that PDF (it may be a scan). Try another file." : "Not enough text in that file to work with." });
    } catch {
      setTryOut({ status: "message", text: "Couldn't read that file. Try another one." });
    }
  }

  function trySample(ci: number) {
    const c = COMPANIES[ci];
    const doc = c.documents.find((d) => d.file === c.qa.doc)!;
    const items = [{ q: c.qa.question, excerpt: c.qa.excerpt.before + c.qa.excerpt.highlight + c.qa.excerpt.after }]
      .concat(doc.questions.filter((q) => q !== c.qa.question).slice(0, 2).map((q) => ({ q, excerpt: doc.summary })));
    setTryOut({ status: "done", name: `${doc.title} · ${c.name} (fictional)`, summary: doc.summary, items, gap: c.gaps[0].question });
  }

  const owner = shortName(co.owner.name);
  const restricted = co.documents.find((d) => d.restricted) ?? co.documents[co.documents.length - 1];
  const pages = co.documents.reduce((n, d) => n + d.pages, 0);
  const qaTitle = docTitle(co, co.qa.doc);
  const chapters: { k: string; warn?: boolean; title: string; body: string }[] = [
    { k: "01 · Upload", title: `${owner} uploads ${co.documents.length} documents.`, body: `${pages} pages the team already had: ${co.documents.slice(0, 3).map((d) => d.title).join(", ")} and more. Searchable in minutes.` },
    { k: "02 · Access", warn: true, title: "Some documents stay private.", body: `${restricted.title} is for ${restricted.audience.toLowerCase()}. It's never searched for anyone else, so it can't leak into an answer.` },
    { k: "03 · Ask", title: `${co.persona.name} asks on day one.`, body: `The new ${co.persona.role.toLowerCase()} asks in plain words instead of interrupting ${owner}. The best passages light up.` },
    { k: "04 · Source", title: "The answer opens on the exact line.", body: `${qaTitle}, page ${co.qa.page}. Nothing taken on trust, and nothing from a document ${co.persona.name} can't read.` },
    { k: "05 · Gaps", warn: true, title: "Some questions have no answer yet.", body: "Nothing in the documents covers them, so they're collected and ranked by how often people ask. The top one is the next page to write." },
    { k: "06 · Close the gap", title: "Write one page. The gap closes.", body: `${owner} writes “${co.new_doc.title}”. The next person who asks gets a cited answer, and it comes off the list.` },
    { k: "07 · Academy", title: `${co.academy.path} builds itself.`, body: `The same documents become a path for every new ${co.academy.role.toLowerCase()}: short lessons with sources and a test after each.` },
    { k: "08 · Test & review", title: "Missed it? It comes back.", body: `Every test question cites its page. Anything ${co.persona.name} gets wrong returns a few days later until it sticks.` },
    { k: "09 · Sign-off", title: `${owner} signs off. ${co.persona.name} is certified.`, body: "The certificate lists the documents and versions the path was built from, so it stays honest when they change." },
    { k: "10 · The workspace", title: "Fewer interruptions. A knowledge base that keeps up.", body: "Three months in, questions get answered with a source and the gap list keeps shrinking. Figures shown are example data." },
  ];
  const side = (i: number) => (step === i ? "side is-on" : "side");
  const gaps = co.gaps.map((g, i) => ({ ...g, rank: i + 1 }));
  const cite2 = `${docTitle(co, co.qa.also_cites.doc)} · p. ${co.qa.also_cites.page}`;
  const slackQ = co.documents.find((d) => d.questions.length > 1)?.questions[1] ?? co.qa.question;
  const allGaps = useMemo(() => {
    const all = COMPANIES.flatMap((c) => c.gaps.map((g) => ({ ...g, industry: c.short }))).sort((a, b) => b.asks - a.asks).slice(0, 8);
    return all.map((g, i) => ({ ...g, rank: i + 1, s: g.asks / all[0].asks }));
  }, []);
  const learners = [
    { name: co.persona.name, progress: 1, label: "4 of 4 lessons · passed", state: "ready" },
    { name: "Jordan", progress: 0.75, label: "3 of 4 lessons · due in 5 days", state: "ok" },
    { name: "Elif", progress: 0.4, label: "2 of 4 lessons · 2 days overdue", state: "late" },
    { name: "Chris", progress: 0.1, label: "Started · due in 12 days", state: "ok" },
  ];
  const hours = Math.round(calc.team * calc.qpw * 4.33 * calc.mins / 60 * calc.share / 100);
  const perPerson = Math.round(calc.qpw * calc.mins * calc.share / 100);
  const setCalcKey = (k: keyof typeof calc) => (e: ChangeEvent<HTMLInputElement>) => setCalc((c) => ({ ...c, [k]: Number(e.target.value) }));

  const sideKey = (text: ReactNode) => <p className="side-k">{text}</p>;

  return (
    <div className="hm">
      <header className="nav">
        <div className="wide" style={{ display: "flex", alignItems: "center", gap: 28, height: 52 }}>
          <a href="/" onClick={(e) => go(e, "/")} className="disp" style={{ display: "flex", alignItems: "center", gap: 8, color: "#f5f5f7", textDecoration: "none", fontWeight: 600, fontSize: 17, letterSpacing: "-0.02em" }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#f5f5f7" strokeWidth="1.8" aria-hidden="true"><path d="M6 3h8l4 4v14H6z" /><path d="M9 12h6M9 16h4" /></svg>
            RAGaaS
          </a>
          <nav className="navlinks" aria-label="Site">
            <a className="navlink" href="/ask" onClick={(e) => go(e, "/ask")}>Ask</a>
            <a className="navlink" href="/gaps" onClick={(e) => go(e, "/gaps")}>Gaps</a>
            <a className="navlink" href="/academy" onClick={(e) => go(e, "/academy")}>Academy</a>
            <a className="navlink" href="/access" onClick={(e) => go(e, "/access")}>Access</a>
            <a className="navlink" href="#try">Try it</a>
          </nav>
          <div style={{ flex: 1 }} />
          {signedIn
            ? <a className="pill pill-blue" href="/" onClick={(e) => go(e, "/")} style={{ padding: "0 16px", fontSize: 14 }}>Open app</a>
            : <>
                <a className="util" href="/signin" onClick={(e) => go(e, "/signin")}>Sign in</a>
                <a className="pill pill-blue" href="/signup" onClick={(e) => go(e, "/signup")} style={{ padding: "0 16px", fontSize: 14 }}>Start free</a>
              </>}
        </div>
      </header>

      <main id="top">
        <section id="journey" ref={sectionRef} className="scroll" aria-label="A company's first three months with RAGaaS">
          <div className="stage">
            <canvas ref={canvasRef} className="scene" role="img"
              aria-label={`Three months at ${co.name}, a fictional ${co.industry.toLowerCase()}, told with glowing document cards that form a library wall, light up for a cited answer, leave gaps that get filled, stream into a learning path and close into a certificate ring.`} />
            <div className="vignette" aria-hidden="true" />

            <div className={step === 0 ? "intro" : "intro is-off"}>
              <h1 className="tagline disp">
                {["Your", "company's", "knowledge,", "answering", "back."].map((w, i) => (
                  <span key={w}><span className="word" style={{ animationDelay: `${i * 60}ms` }}>{w}</span>{i < 4 ? " " : ""}</span>
                ))}
              </h1>
              <p className="tag-sub word" style={{ animationDelay: "420ms" }}><b>Ask it anything.</b> See what it's missing. Teach new hires from it.</p>
              <div className="word" style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10, marginTop: 10, animationDelay: "560ms" }}>
                <span className="cos-label">Scroll through three months at a</span>
                <div className="cos" role="group" aria-label="Example company">
                  {COMPANIES.map((c, i) => (
                    <button key={c.id} type="button" className="co" aria-pressed={i === company} onClick={() => pickCompany(i, false)}>{c.short}</button>
                  ))}
                </div>
              </div>
            </div>

            <div className="clock" style={{ opacity: step === 0 ? 0 : 1 }} aria-live="polite">
              <span className="clock-dot" aria-hidden="true" /><b>{co.name}</b><span className="when">{WHEN[step]}</span>
            </div>

            {chapters.map((c, i) => (
              <div key={c.k} className={step === i + 1 ? "chapter is-on" : "chapter"}>
                <span className={c.warn ? "ch-k warn" : "ch-k"}>{c.k}</span>
                <h2 className="ch-title disp">{c.title}</h2>
                <p className="ch-body">{c.body}</p>
              </div>
            ))}

            <div className={side(1)}>
              {sideKey(`${co.name} · knowledge base`)}
              {co.documents.map((d) => <div key={d.file} className="drow"><span>{d.title}</span><small>{d.pages} pp</small></div>)}
            </div>
            <div className={side(2)}>
              {sideKey(`Visible to ${co.persona.name}, ${co.persona.role.toLowerCase()}`)}
              {co.documents.map((d) => (
                <div key={d.file} className={d.restricted ? "drow locked" : "drow"}><span>{d.title}</span><small>{d.restricted ? "Never searched" : d.audience}</small></div>
              ))}
            </div>
            <div className={side(3)}>
              {sideKey(`${co.persona.name} · day one`)}
              <div className="q">{co.qa.question}</div>
              <p className="a">{co.qa.answer}</p>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}><span className="cite">{qaTitle} · p. {co.qa.page}</span><span className="cite">{cite2}</span></div>
            </div>
            <div className={side(4)}>
              {sideKey(`${qaTitle} · p. ${co.qa.page}`)}
              <p className="excerpt">{co.qa.excerpt.before}<mark>{co.qa.excerpt.highlight}</mark>{co.qa.excerpt.after}</p>
            </div>
            <div className={side(5)}>
              {sideKey("Asked this month · nothing answers")}
              {gaps.map((g) => <div key={g.question} className="gaprow"><span style={{ color: "#a1a1a6" }}>{g.rank}</span><span>{g.question}</span><span className="n">{g.asks}</span></div>)}
            </div>
            <div className={side(6)}>
              {sideKey(`New document · ${co.new_doc.title}`)}
              {gaps.map((g, i) => (
                <div key={g.question} className={i === co.new_doc.closes ? "gaprow closed" : "gaprow"}>
                  <span style={{ color: "#a1a1a6" }}>{g.rank}</span><span>{g.question}</span><span className="n">{i === co.new_doc.closes ? "✓" : g.asks}</span>
                </div>
              ))}
            </div>
            <div className={side(7)}>
              {sideKey(`${co.academy.path} · due in ${co.academy.due_days} days`)}
              {co.academy.lessons.map((l, i) => (
                <div key={l.title} className="lesson"><span className="num">{i + 1}</span><span>{l.title}<small>from {l.source}</small></span></div>
              ))}
            </div>
            <div className={side(8)}>
              {sideKey("Lesson test")}
              <p className="a" style={{ fontWeight: 600 }}>{co.academy.quiz.question}</p>
              {co.academy.quiz.options.map((o, i) => <div key={o} className={i === co.academy.quiz.answer ? "opt right" : "opt"}>{o}</div>)}
              <span className="cite">{co.academy.quiz.source}</span>
            </div>
            <div className={side(9)}>
              <div className="cert">
                {sideKey("Certificate of completion")}
                <p className="disp" style={{ margin: 0, fontSize: 22, fontWeight: 600 }}>{co.persona.name} · {co.academy.path}</p>
                <p style={{ margin: 0, fontSize: 13, color: "#a1a1a6" }}>Signed off by {co.owner.name}, {co.owner.role}</p>
                <p style={{ margin: 0, fontSize: 12, color: "#a1a1a6" }}>Built from {[...new Set(co.academy.lessons.map((l) => l.source))].join(", ")}</p>
              </div>
            </div>
            <div className={side(10)}>
              {sideKey(`${co.name} · month three · example data`)}
              <div className="stat"><span>Questions asked this month</span><b>{co.example_usage.questions_month}</b></div>
              <div className="stat"><span>Answered with a source</span><b>{co.example_usage.answered_with_source}</b></div>
              <div className="stat"><span>Gaps closed with a new doc</span><b>{co.example_usage.gaps_closed}</b></div>
              <div className="stat"><span>New hires certified</span><b>{co.example_usage.certified}</b></div>
            </div>

            <div className="rail" aria-hidden="true">
              {Array.from({ length: CHAPTER_COUNT }, (_, i) => <span key={i} className={i === step ? "dot is-on" : i < step ? "dot is-past" : "dot"} />)}
            </div>
            <div className="hint" style={{ opacity: hint ? 1 : 0 }} aria-hidden="true">
              Scroll<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#a1a1a6" strokeWidth="2" strokeLinecap="round"><path d="M12 5v14M6 13l6 6 6-6" /></svg>
            </div>
          </div>
        </section>

        <section id="examples" ref={examplesRef} className={examplesSeen} style={{ background: "#f5f5f7", color: "#1d1d1f", padding: "128px 0" }}>
          <div className="wide" style={{ display: "flex", flexDirection: "column", gap: 40 }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 700 }}>
              <p className="eyebrow rv">Built for teams of 10 to 200</p>
              <h2 className="h2 disp rv d1">The documents you already have are enough.</h2>
              <p className="lede rv d2">Eight example workspaces, each with the handful of documents a small company really has. Pick one to replay the journey above with its documents and its questions. All eight companies are fictional.</p>
            </div>
            <div className="ws rv d2">
              {COMPANIES.map((c, i) => (
                <button key={c.id} type="button" className={i === company ? "wsc is-on" : "wsc"} aria-pressed={i === company} onClick={() => pickCompany(i, true)}>
                  <span className="wsc-ind">{c.industry}</span>
                  <p className="wsc-name disp">{c.name}</p>
                  <p className="wsc-size">{c.size} · {c.documents.length} documents</p>
                  <span className="chips">
                    {c.documents.slice(0, 3).map((d) => <span key={d.file} className="chip">{d.title}</span>)}
                    {c.documents.filter((d) => d.restricted).slice(0, 1).map((d) => <span key={d.file} className="chip lock">{d.title}</span>)}
                  </span>
                  <span className="wsc-go">Replay with {lowerFirst(c.short)} ↑</span>
                </button>
              ))}
            </div>
            <p className="rv d3" style={{ margin: 0, fontSize: 15, color: "#6e6e73" }}>
              By industry:{" "}
              {COMPANIES.map((c, i) => (
                <span key={c.slug}>{i > 0 ? " · " : ""}<a href={`/for/${c.slug}`} onClick={(e) => go(e, `/for/${c.slug}`)} style={{ color: "#0066cc" }}>{c.plural}</a></span>
              ))}
            </p>
          </div>
        </section>

        <section id="try" ref={tryRef} className={trySeen} style={{ background: "#000", color: "#f5f5f7", padding: "128px 0" }}>
          <div className="wide try-grid">
            <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
              <p className="eyebrow rv" style={{ color: "#2997ff" }}>Try it on your own document</p>
              <h2 className="h2 disp rv d1">Drop in a handbook. See what it answers, and what it can't.</h2>
              <p className="lede rv d2" style={{ color: "#a1a1a6" }}>Read right here in your browser. Nothing is uploaded and nothing is stored.</p>
              <label className="drop rv d2">
                <input type="file" accept=".pdf,.txt,.md,application/pdf,text/plain,text/markdown" onChange={onFile} />
                <b>Choose a file</b><small>PDF, text or Markdown · up to 15 MB</small>
              </label>
              <div className="samples rv d3"><span>Or try a sample:</span>
                {SAMPLE_COMPANIES.map((ci) => (
                  <button key={ci} type="button" className="sample" onClick={() => trySample(ci)}>
                    {docTitle(COMPANIES[ci], COMPANIES[ci].qa.doc)}
                  </button>
                ))}
              </div>
            </div>
            <div className={tryOut.status === "done" ? "try-out is-done" : "try-out"} aria-live="polite">
              {tryOut.status === "idle" && <p className="try-empty">Pick a file or a sample. You'll see a summary, three questions it answers with the passage each answer comes from, and one question it can't answer yet.</p>}
              {tryOut.status === "message" && <p className="try-empty">{tryOut.text}</p>}
              {tryOut.status === "done" && <>
                <p className="try-k">{tryOut.name}</p>
                <p style={{ margin: 0, fontSize: 17, lineHeight: 1.5 }}>{tryOut.summary}</p>
                <p className="try-k" style={{ marginTop: 6 }}>It can answer</p>
                {tryOut.items.map((it) => <div key={it.q} className="try-q"><b>{it.q}</b><span>{it.excerpt}</span></div>)}
                <p className="try-k" style={{ marginTop: 6 }}>It can't answer yet</p>
                <div className="try-gap">{tryOut.gap}<small>Would go to your Gaps list</small></div>
              </>}
            </div>
          </div>
        </section>

        <section ref={gtRef} className={gtSeen} style={{ background: "#f5f5f7", color: "#1d1d1f", padding: "128px 0" }}>
          <div className="wide" style={{ display: "flex", flexDirection: "column", gap: 36 }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 700 }}>
              <p className="eyebrow rv" style={{ color: "#9a5b00" }}>Knowledge gaps</p>
              <h2 className="h2 disp rv d1">What handbooks can't answer.</h2>
              <p className="lede rv d2">The most-asked questions that none of the example companies' documents cover. Every team has a list like this; most never see it.</p>
            </div>
            <div className="gt rv d2">
              {allGaps.map((g) => (
                <div key={g.question} className="gt-row">
                  <span className="rank">{g.rank}</span>
                  <span>{g.question}<span className="gt-ind">{g.industry}</span></span>
                  <span className="gt-track"><span className="gt-fill" style={{ ["--s" as string]: g.s.toFixed(3) }} /></span>
                  <span className="n">{g.asks}</span>
                </div>
              ))}
            </div>
            <p style={{ margin: 0, fontSize: 13, color: "#6e6e73" }}>Asks per month in the fictional example workspaces.</p>
          </div>
        </section>

        <section ref={mgrRef} className={mgrSeen} style={{ background: "#fff", color: "#1d1d1f", padding: "128px 0" }}>
          <div className="wide mgr-grid">
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              <p className="eyebrow rv">For managers</p>
              <h2 className="h2 disp rv d1">See who's ready before you have to ask.</h2>
              <p className="lede rv d2">Progress, deadlines and test scores for every new hire in one place. Sign off when a path is passed; the certificate is issued on the spot.</p>
            </div>
            <div className="dash rv d2">
              <p className="try-k" style={{ color: "#6e6e73", marginBottom: 6 }}>{co.academy.path} · {co.name}</p>
              {learners.map((l) => {
                const done = !!signed[co.id + l.name];
                const ready = l.state === "ready";
                return (
                  <div key={l.name} className="lrow">
                    <span className="lname">{l.name}<small>{co.academy.role}</small></span>
                    <span className="lbar"><span>{l.label}</span><span className="ltrack"><span className={l.state === "late" ? "lfill late" : "lfill"} style={{ ["--s" as string]: l.progress.toFixed(2) }} /></span></span>
                    <button type="button" disabled={!ready || done}
                      className={ready ? (done ? "lact signed" : "lact ready") : l.state === "late" ? "lact late" : "lact ok"}
                      onClick={() => ready && setSigned((s) => ({ ...s, [co.id + l.name]: true }))}>
                      {ready ? (done ? "Certified ✓" : "Sign off") : l.state === "late" ? "Overdue" : "On track"}
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        </section>

        <section id="where" ref={whereRef} className={whereSeen} style={{ background: "#fff", color: "#1d1d1f", padding: "0 0 128px" }}>
          <div className="wide" style={{ display: "flex", flexDirection: "column", gap: 40 }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 680 }}>
              <p className="eyebrow rv">Where it works</p>
              <h2 className="h2 disp rv d1">Answers where your team already asks.</h2>
            </div>
            <div className="where">
              <div className="wt rv d1" style={{ background: "#000", color: "#f5f5f7" }}>
                <span style={{ fontSize: 14, fontWeight: 600, color: "#2997ff" }}>In the app</span>
                <p className="disp" style={{ margin: 0, fontSize: 24, fontWeight: 600 }}>Ask, Gaps and Academy</p>
                <p style={{ margin: 0, color: "#a1a1a6", lineHeight: 1.5 }}>Pick which documents to search, open any source on the exact line.</p>
                <div className="mock" style={{ background: "#1d1d1f", color: "#f5f5f7" }}><span style={{ color: "#a1a1a6" }}>{co.persona.name}:</span> {co.qa.question}<br /><span style={{ color: "#2997ff" }}>{qaTitle} · p. {co.qa.page}</span></div>
              </div>
              <div className="wt rv d2" style={{ background: "#f5f5f7" }}>
                <span style={{ fontSize: 14, fontWeight: 600, color: "#0066cc" }}>In Slack</span>
                <p className="disp" style={{ margin: 0, fontSize: 24, fontWeight: 600 }}>/ask in any channel</p>
                <p style={{ margin: 0, color: "#6e6e73", lineHeight: 1.5 }}>The same cited answer, without leaving the conversation. Unanswered questions still land in Gaps.</p>
                <div className="mock" style={{ background: "#fff", boxShadow: "0 0 0 1px rgba(0,0,0,.08)" }}><b>/ask</b> {slackQ}</div>
              </div>
              <div className="wt rv d3" style={{ background: "#272729", color: "#f5f5f7" }}>
                <span style={{ fontSize: 14, fontWeight: 600, color: "#2997ff" }}>On your website</span>
                <p className="disp" style={{ margin: 0, fontSize: 24, fontWeight: 600 }}>A widget for customers</p>
                <p style={{ margin: 0, color: "#a1a1a6", lineHeight: 1.5 }}>Answer customers from public documents only, with a key you can revoke any time.</p>
                <div className="mock" style={{ background: "#1d1d1f", color: "#f5f5f7" }}>Ask {co.name} a question…</div>
              </div>
            </div>
          </div>
        </section>

        <section ref={vsRef} className={vsSeen} style={{ background: "#f5f5f7", color: "#1d1d1f", padding: "128px 0" }}>
          <div className="wide" style={{ display: "flex", flexDirection: "column", gap: 40 }}>
            <h2 className="h2 disp rv" style={{ maxWidth: "18ch" }}>What changes in the first month.</h2>
            <div className="vs">
              <div className="vs-col rv d1" style={{ background: "#fff" }}>
                <p className="eyebrow" style={{ color: "#6e6e73", marginBottom: 8 }}>Without it</p>
                {[["New questions", "Go to whoever has been there longest."], ["Answers", "Depend on who you ask and when."], ["Missing docs", "Nobody notices until it goes wrong."], ["Onboarding", "Shadowing, and hoping it sticks."]].map(([a, b]) => <div key={a} className="vs-row"><span>{a}</span><span>{b}</span></div>)}
              </div>
              <div className="vs-col dark-col rv d2" style={{ background: "#000", color: "#f5f5f7" }}>
                <p className="eyebrow" style={{ color: "#2997ff", marginBottom: 8 }}>With RAGaaS</p>
                {[["New questions", "Answered in seconds, from your documents."], ["Answers", "The same every time, with the page they came from."], ["Missing docs", "Ranked by how often people ask for them."], ["Onboarding", "A tested path and a manager's sign-off."]].map(([a, b]) => <div key={a} className="vs-row"><span>{a}</span><span>{b}</span></div>)}
              </div>
            </div>
          </div>
        </section>

        <section id="calc" ref={calcRef} className={calcSeen} style={{ background: "#000", color: "#f5f5f7", padding: "128px 0" }}>
          <div className="wide calc">
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <p className="eyebrow rv" style={{ color: "#2997ff" }}>Estimate it for your team</p>
              <h2 className="h2 disp rv d1" style={{ marginBottom: 14 }}>How much time goes to the same questions?</h2>
              {([["team", "People on the team", 5, 200, 5, ""], ["qpw", "Questions each person asks a colleague per week", 1, 20, 1, ""], ["mins", "Minutes lost per interruption, both people", 2, 30, 1, ""], ["share", "Share your documents could answer", 10, 90, 5, "%"]] as const).map(([k, label, min, max, stepV, unit], i) => (
                <label key={k} className={`sl rv ${i < 2 ? "d2" : "d3"}`}>
                  <span className="sl-top"><span>{label}</span><b>{calc[k]}{unit}</b></span>
                  <input type="range" min={min} max={max} step={stepV} value={calc[k]} onChange={setCalcKey(k)} />
                </label>
              ))}
            </div>
            <div className="calc-out rv d2" aria-live="polite">
              <span className="try-k">Hours a month answered by your documents instead</span>
              <span className="big disp">{hours.toLocaleString("en")}</span>
              <span style={{ fontSize: 17, color: "#a1a1a6", lineHeight: 1.5 }}>About {perPerson} minutes a week for each person, and the people most often interrupted get most of it back.</span>
              <span style={{ fontSize: 13, color: "#6e6e73", lineHeight: 1.5, marginTop: 8 }}>An estimate from the numbers you set: people × questions × minutes × share, over 4.33 weeks a month. It is not a measured result.</span>
            </div>
          </div>
        </section>

        <section ref={proofRef} className={proofSeen} style={{ background: "#fff", color: "#1d1d1f", padding: "112px 0" }}>
          <div className="wide" style={{ display: "flex", flexDirection: "column", gap: 36 }}>
            <h2 className="h2 disp rv" style={{ maxWidth: "18ch" }}>Built so nobody has to take it on trust.</h2>
            <div className="proof rv d1">
              <div className="proof-i"><b>Cited</b><span>Every answer names its document and page.</span></div>
              <div className="proof-i"><b>Access-checked</b><span>Restricted documents never reach an answer, lesson or test.</span></div>
              <div className="proof-i"><b>Private</b><span>Each workspace is isolated and never used to train a model.</span></div>
              <div className="proof-i"><b>PDF and Word</b><span>Up to 30 MB a file. [YOUR PRICING] after the free tier.</span></div>
            </div>
            <div className="sec-grid rv d2" style={{ marginTop: 20 }}>
              {[["Who sees what", "Tag each document with a team or clearance. People only get answers, lessons and tests from documents they're cleared for."],
                ["Deleting a document", "Removes the file, its text and its search index. It stops appearing in answers straight away."],
                ["Where data lives", "On Google Cloud in [YOUR REGION]. Each workspace is kept separate from every other."],
                ["Model training", "Your documents and questions are never used to train a model."],
                ["Website widget keys", "The widget only searches public documents, and you can revoke its key at any time."],
                ["Roles", "Admins manage members and documents, uploaders add documents, viewers ask. Every change is checked on the server."]].map(([a, b]) => (
                <div key={a} className="sec-c"><b>{a}</b><span>{b}</span></div>
              ))}
            </div>
          </div>
        </section>

        <section ref={storiesRef} className={storiesSeen} style={{ background: "#f5f5f7", color: "#1d1d1f", padding: "120px 0" }}>
          <div className="wide" style={{ display: "flex", flexDirection: "column", gap: 32 }}>
            <h2 className="h2 disp rv">From teams using it.</h2>
            <div className="stories rv d1">
              {[0, 1, 2].map((i) => <div key={i} className="story"><q>[A real customer quote goes here]</q><small>[Name, role, company] · reserved for a real customer story</small></div>)}
            </div>
          </div>
        </section>

        <section ref={logRef} className={logSeen} style={{ background: "#fff", color: "#1d1d1f", padding: "120px 0" }}>
          <div className="wrap" style={{ maxWidth: 860, display: "flex", flexDirection: "column", gap: 28 }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <p className="eyebrow rv">What's new</p>
              <h2 className="h2 disp rv d1">Shipped recently.</h2>
            </div>
            <div className="log rv d2">
              {CHANGELOG.map(([date, title, body]) => <div key={title} className="log-row"><span className="log-date">{date}</span><div><b>{title}</b><span>{body}</span></div></div>)}
            </div>
          </div>
        </section>

        <section id="faq" style={{ background: "#f5f5f7", color: "#1d1d1f", padding: "120px 0" }}>
          <div className="wrap" style={{ maxWidth: 760, display: "flex", flexDirection: "column", gap: 28 }}>
            <h2 className="h2 disp">Questions</h2>
            <div>
              {FAQS.map(([q, a], i) => (
                <div key={q} className="faq-i">
                  <button type="button" className="faq-q" aria-expanded={faq === i} aria-controls={`faq-${i}`} onClick={() => setFaq((f) => (f === i ? -1 : i))}>
                    {q}<svg className="chev" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#1d1d1f" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
                  </button>
                  <div id={`faq-${i}`} className={faq === i ? "faq-a is-open" : "faq-a"} role="region">
                    <div className="faq-in"><p style={{ margin: 0, paddingBottom: 22, fontSize: 17, lineHeight: 1.5, color: "#6e6e73", maxWidth: "60ch" }}>{a}</p></div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section id="start" style={{ background: "#000", padding: "140px 0", textAlign: "center" }}>
          <div className="wrap" style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 22 }}>
            <h2 className="h2 disp" style={{ maxWidth: "16ch" }}>Stop answering the same question twice.</h2>
            <p className="lede" style={{ maxWidth: "40ch", color: "#a1a1a6" }}>Upload one handbook and see what it answers today.</p>
            <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "center", gap: 14, marginTop: 8 }}>
              <a className="pill pill-blue" href="/signup" onClick={(e) => go(e, "/signup")}>Start free</a>
              <a className="pill pill-ghost" href="#top">Replay the journey</a>
            </div>
          </div>
        </section>
      </main>

      <footer style={{ background: "#f5f5f7" }}>
        <div className="wide" style={{ display: "flex", flexWrap: "wrap", gap: 20, alignItems: "center", minHeight: 72, fontSize: 12, color: "#6e6e73" }}>
          <span>RAGaaS · Answers from your own documents. Example companies are fictional.</span>
          <div style={{ flex: 1 }} />
          <a href="/access" onClick={(e) => go(e, "/access")} style={{ color: "#424245" }}>Privacy</a>
          <a href="/signup" onClick={(e) => go(e, "/signup")} style={{ color: "#424245" }}>Contact</a>
        </div>
      </footer>
    </div>
  );
}
