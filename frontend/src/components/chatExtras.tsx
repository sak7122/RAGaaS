// Chat extras: speak a question (browser speech recognition, free), hear an answer
// (browser speech synthesis, free), rate an answer, and browse saved conversations.
import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { History, Mic, MessageSquarePlus, Square, ThumbsDown, ThumbsUp, Trash2, Volume2, X } from "lucide-react";

const EASE = [0.23, 1, 0.32, 1] as const;

// ── Speech recognition (Chrome, Edge, Safari; not Firefox) ──────────────────
type Recognition = {
  lang: string; interimResults: boolean; continuous: boolean;
  onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onend: (() => void) | null; onerror: ((e: { error: string }) => void) | null;
  start: () => void; stop: () => void;
};
function recognitionCtor(): (new () => Recognition) | null {
  const w = window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}
export const canListen = () => typeof window !== "undefined" && !!recognitionCtor();

/** Mic button: dictates into the question box; the person reviews and sends. */
export function VoiceButton({ onText, disabled, base }: { onText: (t: string) => void; disabled: boolean; base: string }) {
  const [on, setOn] = useState(false);
  const [error, setError] = useState("");
  const rec = useRef<Recognition | null>(null);
  const baseRef = useRef(base);
  useEffect(() => () => rec.current?.stop(), []);
  if (!canListen()) return null;

  function toggle() {
    if (on) { rec.current?.stop(); return; }
    const Ctor = recognitionCtor()!;
    const r = new Ctor();
    r.lang = navigator.language || "en-US";
    r.interimResults = true;
    r.continuous = false;
    baseRef.current = base ? base.trimEnd() + " " : "";
    r.onresult = (e) => {
      let text = "";
      for (let i = 0; i < e.results.length; i++) text += e.results[i][0].transcript;
      onText(baseRef.current + text);
    };
    r.onerror = (e) => setError(e.error === "not-allowed" ? "Microphone access is blocked for this site." : "Didn't catch that. Try again.");
    r.onend = () => setOn(false);
    rec.current = r;
    setError("");
    setOn(true);
    r.start();
  }
  return (
    <span className="ak-voice">
      <button type="button" className={`ak-mic${on ? " is-on" : ""}`} onClick={toggle} disabled={disabled}
        aria-label={on ? "Stop dictating" : "Ask by voice"} aria-pressed={on} title={on ? "Stop" : "Ask by voice"}>
        {on ? <Square size={13} fill="currentColor" /> : <Mic size={16} />}
      </button>
      {error && <span className="ak-voice-err" role="status">{error}</span>}
    </span>
  );
}

