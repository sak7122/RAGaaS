// Academy learner app (M3): today's plan → lesson → test → graded feedback.
// Backend: /api/academy/learn/* (answers are only ever revealed after submitting).
import { FormEvent, Ref, useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft, ArrowRight, Award, CircleCheck, CircleX, Clock, Download, MessageCircleQuestion, Repeat, RotateCcw,
  TriangleAlert,
} from "lucide-react";
import { Markdown, Notice, downloadFile, readError } from "./academyShared";

type Api = (path: string, init?: RequestInit) => Promise<Response>;
type Source = { doc_id: string; title: string };
type ModuleSummary = {
  id: string; position: number; title: string; est_minutes: number; item_count: number;
  passed: boolean; best_score: number | null; review_due_at: string | null;
};
type LearnPath = {
  id: string; title: string; pass_mark: number; status: "assigned" | "in_progress" | "passed" | "certified";
  score: number | null; modules_total: number; modules_passed: number; modules: ModuleSummary[];
  due_at: string | null; overdue: boolean; certified_at: string | null;
};
type PlanEntry = {
  kind: "review" | "next"; path_id: string; path_title: string;
  module_id: string; module_title: string; est_minutes: number;
};
type Plan = {
  preview: boolean; clearance: number; department: string | null; role: string | null;
  paths: LearnPath[]; today: PlanEntry[]; today_minutes: number; reviews_due: number;
};
type ItemType = "mcq" | "true_false" | "short_answer" | "scenario";
type LearnItem = { id: string; type: ItemType; stem: string; options: string[] | null };
type LearnModule = {
  id: string; path_id: string; path_title: string; position: number; title: string; lesson_md: string;
  est_minutes: number; pass_mark: number; sources: Source[]; items: LearnItem[];
  progress: { best_score: number; passed: boolean; attempts: number } | null; review_due_at: string | null;
};
type ItemResult = {
  item_id: string; type: ItemType; correct: boolean; score: number; feedback: string;
  explanation: string | null; correct_answer: number | boolean | null; model_answer: string | null; sources: Source[];
};
type SubmitResult = {
  module_id: string; score: number; passed: boolean; pass_mark: number; preview: boolean;
  review_due_at: string | null; results: ItemResult[]; path: LearnPath;
};
type Answer = number | boolean | string;

const NETWORK_ERROR = "Network error. Check your connection and try again.";
const LEVELS = ["public", "internal", "restricted"];
const STATUS_LABEL: Record<LearnPath["status"], string> = {
  assigned: "Not started", in_progress: "In progress", passed: "Completed", certified: "Certified",
};
const isFreeText = (t: ItemType) => t === "short_answer" || t === "scenario";
const pct = (x: number) => `${Math.round(x * 100)}%`;

function day(iso: string): string {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "" : d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}

function hasAnswer(a: Answer | undefined): a is Answer {
  return a !== undefined && !(typeof a === "string" && !a.trim());
}

function sourceTitles(sources: Source[]): string {
  return sources.map((s) => s.title).join(", ");
}

