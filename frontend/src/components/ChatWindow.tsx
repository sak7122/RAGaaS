import { CSSProperties, FormEvent, KeyboardEvent, PointerEvent, ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  ArrowUp, ArrowDown, ChevronDown, ChevronLeft, Copy, Check, ChevronRight, Search, Layers, Timer, Hash, Share2, Link,
  BookOpen, FileText, Library, X, Sparkles, CornerDownRight,
} from "lucide-react";
import { StreamingText, toast } from "./ui";
import { DocumentMeta, docTitle } from "./DocumentList";
import { DocumentPicker, fileType } from "./DocumentPicker";
import { Feedback, HistoryBar, HistoryProps, SpeakButton, VoiceButton } from "./chatExtras";
import { AnswerMarkdown, useTypedText } from "./AnswerMarkdown";
import { SearchResponse, SearchView } from "./SearchView";
import "./askChat.css";

// Ask: the signed-in chat. Answers cite document and page; a citation opens the source
// panel with the passage and the searched terms highlighted. Motion follows the public
// site's rules: transform/opacity, strong ease-out, exits faster than entrances
// (reduced motion is handled app-wide by MotionConfig).

export type Citation = {
  file_name: string;
  page: number;
  chunk_index: number;
  excerpt: string;
  score?: number;
};

export type RetrievalTrace = {
  engine: string;
  query_terms: string[];
  chunks_searched: number;
  candidates_ranked: number;
  top_k: number;
  max_score: number;
  latency_ms: number;
  scoped_to?: string[];       // documents the question was limited to; empty = all
};

export type ChatMessage = {
  role: "user" | "assistant";
  text: string;
  citations?: Citation[];
  retrieval?: RetrievalTrace;
  timestamp?: number;
  scope?: string[];           // user turn: documents it searched (empty = all)
  scopedMiss?: string;        // assistant turn: the question the picked documents couldn't answer
  answer_id?: string | null;  // assistant turn: id for 👍/👎 (absent when not recorded)
  helpful?: boolean;          // the asker's rating, once given
  streaming?: boolean;        // assistant turn still being written
  related?: string[];         // assistant turn: suggested next questions (Vertex AI Search)
};

interface ChatWindowProps {
  messages: ChatMessage[];
  question: string;
  isLoading: boolean;
  onQuestionChange: (q: string) => void;
  onSend: (e: FormEvent) => void;
  onAsk: (text: string, scope?: string[]) => void;
  onShare: (msg: ChatMessage) => Promise<string | null>;
  disabled: boolean;
  docs: DocumentMeta[];
  scope: string[];
  onScopeChange: (next: string[]) => void;
  workspaceName?: string;
  onFeedback?: (index: number, helpful: boolean) => void;
  history?: HistoryProps;
  onSearch?: (query: string, files: string[], pageToken?: string | null) => Promise<SearchResponse | null>;
}

const EASE_OUT = [0.23, 1, 0.32, 1] as const;
const EASE_DRAWER = [0.32, 0.72, 0, 1] as const;
const enter = {
  initial: { opacity: 0, transform: "translateY(8px)" },
  animate: { opacity: 1, transform: "translateY(0px)", transition: { duration: 0.28, ease: EASE_OUT } },
};

const FALLBACK_STARTERS = [
  "Summarize the key documents",
  "What does onboarding involve?",
  "Which policies apply to everyone?",
];

function relativeTime(ts?: number): string {
  if (!ts) return "";
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 5) return "just now";
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return `${Math.floor(diff / 3600)}h ago`;
}

const titleFor = (docs: DocumentMeta[], file: string) => {
  const d = docs.find((x) => x.file_name === file);
  return d ? docTitle(d) : file.replace(/[_-]+/g, " ").replace(/\.(pdf|docx)$/i, "");
};

