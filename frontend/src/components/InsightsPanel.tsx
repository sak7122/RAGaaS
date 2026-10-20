// Insights: what the team asks, what the documents can't answer, and what to do next.
// Leads with one sentence and the knowledge gaps (each with "Draft the answer"),
// then the weekly trend, feedback, channels and which documents do the work.
import { FormEvent, useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  ChevronDown, ChevronRight, Clock, FileText, Mail, MessageSquare, PenLine, RefreshCcw, ThumbsDown, ThumbsUp,
} from "lucide-react";
import { CountUp } from "./academyMotion";
import "./insights.css";

export type Insights = {
  total_queries: number;
  avg_confidence: number;
  answered_rate: number;
  answered?: number;
  top_questions: { question: string; count: number; avg_score: number; variants?: string[] }[];
  gaps: { question: string; count: number; best_score: number; avg_score: number; variants?: string[]; last_asked?: string | null }[];
  faqs: { question: string; answer: string; score: number; count: number }[];
  window: number;
  trend?: { week: string; questions: number; answered: number }[];
  channels?: { source: string; count: number }[];
  documents?: { file_name: string; title: string; citations: number; uploaded_at?: string }[];
  feedback?: { helpful: number; unhelpful: number; rate: number | null; recent_unhelpful: { question: string; answer: string; ts: string }[] };
};

type Api = (path: string, init?: RequestInit) => Promise<Response>;

interface Props {
  fetchInsights: () => Promise<Insights | null>;
  onQuickAsk: (q: string) => void;
  api: Api;
}

const EASE = [0.23, 1, 0.32, 1] as const;
const rise = (i = 0) => ({
  initial: { opacity: 0, transform: "translateY(10px)" },
  animate: { opacity: 1, transform: "translateY(0px)", transition: { duration: 0.4, ease: EASE, delay: i * 0.05 } },
});
const pct = (x: number) => `${Math.round(x * 100)}%`;
const CHANNEL: Record<string, string> = { chat: "Web chat", slack: "Slack", whatsapp: "WhatsApp", widget: "Website widget" };

function readMinutes(): number {
  try { return Math.max(1, Math.min(120, Number(localStorage.getItem("ragaas:minutes-per-question")) || 5)); } catch { return 5; }
}

// ── Draft the answer (closes a gap) ──────────────────────────────────────────
function DraftAnswer({ question, api, onDone, onClose }: {
  question: string; api: Api; onDone: () => void; onClose: () => void;
}) {
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError("");
    try {
      const r = await api("/api/gaps/answer", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, answer: answer.trim() }),
      });
      if (!r.ok) {
        const b = await r.json().catch(() => ({}));
        setError(typeof b.detail === "string" ? b.detail : "Couldn't save that answer.");
        return;
      }
      onDone();
    } finally { setBusy(false); }
  }
  return (
    <motion.form className="in-draft" onSubmit={save}
      initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto", transition: { duration: 0.3, ease: EASE } }}
      exit={{ opacity: 0, height: 0, transition: { duration: 0.15 } }}>
      <label className="in-draft-label" htmlFor="in-draft-a">Write the answer in two or three sentences</label>
      <textarea id="in-draft-a" className="in-draft-input" rows={3} maxLength={4000} value={answer} autoFocus
        onChange={(e) => setAnswer(e.target.value)}
        placeholder="e.g. Treatment over $600 can be split into three monthly payments, set up at the front desk before treatment." />
      <p className="in-muted in-small">Saved to “Answers from your team”, searchable straight away and cited like any document.</p>
      {error && <p className="in-error">{error}</p>}
      <div className="in-row">
        <button type="button" className="in-btn" onClick={onClose}>Cancel</button>
        <button type="submit" className="in-btn is-primary" disabled={busy || answer.trim().length < 3}>{busy ? "Saving…" : "Save and make searchable"}</button>
      </div>
    </motion.form>
  );
}