// ── Plan (home) ───────────────────────────────────────────────────────────────
export function LearnerView({ api }: { api: Api }) {
  const [plan, setPlan] = useState<Plan | null>(null);
  const [error, setError] = useState("");
  const [moduleId, setModuleId] = useState<string | null>(null);

  const loadPlan = useCallback(async () => {
    try {
      const r = await api("/api/academy/learn/plan");
      if (!r.ok) { setError(await readError(r)); return; }
      setPlan(await r.json());
      setError("");
    } catch { setError(NETWORK_ERROR); }
  }, [api]);

  useEffect(() => { loadPlan(); }, [loadPlan]);

  if (moduleId) {
    return <ModuleView api={api} moduleId={moduleId} onOpen={setModuleId} onSubmitted={loadPlan}
                       onBack={() => setModuleId(null)} />;
  }
  if (!plan) {
    return (
      <div className="acad-section">
        {error ? <Notice kind="error">{error}</Notice> : <p className="acad-muted">Loading your plan…</p>}
      </div>
    );
  }

  const audience = [plan.department, plan.role].filter(Boolean).join(" · ");
  return (
    <div className="acad-section">
      {plan.preview && (
        <Notice kind="info">
          Learner preview: you can see every published path. Nothing you submit here is recorded.
        </Notice>
      )}
      {error && <Notice kind="error" onClose={() => setError("")}>{error}</Notice>}

      <section className="acad-card" aria-labelledby="learn-today-h">
        <div className="learn-card-head">
          <h3 className="acad-h3" id="learn-today-h">Today</h3>
          {plan.today.length > 0 && <span className="acad-count"><Clock size={12} aria-hidden="true" /> about {plan.today_minutes} min</span>}
          {plan.reviews_due > 0 && <span className="learn-kind is-review">{plan.reviews_due} review{plan.reviews_due > 1 ? "s" : ""} due</span>}
        </div>
        {plan.today.length > 0 ? (
          <ol className="learn-today">
            {plan.today.map((e) => (
              <li key={`${e.kind}-${e.module_id}`}>
                <button type="button" className="learn-task" onClick={() => setModuleId(e.module_id)}>
                  <span className={`learn-kind is-${e.kind}`}>
                    {e.kind === "review" ? <><Repeat size={12} aria-hidden="true" /> Review</> : "Next"}
                  </span>
                  <span className="learn-task-main">
                    <span className="acad-strong">{e.module_title}</span>
                    <span className="acad-muted acad-small">{e.path_title}</span>
                  </span>
                  <span className="acad-muted acad-small learn-task-time">~{e.est_minutes} min</span>
                  <ArrowRight size={16} aria-hidden="true" className="learn-task-arrow" />
                </button>
              </li>
            ))}
          </ol>
        ) : plan.paths.length > 0 ? (
          <p className="acad-empty">You're all caught up. Reviews will show up here when they're due.</p>
        ) : (
          <p className="acad-empty">
            No learning paths are assigned to you yet. Your admin publishes them for your role. In the meantime you
            can ask questions about company documents in Chat.
          </p>
        )}
      </section>

      {plan.paths.map((p) => (
        <PathCard key={p.id} path={p} onOpen={setModuleId} preview={plan.preview}
                  onCertificate={async () => {
                    const err = await downloadFile(api, `/api/academy/learn/paths/${p.id}/certificate`, "certificate.pdf");
                    if (err) setError(err);
                  }} />
      ))}

      {!plan.preview && (
        <p className="acad-help">
          Showing training for {audience || "everyone"} with {LEVELS[plan.clearance] ?? "public"} access.
          If that looks wrong, ask your admin to update your profile.
        </p>
      )}
    </div>
  );
}