/** One chip per document page, in the order the answer used them. */
function uniqueSources(cs: Citation[]): Citation[] {
  const seen = new Set<string>();
  return cs.filter((c) => {
    const k = `${c.file_name}|${c.page}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** The excerpt with the searched terms marked (what retrieval matched on, not an exact quote span). */
function Highlighted({ text, terms }: { text: string; terms: string[] }) {
  const usable = terms.filter((t) => t.length >= 3).sort((a, b) => b.length - a.length).slice(0, 12);
  if (!usable.length) return <>{text}</>;
  const re = new RegExp(`\\b(${usable.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi");
  const parts = text.split(re);
  return <>{parts.map((p, i) => (i % 2 ? <mark key={i}>{p}</mark> : <span key={i}>{p}</span>))}</>;
}

/** Pointer tilt for cards: sets --rx/--ry, the CSS applies them only on fine pointers. */
function tilt(e: PointerEvent<HTMLElement>) {
  const el = e.currentTarget;
  const r = el.getBoundingClientRect();
  const x = (e.clientX - r.left) / r.width - 0.5;
  const y = (e.clientY - r.top) / r.height - 0.5;
  el.style.setProperty("--rx", `${(-y * 6).toFixed(2)}deg`);
  el.style.setProperty("--ry", `${(x * 8).toFixed(2)}deg`);
  el.style.setProperty("--mx", `${((x + 0.5) * 100).toFixed(1)}%`);
  el.style.setProperty("--my", `${((y + 0.5) * 100).toFixed(1)}%`);
}
function untilt(e: PointerEvent<HTMLElement>) {
  e.currentTarget.style.setProperty("--rx", "0deg");
  e.currentTarget.style.setProperty("--ry", "0deg");
}

function matchLevel(score: number): { label: string; tone: "hi" | "mid" | "lo"; bars: number } {
  if (score >= 0.6) return { label: "Strong match", tone: "hi", bars: 4 };
  if (score >= 0.35) return { label: "Partial match", tone: "mid", bars: 2 + (score >= 0.48 ? 1 : 0) };
  return { label: "Weak match", tone: "lo", bars: 1 };
}

function Confidence({ score }: { score: number }) {
  const m = matchLevel(score);
  return (
    <span className={`ak-conf is-${m.tone}`} title={`Best passage matched ${Math.round(score * 100)}%`}>
      <span className="ak-conf-bars" aria-hidden="true">
        {[0, 1, 2, 3].map((i) => <i key={i} className={i < m.bars ? "on" : ""} style={{ animationDelay: `${0.2 + i * 0.07}s` }} />)}
      </span>
      {m.label}
    </span>
  );
}

function RetrievalTracePanel({ r }: { r: RetrievalTrace }) {
  const [open, setOpen] = useState(false);
  const steps = [
    { icon: Sparkles, label: "Embed the question", detail: `${r.query_terms.length} terms` },
    { icon: Search, label: r.engine, detail: `${r.chunks_searched} passages searched` },
    { icon: Layers, label: "Rank passages", detail: `${r.candidates_ranked} matched` },
    { icon: Hash, label: "Keep the best", detail: `${r.top_k} used · best ${Math.round(r.max_score * 100)}%` },
  ];
  return (
    <div className="ak-trace">
      <button type="button" className="ak-trace-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <Search size={12} aria-hidden="true" />
        <span>{r.chunks_searched} passages searched</span>
        <span className="ak-dot" aria-hidden="true">·</span>
        <span className="ak-ms"><Timer size={11} aria-hidden="true" /> {r.latency_ms} ms</span>
        {r.scoped_to && r.scoped_to.length > 0 && <><span className="ak-dot" aria-hidden="true">·</span><span>{r.scoped_to.length} picked document{r.scoped_to.length === 1 ? "" : "s"}</span></>}
        <ChevronDown size={12} className="ak-chev" aria-hidden="true" />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            className="ak-trace-body"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto", transition: { duration: 0.24, ease: EASE_OUT } }}
            exit={{ opacity: 0, height: 0, transition: { duration: 0.16, ease: EASE_OUT } }}
          >
            <div className="ak-terms">{r.query_terms.map((t, i) => (
              <motion.span key={t} initial={{ opacity: 0, transform: "translateY(4px)" }}
                animate={{ opacity: 1, transform: "translateY(0px)", transition: { delay: i * 0.03, duration: 0.2 } }}>{t}</motion.span>
            ))}</div>
            <ol className="ak-steps">
              {steps.map((s, i) => {
                const Icon = s.icon;
                return (
                  <motion.li key={s.label} initial={{ opacity: 0, transform: "translateX(-6px)" }}
                    animate={{ opacity: 1, transform: "translateX(0px)", transition: { delay: 0.08 + i * 0.06, duration: 0.24, ease: EASE_OUT } }}>
                    <Icon size={13} aria-hidden="true" /><b>{s.label}</b><span>{s.detail}</span>
                  </motion.li>
                );
              })}
            </ol>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** While an answer is on its way: the documents being read, then the stages of the search. */
function Thinking({ docs }: { docs: DocumentMeta[] }) {
  const passages = docs.reduce((n, d) => n + (d.chunks || 0), 0);
  const stages = [
    "Reading your question",
    passages ? `Searching ${passages.toLocaleString()} passages` : "Searching your documents",
    "Ranking the best matches",
    "Writing the answer",
  ];
  const [stage, setStage] = useState(0);
  useEffect(() => {
    const at = [450, 1150, 2000];
    const ids = at.map((ms, i) => setTimeout(() => setStage(i + 1), ms));
    return () => ids.forEach(clearTimeout);
  }, []);
  const shown = docs.slice(0, 4);
  return (
    <div className="ak-thinking" role="status">
      <div className="ak-scan" aria-hidden="true">
        {shown.map((d, i) => (
          <span key={d.file_name} className="ak-scan-doc" style={{ animationDelay: `${i * 0.35}s` }}>
            <i className={`ft-${fileType(d.file_name)}`} />{docTitle(d)}
          </span>
        ))}
        {docs.length > shown.length && <span className="ak-scan-more">+{docs.length - shown.length}</span>}
      </div>
      <div className="ak-stage">
        <span className="ak-stage-dots" aria-hidden="true"><i /><i /><i /></span>
        <AnimatePresence mode="wait" initial={false}>
          <motion.span key={stage}
            initial={{ opacity: 0, transform: "translateY(6px)" }}
            animate={{ opacity: 1, transform: "translateY(0px)", transition: { duration: 0.22, ease: EASE_OUT } }}
            exit={{ opacity: 0, transform: "translateY(-6px)", transition: { duration: 0.12 } }}>
            {stages[stage]}
          </motion.span>
        </AnimatePresence>
      </div>
    </div>
  );
}

function IconSwap({ on, a, b }: { on: boolean; a: ReactNode; b: ReactNode }) {
  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.span
        key={on ? "b" : "a"}
        className="ak-iconswap"
        initial={{ opacity: 0, scale: 0.6 }}
        animate={{ opacity: 1, scale: 1, transition: { duration: 0.15 } }}
        exit={{ opacity: 0, scale: 0.6, transition: { duration: 0.1 } }}
      >
        {on ? b : a}
      </motion.span>
    </AnimatePresence>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  function handleCopy() {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      toast("Copied to clipboard");
      setTimeout(() => setCopied(false), 1500);
    });
  }
  return (
    <button type="button" className="ak-act" onClick={handleCopy} aria-label="Copy answer" title="Copy">
      <IconSwap on={copied} a={<Copy size={13} />} b={<Check size={13} color="var(--green)" />} />
    </button>
  );
}

function ShareButton({ msg, onShare }: { msg: ChatMessage; onShare: (m: ChatMessage) => Promise<string | null> }) {
  const [state, setState] = useState<"idle" | "loading" | "done">("idle");
  async function handle() {
    if (state !== "idle") return;
    setState("loading");
    const url = await onShare(msg);
    if (url) {
      navigator.clipboard.writeText(url).catch(() => {});
      toast("Share link copied");
      setState("done");
      setTimeout(() => setState("idle"), 2500);
    } else {
      setState("idle");
      toast("Couldn't create a share link", "error");
    }
  }
  return (
    <button type="button" className="ak-act" onClick={handle} aria-label="Copy a share link for this answer" title="Share" disabled={state === "loading"}>
      <IconSwap on={state === "done"} a={<Share2 size={13} />} b={<Link size={13} color="var(--green)" />} />
    </button>
  );
}

function scopeLabel(files: string[], docs: DocumentMeta[]): string {
  const names = files.map((f) => titleFor(docs, f));
  return names.length > 2 ? `${names.length} documents` : names.join(" and ");
}

/** Types example questions into the empty composer's placeholder (no re-renders). */
function useTypedPlaceholder(ref: React.RefObject<HTMLTextAreaElement | null>, examples: string[], fallback: string, active: boolean) {
  useEffect(() => {
    const ta = ref.current;
    if (!ta) return;
    if (!active || !examples.length || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      ta.placeholder = fallback;
      return;
    }
    let q = 0, c = 0, dir = 1, timer = 0;
    const tick = () => {
      const text = examples[q % examples.length];
      c += dir;
      ta.placeholder = `${text.slice(0, c)}${dir > 0 ? "▏" : ""}`;
      let wait = dir > 0 ? 38 : 16;
      if (dir > 0 && c >= text.length) { dir = -1; wait = 1800; }
      else if (dir < 0 && c <= 0) { dir = 1; q += 1; wait = 350; }
      timer = window.setTimeout(tick, wait);
    };
    timer = window.setTimeout(tick, 900);
    return () => { clearTimeout(timer); ta.placeholder = fallback; };
  }, [ref, examples, fallback, active]);
}

type OpenSource = { list: Citation[]; index: number; terms: string[] };

/** One answer: Markdown with math and citation chips, typed in while it streams. */
function AnswerBody({ text, streaming, docs, onCite }: {
  text: string; streaming: boolean; docs: DocumentMeta[]; onCite: (file: string, page: number) => void;
}) {
  const typed = useTypedText(text, streaming);
  return (
    <div className={`ak-a${typed.typing ? " is-typing" : ""}`}>
      <AnswerMarkdown text={typed.text} onCite={onCite} titleFor={(f) => titleFor(docs, f)} />
    </div>
  );
}

export function ChatWindow({
  messages, question, isLoading, onQuestionChange, onSend, onAsk, onShare, disabled,
  docs, scope, onScopeChange, workspaceName, onFeedback, history, onSearch,
}: ChatWindowProps) {
  const threadRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scopeBtnRef = useRef<HTMLButtonElement>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [mode, setMode] = useState<"ask" | "search">("ask");
  const [source, setSource] = useState<OpenSource | null>(null);
  const [awayFromEnd, setAwayFromEnd] = useState(false);
  const [sentPulse, setSentPulse] = useState(0);
  const lastAssistant = messages.map((m) => m.role).lastIndexOf("assistant");

  const picked = scope.map((f) => docs.find((d) => d.file_name === f)).filter((d): d is DocumentMeta => !!d);
  const scopeText = !picked.length ? "All documents" : picked.length === 1 ? docTitle(picked[0]) : `${picked.length} documents`;
  const searching = picked.length ? picked : docs;

  // Starters: one question per document (or per picked document), so the empty state
  // shows what this workspace can actually answer.
  const starters = useMemo(() => {
    const pool = searching.filter((d) => d.questions?.length);
    return pool.slice(0, 4).map((d) => ({ doc: d, q: d.questions![0] }));
  }, [searching]);

  const examples = useMemo(() => searching.flatMap((d) => d.questions?.slice(0, 2) ?? []).slice(0, 8), [searching]);
  const fallbackPlaceholder = picked.length ? `Ask ${scopeText}…` : "Ask anything about your documents…";
  useTypedPlaceholder(inputRef, examples, fallbackPlaceholder, !question && !isLoading && !disabled);

  // Follow-ups: Vertex AI Search's related questions when it answered, else unasked
  // questions from the documents the latest answer cited.
  const followUps = useMemo(() => {
    const last = messages[lastAssistant];
    if (!last?.citations?.length || isLoading) return [];
    const asked = new Set(messages.filter((m) => m.role === "user").map((m) => m.text.trim().toLowerCase()));
    const files = [...new Set(last.citations.map((c) => c.file_name))];
    const qs = last.related?.length
      ? last.related
      : files.flatMap((f) => docs.find((d) => d.file_name === f)?.questions ?? []);
    return [...new Set(qs)].filter((q) => !asked.has(q.trim().toLowerCase())).slice(0, 3);
  }, [messages, lastAssistant, docs, isLoading]);

  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [messages, isLoading]);

  useEffect(() => {
    const ta = inputRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
    ta.style.overflowY = ta.scrollHeight > 160 ? "auto" : "hidden";
  }, [question]);

  // "/" jumps to the composer from anywhere on the page.
  useEffect(() => {
    function onKey(e: globalThis.KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      if (t && (t.closest("input, textarea, select, [contenteditable='true']"))) return;
      e.preventDefault();
      inputRef.current?.focus();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function onThreadScroll() {
    const el = threadRef.current;
    if (!el) return;
    setAwayFromEnd(el.scrollHeight - el.scrollTop - el.clientHeight > 240);
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!disabled && !isLoading && question.trim()) { setSentPulse((n) => n + 1); onSend(e as unknown as FormEvent); }
    }
  }

  function closePicker() {
    setPickerOpen(false);
    scopeBtnRef.current?.focus({ preventScroll: true });
  }

  function step(delta: number) {
    setSource((s) => s && ({ ...s, index: (s.index + delta + s.list.length) % s.list.length }));
  }

  const empty = messages.length === 0 && !isLoading;
  const waiting = isLoading && messages[messages.length - 1]?.role !== "assistant";
  const current = source ? source.list[source.index] : null;

  return (
    <div className={`chat ak${history ? " has-top" : ""}`}>
      {history && (
        <HistoryBar history={history} hasMessages={mode === "ask" && messages.length > 0} left={onSearch && (
          <div className="ak-mode" role="tablist" aria-label="Mode">
            {(["ask", "search"] as const).map((m) => (
              <button key={m} type="button" role="tab" aria-selected={mode === m} onClick={() => setMode(m)}>
                {mode === m && <motion.span layoutId="ak-mode-pill" className="ak-mode-pill" transition={{ type: "spring", stiffness: 500, damping: 40 }} />}
                {m === "ask" ? <BookOpen size={13} aria-hidden="true" /> : <Search size={13} aria-hidden="true" />}
                <span>{m === "ask" ? "Ask" : "Search"}</span>
              </button>
            ))}
          </div>
        )} />
      )}
      {mode === "search" && onSearch ? (
        <SearchView search={onSearch} docs={docs} onAskAbout={(q, file) => {
          setMode("ask");
          onScopeChange([file]);
          onAsk(q, [file]);
        }} />
      ) : (<>
      <div className="ak-thread" ref={threadRef} aria-live="polite" onScroll={onThreadScroll}>
        <AnimatePresence>
          {empty && (
            <motion.div key="empty" className="ak-empty"
              initial={{ opacity: 0 }} animate={{ opacity: 1, transition: { duration: 0.3 } }} exit={{ opacity: 0, transition: { duration: 0.12 } }}>
              {docs.length > 0 && (
                <div className="ak-deck" aria-hidden="true">
                  {docs.slice(0, 5).map((d, i, arr) => {
                    const mid = (arr.length - 1) / 2;
                    const on = scope.includes(d.file_name);
                    return (
                      <motion.span key={d.file_name} className={`ak-deck-card${on ? " is-on" : ""}`}
                        style={{ "--r": `${(i - mid) * 7}deg`, "--x": `${(i - mid) * 54}px`, "--d": `${i * 0.6}s` } as CSSProperties}
                        initial={{ opacity: 0, y: 24 }}
                        animate={{ opacity: 1, y: 0, transition: { duration: 0.5, ease: EASE_OUT, delay: 0.05 + i * 0.06 } }}>
                        <span className="ak-deck-in">
                          <i className={`ft-${fileType(d.file_name)}`}>{fileType(d.file_name).toUpperCase()}</i>
                          <b>{docTitle(d)}</b>
                          <em /><em /><em />
                        </span>
                      </motion.span>
                    );
                  })}
                </div>
              )}
              <motion.p className="ak-eyebrow" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0, transition: { delay: 0.18, duration: 0.4, ease: EASE_OUT } }}>
                Ask {workspaceName || "your workspace"}
              </motion.p>
              <motion.h2 className="ak-hero" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0, transition: { delay: 0.24, duration: 0.5, ease: EASE_OUT } }}>
                What do you want to <span className="ak-hero-hl">know?</span>
              </motion.h2>
              <motion.p className="ak-sub" initial={{ opacity: 0 }} animate={{ opacity: 1, transition: { delay: 0.34, duration: 0.4 } }}>
                {docs.length
                  ? `Answers come from ${picked.length ? scopeText : `your ${docs.length} document${docs.length === 1 ? "" : "s"}`}, with the page each one came from.`
                  : "Upload a document above, then ask anything it covers."}
              </motion.p>
              {starters.length > 0 ? (
                <div className="ak-starters">
                  {starters.map(({ doc, q }, i) => (
                    <motion.button key={doc.file_name} type="button" className="ak-starter" disabled={disabled}
                      onClick={() => onAsk(q, picked.length ? scope : [])}
                      onPointerMove={tilt} onPointerLeave={untilt}
                      style={{ animationDelay: `${0.4 + i * 0.06}s` }}
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1, transition: { duration: 0.4, ease: EASE_OUT, delay: 0.4 + i * 0.06 } }}>
                      <span className="ak-starter-doc"><i className={`ft-${fileType(doc.file_name)}`} aria-hidden="true" />{docTitle(doc)}</span>
                      <span className="ak-starter-q">{q}</span>
                      <ChevronRight size={14} className="ak-starter-go" aria-hidden="true" />
                    </motion.button>
                  ))}
                </div>
              ) : docs.length > 0 && (
                <div className="ak-starters">
                  {FALLBACK_STARTERS.map((q) => (
                    <button key={q} type="button" className="ak-starter" disabled={disabled} onClick={() => onAsk(q)}
                      onPointerMove={tilt} onPointerLeave={untilt}>
                      <span className="ak-starter-q">{q}</span><ChevronRight size={14} className="ak-starter-go" aria-hidden="true" />
                    </button>
                  ))}
                </div>
              )}
              {docs.length > 0 && <p className="ak-kbd-hint">Press <kbd>/</kbd> to start typing</p>}
            </motion.div>
          )}
        </AnimatePresence>

        {messages.map((m, i) => m.role === "user" ? (
          <motion.div key={i} className="ak-turn ak-turn-user"
            initial={{ opacity: 0, transform: "translateY(14px) scale(.98)" }}
            animate={{ opacity: 1, transform: "translateY(0px) scale(1)", transition: { duration: 0.32, ease: EASE_OUT } }}>
            <div className="ak-u">{m.text}</div>
            {m.scope && m.scope.length > 0 && (
              <span className="ak-scope-note"><Library size={11} aria-hidden="true" /> in {scopeLabel(m.scope, docs)}</span>
            )}
          </motion.div>
        ) : (
          <motion.div key={i} className="ak-turn ak-turn-bot" {...enter}>
            <div className="ak-mark" aria-hidden="true"><BookOpen size={13} /></div>
            <div className="ak-body">
              <AnswerBody text={m.text} streaming={!!m.streaming} docs={docs}
                onCite={(file, page) => {
                  const list = uniqueSources(m.citations ?? []);
                  if (!list.length) return;
                  let index = list.findIndex((c) => c.file_name === file && c.page === page);
                  if (index < 0) index = Math.max(0, list.findIndex((c) => c.file_name === file));
                  setSource({ list, index, terms: m.retrieval?.query_terms ?? [] });
                }} />
              {m.citations && m.citations.length > 0 && (
                <div className="ak-cites" aria-label="Sources">
                  {uniqueSources(m.citations).map((c, k, list) => (
                    <motion.button key={`${c.file_name}-${c.page}`} type="button" className="ak-cite"
                      onClick={() => setSource({ list, index: k, terms: m.retrieval?.query_terms ?? [] })}
                      initial={{ opacity: 0, transform: "translateY(6px)" }}
                      animate={{ opacity: 1, transform: "translateY(0px)", transition: { duration: 0.26, ease: EASE_OUT, delay: 0.2 + k * 0.06 } }}
                      aria-label={`Open source: ${titleFor(docs, c.file_name)}, page ${c.page}`}>
                      <span className="ak-cite-n">{k + 1}</span>
                      <span className="ak-cite-t">{titleFor(docs, c.file_name)}</span>
                      <span className="ak-cite-p">p. {c.page}</span>
                    </motion.button>
                  ))}
                </div>
              )}
              {m.scopedMiss && (
                <button type="button" className="ak-search-all" disabled={disabled || isLoading} onClick={() => onAsk(m.scopedMiss!, [])}>
                  Search all documents instead <ChevronRight size={12} aria-hidden="true" />
                </button>
              )}
              <div className="ak-meta">
                {m.citations && m.citations.length > 0 && m.retrieval && <Confidence score={m.retrieval.max_score} />}
                {m.retrieval && <RetrievalTracePanel r={m.retrieval} />}
                <span className="ak-spacer" />
                {m.timestamp && !m.streaming && <span className="ak-time">{relativeTime(m.timestamp)}</span>}
                {!m.streaming && m.answer_id && onFeedback && (
                  <Feedback value={m.helpful} onRate={(h) => onFeedback(i, h)} />
                )}
                {!m.streaming && <SpeakButton text={m.text} />}
                <CopyButton text={m.text} />
                <ShareButton msg={m} onShare={onShare} />
              </div>
              {i === lastAssistant && !m.streaming && followUps.length > 0 && (
                <div className="ak-follow" aria-label="Ask next">
                  {followUps.map((q, k) => (
                    <motion.button key={q} type="button" className="ak-follow-q" disabled={disabled}
                      onClick={() => onAsk(q, scope)}
                      initial={{ opacity: 0, transform: "translateX(-8px)" }}
                      animate={{ opacity: 1, transform: "translateX(0px)", transition: { duration: 0.3, ease: EASE_OUT, delay: 0.5 + k * 0.08 } }}>
                      <CornerDownRight size={13} aria-hidden="true" />{q}
                    </motion.button>
                  ))}
                </div>
              )}
            </div>
          </motion.div>
        ))}

        <AnimatePresence>
          {waiting && (
            <motion.div key="loading" className="ak-turn ak-turn-bot" {...enter} exit={{ opacity: 0, transition: { duration: 0.1 } }}>
              <div className="ak-mark is-busy" aria-hidden="true"><BookOpen size={13} /></div>
              <Thinking docs={searching} />
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <AnimatePresence>
        {awayFromEnd && !empty && (
          <motion.button key="jump" type="button" className="ak-jump" aria-label="Scroll to the latest message"
            onClick={() => threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight, behavior: "smooth" })}
            initial={{ opacity: 0, transform: "translate(-50%, 8px)" }}
            animate={{ opacity: 1, transform: "translate(-50%, 0px)", transition: { duration: 0.2, ease: EASE_OUT } }}
            exit={{ opacity: 0, transform: "translate(-50%, 8px)", transition: { duration: 0.12 } }}>
            <ArrowDown size={15} />
          </motion.button>
        )}
      </AnimatePresence>

      <div className="ak-dock">
        {docs.length > 0 && (
          <div className="scope-row">
            <button ref={scopeBtnRef} type="button" className="scope-btn" aria-haspopup="dialog" aria-expanded={pickerOpen}
              onClick={() => (pickerOpen ? closePicker() : setPickerOpen(true))} disabled={disabled}
              aria-label={`Documents searched: ${scopeText}. Change`}>
              <span className="scope-stack" aria-hidden="true">
                {(picked.length ? picked.slice(0, 3) : [null]).map((d, i) => (
                  <i key={d?.file_name ?? i} className={d ? `ft-${fileType(d.file_name)}` : "ft-all"}>
                    {d ? fileType(d.file_name).charAt(0).toUpperCase() : ""}
                  </i>
                ))}
              </span>
              <span className="scope-label">{scopeText}</span>
              <ChevronDown size={12} className="scope-chev" aria-hidden="true" />
            </button>
            <AnimatePresence initial={false}>
              {picked.map((d) => (
                <motion.span key={d.file_name} className="tchip" layout
                  initial={{ opacity: 0, scale: 0.94 }}
                  animate={{ opacity: 1, scale: 1, transition: { duration: 0.2 } }}
                  exit={{ opacity: 0, scale: 0.94, transition: { duration: 0.12 } }}>
                  <i className={`ft-${fileType(d.file_name)}`} aria-hidden="true" />
                  {docTitle(d)}
                  <button type="button" aria-label={`Stop searching ${docTitle(d)}`} onClick={() => onScopeChange(scope.filter((f) => f !== d.file_name))}>
                    <X size={11} />
                  </button>
                </motion.span>
              ))}
            </AnimatePresence>
          </div>
        )}

        <DocumentPicker
          open={pickerOpen}
          docs={docs}
          selected={scope}
          onChange={onScopeChange}
          onClose={closePicker}
          onAsk={(q, file) => {
            const next = scope.includes(file) ? scope : [...scope, file];
            onScopeChange(next);
            setPickerOpen(false);
            onAsk(q, next);
          }}
        />

        <form className="ak-composer" onSubmit={(e) => { setSentPulse((n) => n + 1); onSend(e); }}>
          <label className={`ak-field${isLoading ? " is-busy" : ""}`}>
            <span className="ak-sr">Your question</span>
            <textarea
              ref={inputRef}
              className="ak-input"
              value={question}
              onChange={(e) => onQuestionChange(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={fallbackPlaceholder}
              disabled={disabled || isLoading}
              rows={1}
              autoComplete="off"
            />
            <VoiceButton onText={onQuestionChange} disabled={disabled || isLoading} base={question} />
            <button className="ak-send" type="submit" disabled={disabled || isLoading || !question.trim()} aria-label="Send">
              <motion.span key={sentPulse} className="ak-send-ico"
                initial={sentPulse ? { transform: "translateY(14px)", opacity: 0 } : false}
                animate={{ transform: "translateY(0px)", opacity: 1, transition: { duration: 0.32, ease: EASE_OUT } }}>
                <ArrowUp size={17} strokeWidth={2.4} />
              </motion.span>
            </button>
          </label>
          <p className="ak-hint">Enter to send · Shift + Enter for a new line · <kbd>/</kbd> to focus · ask in any language</p>
        </form>
      </div>
      </>)}

      <AnimatePresence>
        {source && current && (
          <motion.div key="scrim" className="ak-scrim" onClick={() => setSource(null)}
            initial={{ opacity: 0 }} animate={{ opacity: 1, transition: { duration: 0.3 } }} exit={{ opacity: 0, transition: { duration: 0.18 } }} />
        )}
        {source && current && (
          <motion.aside
            key="source"
            className="ak-source"
            role="dialog"
            aria-label={`Source: ${titleFor(docs, current.file_name)}, page ${current.page}`}
            onKeyDown={(e) => {
              if (e.key === "Escape") setSource(null);
              if (e.key === "ArrowRight" && source.list.length > 1) step(1);
              if (e.key === "ArrowLeft" && source.list.length > 1) step(-1);
            }}
            initial={{ transform: "translateX(100%)" }}
            animate={{ transform: "translateX(0%)", transition: { duration: 0.42, ease: EASE_DRAWER } }}
            exit={{ transform: "translateX(100%)", transition: { duration: 0.2, ease: EASE_OUT } }}
          >
            <div className="ak-src-head">
              <span className={`ftype ft-${fileType(current.file_name)}`} aria-hidden="true">{fileType(current.file_name).toUpperCase()}</span>
              <div className="ak-src-name">
                <p className="ak-src-title">{titleFor(docs, current.file_name)}</p>
                <p className="ak-src-meta">
                  Page {current.page}
                  {typeof current.score === "number" && <> · {Math.round(current.score * 100)}% match</>}
                </p>
              </div>
              <button type="button" className="ak-src-close" onClick={() => setSource(null)} aria-label="Close source" autoFocus>
                <X size={15} />
              </button>
            </div>
            {typeof current.score === "number" && (
              <div className="ak-src-meter" aria-hidden="true"><motion.b key={source.index}
                initial={{ transform: "scaleX(0)" }} animate={{ transform: `scaleX(${Math.max(0.04, Math.min(1, current.score))})`, transition: { duration: 0.6, ease: EASE_OUT } }} /></div>
            )}
            <p className="ak-src-k">Passage used in the answer</p>
            <AnimatePresence mode="wait" initial={false}>
              <motion.blockquote key={source.index} className="ak-src-text"
                initial={{ opacity: 0, transform: "translateY(8px)" }}
                animate={{ opacity: 1, transform: "translateY(0px)", transition: { duration: 0.26, ease: EASE_OUT } }}
                exit={{ opacity: 0, transition: { duration: 0.1 } }}>
                <Highlighted text={current.excerpt} terms={source.terms} />
              </motion.blockquote>
            </AnimatePresence>
            <p className="ak-src-note">Highlighted words are the terms your question was searched with.</p>
            {source.list.length > 1 && (
              <div className="ak-src-nav">
                <button type="button" className="ak-act" onClick={() => step(-1)} aria-label="Previous source"><ChevronLeft size={15} /></button>
                <span className="num">Source {source.index + 1} of {source.list.length}</span>
                <button type="button" className="ak-act" onClick={() => step(1)} aria-label="Next source"><ChevronRight size={15} /></button>
              </div>
            )}
            <span className="ak-spacer" />
            <button type="button" className="ak-src-ask" onClick={() => {
              onScopeChange([current.file_name]);
              setSource(null);
              inputRef.current?.focus();
            }}>
              <FileText size={14} aria-hidden="true" /> Ask only this document
            </button>
          </motion.aside>
        )}
      </AnimatePresence>
    </div>
  );
}