// ── Weekly trend: answered vs not, stacked; hover for numbers; table view ───
function Trend({ data }: { data: NonNullable<Insights["trend"]> }) {
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const max = Math.max(1, ...data.map((d) => d.questions));
  const fmt = (w: string) => new Date(w + "T00:00:00").toLocaleDateString(undefined, { day: "numeric", month: "short" });
  return (
    <div className="in-trend">
      <div className="in-legend" aria-hidden="true">
        <span><i className="sw is-answered" /> Answered</span>
        <span><i className="sw is-gap" /> Not answered</span>
        <button type="button" className="in-link" onClick={() => setTable((v) => !v)}>{table ? "Show chart" : "Show table"}</button>
      </div>
      {table ? (
        <table className="in-table">
          <thead><tr><th>Week of</th><th>Questions</th><th>Answered</th></tr></thead>
          <tbody>{data.map((d) => <tr key={d.week}><td>{fmt(d.week)}</td><td className="num">{d.questions}</td><td className="num">{d.answered}</td></tr>)}</tbody>
        </table>
      ) : (
        <div className="in-bars" role="img" aria-label={`Questions per week: ${data.map((d) => `${fmt(d.week)} ${d.questions}`).join(", ")}`}
          onMouseLeave={() => setHover(null)}>
          {data.map((d, i) => {
            const h = (d.questions / max) * 100;
            const a = d.questions ? (d.answered / d.questions) * 100 : 0;
            return (
              <div key={d.week} className={`in-col${hover === i ? " is-hover" : ""}`} onMouseEnter={() => setHover(i)}>
                <div className="in-col-plot">
                  <motion.div className="in-stack" style={{ height: `${h}%` }}
                    initial={{ transform: "scaleY(0)" }} animate={{ transform: "scaleY(1)", transition: { duration: 0.6, ease: EASE, delay: 0.1 + i * 0.04 } }}>
                    {d.questions > d.answered && <span className="seg is-gap" style={{ flexGrow: d.questions - d.answered }} />}
                    {d.answered > 0 && <span className="seg is-answered" style={{ flexGrow: d.answered }} />}
                  </motion.div>
                  {hover === i && (
                    <div className="in-tip" role="status">
                      <b>Week of {fmt(d.week)}</b>
                      <span>{d.questions} question{d.questions === 1 ? "" : "s"}</span>
                      <span>{d.answered} answered{d.questions ? ` (${Math.round(a)}%)` : ""}</span>
                    </div>
                  )}
                </div>
                <span className="in-col-x">{i === data.length - 1 ? "This week" : fmt(d.week)}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function HBars({ rows, label }: { rows: { key: string; label: string; value: number; note?: string }[]; label: string }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <ul className="in-hbars" aria-label={label}>
      {rows.map((r, i) => (
        <li key={r.key} title={`${r.label}: ${r.value}`}>
          <span className="in-hbar-label">{r.label}</span>
          <span className="in-hbar-track">
            <motion.b initial={{ transform: "scaleX(0)" }}
              animate={{ transform: `scaleX(${r.value / max})`, transition: { duration: 0.7, ease: EASE, delay: 0.1 + i * 0.05 } }} />
          </span>
          <span className="in-hbar-val num">{r.value}{r.note ? <span className="in-muted"> {r.note}</span> : null}</span>
        </li>
      ))}
    </ul>
  );
}

// ── Weekly email digest ──────────────────────────────────────────────────────
function Digest({ api }: { api: Api }) {
  const [d, setD] = useState<{ subject: string; text: string; subscribed: boolean; email: string | null; email_ready: boolean } | null>(null);
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState("");
  async function load() {
    const r = await api("/api/insights/digest");
    if (r.ok) setD(await r.json());
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);
  if (!d) return null;
  async function toggle() {
    const r = await api("/api/insights/digest/subscribe", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ on: !d!.subscribed }),
    });
    if (r.ok) setD({ ...d!, subscribed: !d!.subscribed });
  }
  async function sendNow() {
    setMsg("Sending…");
    const r = await api("/api/insights/digest/send", { method: "POST" });
    const b = await r.json().catch(() => ({}));
    setMsg(r.ok && b.sent ? `Sent to ${d!.email}.` : "Couldn't send email from this server.");
  }
  return (
    <section className="in-card" aria-labelledby="in-digest-h">
      <div className="in-card-head">
        <h3 id="in-digest-h"><Mail size={16} aria-hidden="true" /> Weekly summary by email</h3>
        <label className="in-switch">
          <input type="checkbox" checked={d.subscribed} onChange={toggle} />
          <span aria-hidden="true" /> {d.subscribed ? "On" : "Off"}
        </label>
      </div>
      <p className="in-muted">Every Monday: questions asked, the share answered, new gaps and one suggested fix{d.email ? `, sent to ${d.email}` : ""}.</p>
      <div className="in-row">
        <button type="button" className="in-btn" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          {open ? "Hide preview" : "Preview this week's email"}
        </button>
        {d.email_ready && <button type="button" className="in-btn" onClick={sendNow}>Email it to me now</button>}
        {msg && <span className="in-muted in-small" role="status">{msg}</span>}
      </div>
      <AnimatePresence>
        {open && (
          <motion.pre className="in-email" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}>
            <b>{d.subject}</b>{"\n\n"}{d.text}
          </motion.pre>
        )}
      </AnimatePresence>
    </section>
  );
}

export function InsightsPanel({ fetchInsights, onQuickAsk, api }: Props) {
  const [data, setData] = useState<Insights | null>(null);
  const [loading, setLoading] = useState(true);
  const [drafting, setDrafting] = useState<string | null>(null);
  const [closed, setClosed] = useState<string[]>([]);
  const [openGap, setOpenGap] = useState<string | null>(null);
  const [minutes, setMinutes] = useState(readMinutes);

  async function load() {
    setLoading(true);
    setData(await fetchInsights());
    setLoading(false);
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  const unused = useMemo(() => (data?.documents ?? []).filter((d) => d.citations === 0 && d.file_name !== "team-answers.md"), [data]);

  if (loading && !data) return <div className="in-wrap"><div className="in-skel"><i /><i /><i /></div></div>;
  if (!data) return <div className="in-wrap"><p className="in-muted">Couldn't load Insights. Only admins can see this page.</p></div>;

  const answered = data.answered ?? Math.round(data.answered_rate * data.total_queries);
  const savedHours = (answered * minutes) / 60;
  const fb = data.feedback;
  const gaps = data.gaps.filter((g) => !closed.includes(g.question));

  function setMins(v: number) {
    const m = Math.max(1, Math.min(120, v || 1));
    setMinutes(m);
    try { localStorage.setItem("ragaas:minutes-per-question", String(m)); } catch { /* private mode */ }
  }

  return (
    <div className="in-wrap">
      <header className="in-hero">
        <div>
          <motion.p className="in-eyebrow" {...rise(0)}>Insights · last {Math.min(data.total_queries, data.window).toLocaleString()} questions</motion.p>
          <motion.h2 className="in-title" {...rise(1)}>
            {data.total_queries === 0
              ? "No questions yet. Once your team starts asking, this page shows what they need."
              : <>Your team asked <CountUp value={data.total_queries} format={(n) => Math.round(n).toLocaleString()} /> questions. <span className="in-hl"><CountUp value={data.answered_rate * 100} format={(n) => `${Math.round(n)}%`} /></span> were answered from your documents.</>}
          </motion.h2>
        </div>
        <button type="button" className="in-btn" onClick={load} disabled={loading}><RefreshCcw size={13} className={loading ? "spin" : ""} /> Refresh</button>
      </header>

      <div className="in-tiles">
        <motion.div className="in-tile" {...rise(2)}>
          <span className="in-k">Answered from documents</span>
          <span className="in-v num">{pct(data.answered_rate)}</span>
          <span className="in-bar"><motion.b initial={{ transform: "scaleX(0)" }} animate={{ transform: `scaleX(${data.answered_rate})`, transition: { duration: 0.8, ease: EASE, delay: 0.2 } }} /></span>
          <span className="in-muted in-small">{(data.total_queries - answered).toLocaleString()} found no strong passage</span>
        </motion.div>
        <motion.div className="in-tile" {...rise(3)}>
          <span className="in-k">Marked helpful</span>
          <span className="in-v num">{fb?.rate != null ? pct(fb.rate) : "–"}</span>
          <span className="in-muted in-small">
            {fb && fb.helpful + fb.unhelpful > 0
              ? <><ThumbsUp size={11} aria-hidden="true" /> {fb.helpful} · <ThumbsDown size={11} aria-hidden="true" /> {fb.unhelpful} rated answers</>
              : "No ratings yet. People rate answers with 👍 / 👎 in chat."}
          </span>
        </motion.div>
        <motion.div className="in-tile" {...rise(4)}>
          <span className="in-k">Time saved (estimate)</span>
          <span className="in-v num">{savedHours >= 10 ? Math.round(savedHours) : savedHours.toFixed(1)} h</span>
          <label className="in-muted in-small in-mins">
            <Clock size={11} aria-hidden="true" /> {answered} answers ×
            <input type="number" min={1} max={120} value={minutes} onChange={(e) => setMins(Number(e.target.value))} aria-label="Minutes saved per answered question" />
            min each
          </label>
        </motion.div>
      </div>

      <section className="in-card" aria-labelledby="in-gaps-h">
        <div className="in-card-head">
          <h3 id="in-gaps-h">Knowledge gaps</h3>
          <span className="in-muted">Questions your documents couldn't answer, most asked first. Similar wording is grouped.</span>
        </div>
        {gaps.length === 0 ? (
          <p className="in-empty">{closed.length ? "Every gap here has an answer now. 🎉" : "No unanswered questions. Your documents cover what people ask."}</p>
        ) : (
          <ol className="in-gaps">
            {gaps.map((g, i) => (
              <motion.li key={g.question} {...rise(i)} layout="position">
                <div className="in-gap">
                  <span className="in-rank num">{i + 1}</span>
                  <button type="button" className="in-gap-q" onClick={() => setOpenGap(openGap === g.question ? null : g.question)} aria-expanded={openGap === g.question}>
                    <b>{g.question}</b>
                    <span className="in-muted in-small">
                      Asked {g.count}× · best passage matched {pct(g.best_score)}
                      {g.variants && g.variants.length > 0 && ` · ${g.variants.length} other wording${g.variants.length === 1 ? "" : "s"}`}
                    </span>
                  </button>
                  <div className="in-gap-acts">
                    <button type="button" className="in-btn is-primary" onClick={() => setDrafting(drafting === g.question ? null : g.question)}>
                      <PenLine size={13} aria-hidden="true" /> Draft the answer
                    </button>
                    <button type="button" className="in-btn" onClick={() => onQuickAsk(g.question)} title="Try it in chat">Ask</button>
                  </div>
                </div>
                <AnimatePresence>
                  {openGap === g.question && g.variants && g.variants.length > 0 && (
                    <motion.ul className="in-variants" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}>
                      {g.variants.map((v) => <li key={v}>“{v}”</li>)}
                    </motion.ul>
                  )}
                  {drafting === g.question && (
                    <DraftAnswer key="draft" question={g.question} api={api}
                      onClose={() => setDrafting(null)}
                      onDone={() => { setDrafting(null); setClosed((c) => [...c, g.question]); }} />
                  )}
                </AnimatePresence>
              </motion.li>
            ))}
          </ol>
        )}
      </section>

      {data.trend && data.trend.some((t) => t.questions > 0) && (
        <section className="in-card" aria-labelledby="in-trend-h">
          <div className="in-card-head"><h3 id="in-trend-h">Questions per week</h3></div>
          <Trend data={data.trend} />
        </section>
      )}

      {fb && fb.recent_unhelpful.length > 0 && (
        <section className="in-card" aria-labelledby="in-fb-h">
          <div className="in-card-head">
            <h3 id="in-fb-h"><ThumbsDown size={16} aria-hidden="true" /> Answers marked not helpful</h3>
            <span className="in-muted">Usually a document is out of date or missing a detail.</span>
          </div>
          <ul className="in-list">
            {fb.recent_unhelpful.map((u) => (
              <li key={u.ts + u.question}>
                <b>{u.question}</b>
                {u.answer && <p className="in-muted in-small in-clamp">{u.answer}</p>}
                <div className="in-row">
                  <button type="button" className="in-btn" onClick={() => setDrafting(u.question)}><PenLine size={13} aria-hidden="true" /> Write a better answer</button>
                </div>
                <AnimatePresence>
                  {drafting === u.question && !gaps.some((g) => g.question === u.question) && (
                    <DraftAnswer question={u.question} api={api} onClose={() => setDrafting(null)} onDone={() => setDrafting(null)} />
                  )}
                </AnimatePresence>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="in-two">
        <section className="in-card" aria-labelledby="in-top-h">
          <div className="in-card-head"><h3 id="in-top-h"><MessageSquare size={16} aria-hidden="true" /> Most asked</h3></div>
          {data.top_questions.length === 0 ? <p className="in-empty">Nothing yet.</p> : (
            <ul className="in-list">
              {data.top_questions.map((q) => (
                <li key={q.question} className="in-top">
                  <button type="button" className="in-top-q" onClick={() => onQuickAsk(q.question)}>
                    <span>{q.question}</span><ChevronRight size={14} aria-hidden="true" />
                  </button>
                  <span className="in-muted in-small num">{q.count}× · {pct(q.avg_score)} match</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="in-card" aria-labelledby="in-ch-h">
          <div className="in-card-head"><h3 id="in-ch-h">Where people ask</h3></div>
          {(data.channels ?? []).length === 0 ? <p className="in-empty">Nothing yet.</p> : (
            <HBars label="Questions by channel" rows={(data.channels ?? []).map((c) => ({ key: c.source, label: CHANNEL[c.source] ?? c.source, value: c.count }))} />
          )}
        </section>
      </div>

      {(data.documents ?? []).length > 0 && (
        <section className="in-card" aria-labelledby="in-docs-h">
          <div className="in-card-head">
            <h3 id="in-docs-h"><FileText size={16} aria-hidden="true" /> Which documents do the work</h3>
            <span className="in-muted">Times each document was cited in an answer.</span>
          </div>
          <HBars label="Citations per document" rows={(data.documents ?? []).filter((d) => d.citations > 0).slice(0, 8)
            .map((d) => ({ key: d.file_name, label: d.title, value: d.citations }))} />
          {unused.length > 0 && (
            <p className="in-note">
              <b>{unused.length} document{unused.length === 1 ? " hasn't" : "s haven't"} answered anything yet:</b>{" "}
              {unused.slice(0, 5).map((d) => d.title).join(", ")}{unused.length > 5 ? "…" : ""}. They may be out of date, duplicated, or about topics nobody asks.
            </p>
          )}
        </section>
      )}

      {data.faqs.length > 0 && (
        <section className="in-card" aria-labelledby="in-faq-h">
          <div className="in-card-head">
            <h3 id="in-faq-h">Answers your team keeps needing</h3>
            <span className="in-muted">Repeated questions with strong answers. Good candidates for onboarding.</span>
          </div>
          <ul className="in-faqs">
            {data.faqs.map((f) => <Faq key={f.question} f={f} />)}
          </ul>
        </section>
      )}

      <Digest api={api} />
    </div>
  );
}

function Faq({ f }: { f: Insights["faqs"][number] }) {
  const [open, setOpen] = useState(false);
  return (
    <li>
      <button type="button" className="in-faq-q" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span>{f.question}</span>
        <span className="in-muted in-small num">{f.count}× · {pct(f.score)}</span>
        <ChevronDown size={14} className={open ? "is-open" : ""} aria-hidden="true" />
      </button>
      <AnimatePresence>
        {open && (
          <motion.p className="in-faq-a" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}>
            {f.answer}
          </motion.p>
        )}
      </AnimatePresence>
    </li>
  );
}