function PathCard({ path, onOpen, onCertificate, preview }: {
  path: LearnPath; onOpen: (id: string) => void; onCertificate: () => void; preview: boolean;
}) {
  const share = path.modules_total ? path.modules_passed / path.modules_total : 0;
  const done = path.status === "passed" || path.status === "certified";
  return (
    <section className="acad-card" aria-label={path.title}>
      <div className="learn-card-head">
        <h3 className="acad-h3">{path.title}</h3>
        <span className={`acad-badge${done ? " is-published" : ""}`}>{STATUS_LABEL[path.status]}</span>
        {path.overdue ? (
          <span className="dash-overdue"><TriangleAlert size={14} aria-hidden="true" /> Overdue since {day(path.due_at!)}</span>
        ) : path.due_at && !done ? (
          <span className="acad-muted acad-small">Due {day(path.due_at)}</span>
        ) : null}
        <span className="acad-spacer" />
        <span className="acad-muted acad-small">
          {path.modules_passed} of {path.modules_total} lessons{path.score !== null ? ` · score ${pct(path.score)}` : ""}
        </span>
      </div>
      <div className="learn-bar" role="progressbar" aria-label={`${path.title} progress`}
           aria-valuemin={0} aria-valuemax={path.modules_total} aria-valuenow={path.modules_passed}>
        <span style={{ width: `${share * 100}%` }} />
      </div>
      {path.status === "certified" && (
        <div className="learn-cert">
          <Award size={18} aria-hidden="true" />
          <span className="learn-task-main">
            <span className="acad-strong">You're certified</span>
            <span className="acad-muted acad-small">Signed off {day(path.certified_at!)}</span>
          </span>
          <button type="button" className="authx-btn authx-btn-secondary acad-btn-auto" onClick={onCertificate}>
            <Download size={14} aria-hidden="true" /> Certificate
          </button>
        </div>
      )}
      {path.status === "passed" && !preview && (
        <p className="acad-help">All lessons passed. Your manager signs off next, then your certificate appears here.</p>
      )}
      <ol className="learn-modules">
        {path.modules.map((m) => (
          <li key={m.id}>
            <button type="button" className="learn-module-row" onClick={() => onOpen(m.id)}>
              <span className={`learn-step${m.passed ? " is-done" : ""}`} aria-hidden="true">
                {m.passed ? <CircleCheck size={18} /> : m.position}
              </span>
              <span className="learn-task-main">
                <span className="acad-strong">{m.title}</span>
                <span className="acad-muted acad-small">
                  ~{m.est_minutes} min · {m.item_count} question{m.item_count === 1 ? "" : "s"}
                  {m.best_score !== null && ` · best ${pct(m.best_score)}`}
                  {m.review_due_at && ` · review ${day(m.review_due_at)}`}
                </span>
              </span>
              <span className="sr-only">{m.passed ? "Completed" : "Not completed"}</span>
              <ArrowRight size={16} aria-hidden="true" className="learn-task-arrow" />
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}

// ── Lesson + test ─────────────────────────────────────────────────────────────
function ModuleView({ api, moduleId, onBack, onOpen, onSubmitted }: {
  api: Api; moduleId: string; onBack: () => void; onOpen: (id: string) => void; onSubmitted: () => void;
}) {
  const [mod, setMod] = useState<LearnModule | null>(null);
  const [loadError, setLoadError] = useState("");
  const [answers, setAnswers] = useState<Record<string, Answer>>({});
  const [result, setResult] = useState<SubmitResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const titleRef = useRef<HTMLHeadingElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    setMod(null); setResult(null); setAnswers({}); setLoadError(""); setSubmitError("");
    (async () => {
      try {
        const r = await api(`/api/academy/learn/modules/${moduleId}`);
        if (!alive) return;
        if (!r.ok) { setLoadError(await readError(r)); return; }
        setMod(await r.json());
      } catch { if (alive) setLoadError(NETWORK_ERROR); }
    })();
    return () => { alive = false; };
  }, [api, moduleId]);

  useEffect(() => {
    if (mod) { titleRef.current?.scrollIntoView({ block: "start" }); titleRef.current?.focus({ preventScroll: true }); }
  }, [mod]);
  useEffect(() => { if (result) resultRef.current?.focus(); }, [result]);

  const back = (
    <button type="button" className="authx-link learn-back" onClick={onBack}>
      <ArrowLeft size={14} aria-hidden="true" /> Back to your plan
    </button>
  );
  if (!mod) {
    return (
      <div className="acad-section">
        {back}
        {loadError ? <Notice kind="error">{loadError}</Notice> : <p className="acad-muted">Loading lesson…</p>}
      </div>
    );
  }

  const answered = mod.items.filter((i) => hasAnswer(answers[i.id])).length;
  const unanswered = mod.items.length - answered;
  const results = new Map(result?.results.map((r) => [r.item_id, r]) ?? []);

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    if (!mod || busy) return;
    const payload = mod.items.flatMap((it) => {
      const a = answers[it.id];
      return hasAnswer(a) ? [{ item_id: it.id, response: typeof a === "string" ? a.trim() : a }] : [];
    });
    setBusy(true); setSubmitError("");
    try {
      const r = await api(`/api/academy/learn/modules/${mod.id}/submit`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ answers: payload }),
      });
      if (!r.ok) { setSubmitError(await readError(r)); return; }
      setResult(await r.json());
      onSubmitted();
    } catch { setSubmitError(NETWORK_ERROR); } finally { setBusy(false); }
  }

  function retake() {
    setResult(null); setAnswers({}); setSubmitError("");
    titleRef.current?.scrollIntoView({ block: "start" });
  }

  return (
    <div className="acad-section learn-lesson">
      {back}
      <header className="learn-lesson-head">
        <p className="acad-muted acad-small">{mod.path_title} · Lesson {mod.position}</p>
        <h3 className="learn-title" ref={titleRef} tabIndex={-1}>{mod.title}</h3>
        <p className="acad-muted acad-small">
          ~{mod.est_minutes} min
          {mod.progress && ` · best score ${pct(mod.progress.best_score)}`}
          {mod.progress?.passed && " · completed"}
          {mod.review_due_at && ` · review ${day(mod.review_due_at)}`}
        </p>
      </header>

      <article className="acad-card">
        <Markdown text={mod.lesson_md} />
        {mod.sources.length > 0 && <p className="acad-sources">From: {sourceTitles(mod.sources)}</p>}
      </article>

      <AskBox api={api} />

      {mod.items.length > 0 ? (
        <form className="acad-card" onSubmit={submit} noValidate>
          <div className="learn-card-head">
            <h3 className="acad-h3">Check your understanding</h3>
            <span className="acad-muted acad-small">
              {mod.items.length} question{mod.items.length === 1 ? "" : "s"} · pass mark {pct(mod.pass_mark)}
            </span>
          </div>
          <ol className="learn-qs">
            {mod.items.map((it, i) => (
              <Question key={it.id} item={it} index={i} value={answers[it.id]} result={results.get(it.id)}
                        disabled={busy || !!result}
                        onChange={(v) => setAnswers((prev) => ({ ...prev, [it.id]: v }))} />
            ))}
          </ol>
          {submitError && <Notice kind="error" onClose={() => setSubmitError("")}>{submitError}</Notice>}
          {result ? (
            <ResultSummary ref={resultRef} result={result} currentId={mod.id} currentPosition={mod.position}
                           onRetake={retake} onOpen={onOpen} onBack={onBack} />
          ) : (
            <div className="acad-actions">
              <button type="submit" className="authx-btn authx-btn-primary acad-btn-auto"
                      disabled={busy || answered === 0} aria-busy={busy}>
                {busy ? <><span className="authx-spinner" aria-hidden="true" /> Grading…</> : "Submit answers"}
              </button>
              <span className="acad-muted acad-small" aria-live="polite">
                {answered} of {mod.items.length} answered
                {answered > 0 && unanswered > 0 && " · unanswered questions count as wrong"}
              </span>
            </div>
          )}
        </form>
      ) : (
        <div className="acad-card">
          <p className="acad-muted">This lesson has no questions.</p>
          {submitError && <Notice kind="error">{submitError}</Notice>}
          {result ? (
            <ResultSummary ref={resultRef} result={result} currentId={mod.id} currentPosition={mod.position}
                           onRetake={retake} onOpen={onOpen} onBack={onBack} />
          ) : (
            <div className="acad-actions">
              <button type="button" className="authx-btn authx-btn-primary acad-btn-auto" disabled={busy}
                      onClick={() => submit()}>Mark as read</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Question({ item, index, value, result, disabled, onChange }: {
  item: LearnItem; index: number; value: Answer | undefined; result?: ItemResult;
  disabled: boolean; onChange: (v: Answer) => void;
}) {
  const name = `q-${item.id}`;
  const choice = (key: string, label: string, v: number | boolean) => (
    <label key={key} className={`learn-choice${result && result.correct_answer === v ? " is-answer" : ""}`}>
      <input type="radio" name={name} checked={value === v} onChange={() => onChange(v)} />
      <span>{label}</span>
    </label>
  );
  return (
    <li className={`learn-q${result ? (result.correct ? " is-right" : " is-wrong") : ""}`}>
      <fieldset className="learn-q-set" disabled={disabled}>
        <legend className="learn-q-stem">
          <span className="learn-q-num" aria-hidden="true">{index + 1}</span>
          <span>
            {isFreeText(item.type) && (
              <span className="learn-q-type">{item.type === "scenario" ? "Scenario" : "Short answer"}</span>
            )}
            {item.stem}
          </span>
        </legend>
        {item.type === "mcq" && item.options ? (
          <div className="learn-choices">{item.options.map((o, i) => choice(String(i), o, i))}</div>
        ) : item.type === "true_false" ? (
          <div className="learn-choices learn-choices-row">
            {choice("t", "True", true)}{choice("f", "False", false)}
          </div>
        ) : (
          <>
            <label className="sr-only" htmlFor={`${name}-text`}>Your answer to question {index + 1}</label>
            <textarea id={`${name}-text`} className="authx-input acad-textarea" rows={item.type === "scenario" ? 4 : 3}
                      maxLength={4000} value={typeof value === "string" ? value : ""}
                      placeholder={item.type === "scenario" ? "What would you do, and why?" : "Answer in a sentence or two"}
                      onChange={(e) => onChange(e.target.value)} />
          </>
        )}
      </fieldset>
      {result && <Feedback item={item} result={result} />}
    </li>
  );
}

function Feedback({ item, result }: { item: LearnItem; result: ItemResult }) {
  const correctText = item.type === "mcq" && typeof result.correct_answer === "number"
    ? item.options?.[result.correct_answer]
    : item.type === "true_false" && typeof result.correct_answer === "boolean"
      ? (result.correct_answer ? "True" : "False") : null;
  const generic = result.feedback === "Correct." || result.feedback === "Not quite.";
  return (
    <div className="learn-feedback">
      <p className={`learn-verdict ${result.correct ? "is-right" : "is-wrong"}`}>
        {result.correct ? <CircleCheck size={16} aria-hidden="true" /> : <CircleX size={16} aria-hidden="true" />}
        {result.correct ? "Correct" : "Not quite"}
        {isFreeText(item.type) && <span className="acad-muted"> · {pct(result.score)}</span>}
      </p>
      {!generic && result.feedback && <p>{result.feedback}</p>}
      {!result.correct && correctText && <p>Correct answer: <span className="acad-strong">{correctText}</span></p>}
      {result.model_answer && <p>A full answer covers: <span className="acad-strong">{result.model_answer}</span></p>}
      {result.explanation && <p className="acad-muted">{result.explanation}</p>}
      {result.sources.length > 0 && <p className="acad-sources">Source: {sourceTitles(result.sources)}</p>}
    </div>
  );
}

function ResultSummary({ ref, result, currentId, currentPosition, onRetake, onOpen, onBack }: {
  ref: Ref<HTMLDivElement>; result: SubmitResult; currentId: string; currentPosition: number;
  onRetake: () => void; onOpen: (id: string) => void; onBack: () => void;
}) {
  const mods = result.path.modules;
  const next = mods.find((m) => !m.passed && m.position > currentPosition)
    ?? mods.find((m) => !m.passed && m.id !== currentId)
    ?? mods.find((m) => m.position > currentPosition);
  return (
    <div className={`learn-result ${result.passed ? "is-pass" : "is-fail"}`} ref={ref} tabIndex={-1} role="status">
      <p className="learn-score">{pct(result.score)}</p>
      <div className="learn-result-body">
        <p className="acad-strong">
          {result.passed ? "Passed" : `Not passed yet. You need ${pct(result.pass_mark)}.`}
          {result.path.status === "passed" && ` You've completed ${result.path.title}.`}
        </p>
        <p className="acad-muted acad-small">
          {result.review_due_at
            ? `We'll bring this lesson back for a short review on ${day(result.review_due_at)}.`
            : result.passed ? "Nothing to review here." : ""}
          {result.preview && " Preview only: not recorded."}
        </p>
        <div className="acad-actions">
          {next && (
            <button type="button" className="authx-btn authx-btn-primary acad-btn-auto" onClick={() => onOpen(next.id)}>
              Next lesson <ArrowRight size={14} aria-hidden="true" />
            </button>
          )}
          <button type="button" className="authx-btn authx-btn-secondary acad-btn-auto" onClick={onRetake}>
            <RotateCcw size={14} aria-hidden="true" /> Retake
          </button>
          <button type="button" className="authx-link" onClick={onBack}>Back to your plan</button>
        </div>
      </div>
    </div>
  );
}

// ── Ask the knowledge base (scoped to the learner's access) ───────────────────
type AskResult = { answer: string; grounded: boolean; citations: { doc_id: string; title: string; excerpt: string }[] };

function AskBox({ api }: { api: Api }) {
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<AskResult | null>(null);
  const [error, setError] = useState("");

  async function ask(e: FormEvent) {
    e.preventDefault();
    if (!q.trim() || busy) return;
    setBusy(true); setError("");
    try {
      const r = await api("/api/academy/ask", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: q.trim() }),
      });
      if (!r.ok) { setError(await readError(r)); return; }
      setRes(await r.json());
    } catch { setError(NETWORK_ERROR); } finally { setBusy(false); }
  }

  return (
    <details className="acad-card learn-ask">
      <summary className="learn-ask-summary">
        <MessageCircleQuestion size={16} aria-hidden="true" /> Ask about this lesson
      </summary>
      <form className="learn-ask-form" onSubmit={ask}>
        <label className="sr-only" htmlFor="learn-ask-q">Your question</label>
        <input id="learn-ask-q" className="authx-input" value={q} maxLength={2000}
               placeholder="e.g. Who approves a discount above 15%?" onChange={(e) => setQ(e.target.value)} />
        <button type="submit" className="authx-btn authx-btn-secondary acad-btn-auto" disabled={busy || !q.trim()} aria-busy={busy}>
          {busy ? "Asking…" : "Ask"}
        </button>
      </form>
      {error && <Notice kind="error">{error}</Notice>}
      {res && (
        <div className="learn-ask-answer" aria-live="polite">
          <Markdown text={res.answer} />
          {res.grounded && res.citations.length > 0 && (
            <p className="acad-sources">Source: {[...new Set(res.citations.map((c) => c.title))].join(", ")}</p>
          )}
        </div>
      )}
    </details>
  );
}