// ── Speech synthesis ─────────────────────────────────────────────────────────
function guessLang(text: string): string | undefined {
  if (/[ऀ-ॿ]/.test(text)) return "hi-IN";
  if (/[஀-௿]/.test(text)) return "ta-IN";
  if (/[ఀ-౿]/.test(text)) return "te-IN";
  if (/[ঀ-৿]/.test(text)) return "bn-IN";
  if (/[؀-ۿ]/.test(text)) return "ar";
  return undefined;
}
const spoken = (md: string) =>
  md.replace(/\(([^()]*\.(pdf|docx|xlsx|csv|pptx|md|txt|html?)[^()]*)\)/gi, "")   // drop "(file.pdf p.3)"
    .replace(/[*_#`>]/g, "").replace(/\s+/g, " ").trim();

export function SpeakButton({ text }: { text: string }) {
  const [on, setOn] = useState(false);
  useEffect(() => () => { if (on) window.speechSynthesis?.cancel(); }, [on]);
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return null;
  function toggle() {
    const synth = window.speechSynthesis;
    if (on) { synth.cancel(); setOn(false); return; }
    synth.cancel();
    const u = new SpeechSynthesisUtterance(spoken(text));
    const lang = guessLang(text);
    if (lang) u.lang = lang;
    u.rate = 1.02;
    u.onend = () => setOn(false);
    u.onerror = () => setOn(false);
    setOn(true);
    synth.speak(u);
  }
  return (
    <button type="button" className={`ak-act${on ? " is-on" : ""}`} onClick={toggle}
      aria-label={on ? "Stop reading aloud" : "Read the answer aloud"} title={on ? "Stop" : "Read aloud"}>
      {on ? <Square size={11} fill="currentColor" /> : <Volume2 size={14} />}
    </button>
  );
}

// ── 👍 / 👎 ───────────────────────────────────────────────────────────────────
export function Feedback({ value, onRate }: { value?: boolean; onRate: (helpful: boolean) => void }) {
  const [thanks, setThanks] = useState(false);
  function rate(h: boolean) {
    if (value === h) return;
    onRate(h);
    setThanks(true);
    setTimeout(() => setThanks(false), 1800);
  }
  return (
    <span className="ak-fb" role="group" aria-label="Was this helpful?">
      <button type="button" className={`ak-act${value === true ? " is-up" : ""}`} aria-pressed={value === true}
        onClick={() => rate(true)} aria-label="Helpful" title="Helpful">
        <motion.span key={String(value === true)} initial={value === true ? { scale: 0.6 } : false} animate={{ scale: 1 }}
          transition={{ type: "spring", stiffness: 500, damping: 18 }}><ThumbsUp size={13} /></motion.span>
      </button>
      <button type="button" className={`ak-act${value === false ? " is-down" : ""}`} aria-pressed={value === false}
        onClick={() => rate(false)} aria-label="Not helpful" title="Not helpful">
        <motion.span key={String(value === false)} initial={value === false ? { scale: 0.6 } : false} animate={{ scale: 1 }}
          transition={{ type: "spring", stiffness: 500, damping: 18 }}><ThumbsDown size={13} /></motion.span>
      </button>
      <AnimatePresence>
        {thanks && (
          <motion.span className="ak-fb-thanks" initial={{ opacity: 0, x: -4 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }}>
            {value === false ? "Thanks, your admin will see this" : "Thanks!"}
          </motion.span>
        )}
      </AnimatePresence>
    </span>
  );
}

// ── Saved conversations ──────────────────────────────────────────────────────
export type ConvSummary = { id: string; title: string; updated_at: string; messages: number };
export type HistoryProps = {
  current: string | null;
  load: () => Promise<ConvSummary[]>;
  open: (id: string) => void;
  remove: (id: string) => Promise<void>;
  newChat: () => void;
};

function when(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const days = Math.floor((Date.now() - d.getTime()) / 86400000);
  if (days < 1) return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (days < 7) return d.toLocaleDateString(undefined, { weekday: "short" });
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

export function HistoryBar({ history, hasMessages }: { history: HistoryProps; hasMessages: boolean }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<ConvSummary[] | null>(null);
  useEffect(() => {
    if (!open) return;
    let live = true;
    history.load().then((r) => { if (live) setItems(r); }).catch(() => { if (live) setItems([]); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  return (
    <>
      <div className="ak-topbar">
        <button type="button" className="ak-top-btn" onClick={() => setOpen(true)} aria-haspopup="dialog" aria-expanded={open}>
          <History size={14} aria-hidden="true" /> History
        </button>
        {hasMessages && (
          <button type="button" className="ak-top-btn" onClick={history.newChat}>
            <MessageSquarePlus size={14} aria-hidden="true" /> New chat
          </button>
        )}
      </div>
      <AnimatePresence>
        {open && (
          <motion.div key="hs" className="ak-scrim" onClick={() => setOpen(false)}
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: 0.15 } }} />
        )}
        {open && (
          <motion.aside key="hp" className="ak-history" role="dialog" aria-label="Your conversations"
            onKeyDown={(e) => { if (e.key === "Escape") setOpen(false); }}
            initial={{ transform: "translateX(-100%)" }}
            animate={{ transform: "translateX(0%)", transition: { duration: 0.4, ease: [0.32, 0.72, 0, 1] } }}
            exit={{ transform: "translateX(-100%)", transition: { duration: 0.2, ease: EASE } }}>
            <div className="ak-src-head">
              <p className="ak-src-title" style={{ flex: 1 }}>Your conversations</p>
              <button type="button" className="ak-src-close" onClick={() => setOpen(false)} aria-label="Close" autoFocus><X size={15} /></button>
            </div>
            <button type="button" className="ak-src-ask" onClick={() => { history.newChat(); setOpen(false); }}>
              <MessageSquarePlus size={14} aria-hidden="true" /> New chat
            </button>
            {items === null ? <p className="ak-src-note">Loading…</p>
              : items.length === 0 ? <p className="ak-src-note">No saved conversations yet. They appear here after your first question.</p>
              : (
                <ul className="ak-hist">
                  {items.map((c, i) => (
                    <motion.li key={c.id} initial={{ opacity: 0, transform: "translateX(-8px)" }}
                      animate={{ opacity: 1, transform: "translateX(0px)", transition: { duration: 0.25, ease: EASE, delay: i * 0.03 } }}
                      className={c.id === history.current ? "is-current" : ""}>
                      <button type="button" className="ak-hist-open" onClick={() => { history.open(c.id); setOpen(false); }}>
                        <span className="ak-hist-t">{c.title}</span>
                        <span className="ak-hist-m">{when(c.updated_at)} · {Math.ceil(c.messages / 2)} question{c.messages > 2 ? "s" : ""}</span>
                      </button>
                      <button type="button" className="ak-act" aria-label={`Delete “${c.title}”`} title="Delete"
                        onClick={async () => { await history.remove(c.id); setItems((xs) => (xs ?? []).filter((x) => x.id !== c.id)); }}>
                        <Trash2 size={13} />
                      </button>
                    </motion.li>
                  ))}
                </ul>
              )}
          </motion.aside>
        )}
      </AnimatePresence>
    </>
  );
}
