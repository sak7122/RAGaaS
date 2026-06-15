import { FormEvent, KeyboardEvent, useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Send, ChevronDown, Copy, Check, Zap, ChevronRight,
  Search, Sparkles, Layers, Timer, Hash, Share2, Link,
  BookOpen, BarChart2, FileText,
} from "lucide-react";
import { StreamingText, toast } from "./ui";

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
};

export type ChatMessage = {
  role: "user" | "assistant";
  text: string;
  citations?: Citation[];
  retrieval?: RetrievalTrace;
  timestamp?: number;
};

interface ChatWindowProps {
  messages: ChatMessage[];
  question: string;
  isLoading: boolean;
  onQuestionChange: (q: string) => void;
  onSend: (e: FormEvent) => void;
  onAsk: (text: string) => void;
  onShare: (msg: ChatMessage) => Promise<string | null>;
  disabled: boolean;
}

function relativeTime(ts?: number): string {
  if (!ts) return "";
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 5)    return "just now";
  if (diff < 60)   return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return `${Math.floor(diff / 3600)}h ago`;
}

function CitationCard({ c }: { c: Citation }) {
  const [expanded, setExpanded] = useState(false);
  const shortName = c.file_name.replace(/_/g, " ").replace(".pdf", "");
  return (
    <motion.button
      type="button"
      className="citation-card"
      onClick={() => setExpanded((v) => !v)}
      whileHover={{ scale: 1.01 }}
      whileTap={{ scale: 0.98 }}
      layout
    >
      <span className="citation-header">
        <FileText size={11} className="citation-file-icon" />
        <span className="citation-meta">{shortName}</span>
        <span className="citation-page">p.{c.page}</span>
        {typeof c.score === "number" && (
          <span className="citation-score" title="Relevance score">
            <span className="citation-score-track">
              <motion.span
                className="citation-score-fill"
                initial={{ width: 0 }}
                animate={{ width: `${Math.min(c.score * 100, 100)}%` }}
                transition={{ duration: 0.7, ease: [0.4, 0, 0.2, 1] }}
              />
            </span>
            <span className="citation-score-num">{Math.round(c.score * 100)}%</span>
          </span>
        )}
        <ChevronDown size={11} className={`citation-chevron${expanded ? " flipped" : ""}`} />
      </span>
      <AnimatePresence>
        {expanded && (
          <motion.span
            className="citation-excerpt"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
            style={{ display: "block", overflow: "hidden" }}
          >
            {c.excerpt}
          </motion.span>
        )}
      </AnimatePresence>
    </motion.button>
  );
}

function RetrievalTracePanel({ r }: { r: RetrievalTrace }) {
  const [open, setOpen] = useState(false);
  const steps = [
    { icon: Sparkles, label: "Embed query",       detail: `${r.query_terms.length} terms` },
    { icon: Search,   label: r.engine,             detail: `${r.chunks_searched} chunks scanned` },
    { icon: Layers,   label: "Rank candidates",    detail: `${r.candidates_ranked} matched` },
    { icon: Hash,     label: "Select top-k",       detail: `${r.top_k} returned · best ${Math.round(r.max_score * 100)}%` },
  ];
  return (
    <div className="retrieval">
      <motion.button
        type="button"
        className="retrieval-toggle"
        onClick={() => setOpen((v) => !v)}
        whileHover={{ scale: 1.005 }}
        whileTap={{ scale: 0.995 }}
      >
        <span className="retrieval-engine">
          <Search size={12} />
          <span className="retrieval-engine-name">{r.engine}</span>
        </span>
        <span className="retrieval-stat"><Timer size={11} /> {r.latency_ms} ms</span>
        <span className="retrieval-stat">{r.chunks_searched} chunks</span>
        <span className="retrieval-stat">
          <BarChart2 size={11} />
          {Math.round(r.max_score * 100)}% match
        </span>
        <ChevronDown size={13} className={`retrieval-chevron${open ? " flipped" : ""}`} />
      </motion.button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            className="retrieval-body"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.25, ease: "easeOut" }}
          >
            <div className="retrieval-terms">
              {r.query_terms.map((t, i) => (
                <motion.span
                  key={t}
                  className="retrieval-term"
                  initial={{ opacity: 0, scale: 0.8 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ delay: i * 0.03 }}
                >
                  {t}
                </motion.span>
              ))}
            </div>
            <div className="retrieval-steps">
              {steps.map((s, i) => {
                const Icon = s.icon;
                return (
                  <motion.div
                    key={s.label}
                    className="retrieval-step"
                    initial={{ opacity: 0, x: -8 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: 0.05 + i * 0.07 }}
                  >
                    <span className="retrieval-step-icon"><Icon size={13} /></span>
                    <span className="retrieval-step-label">{s.label}</span>
                    <span className="retrieval-step-detail">{s.detail}</span>
                    {i < steps.length - 1 && <span className="retrieval-step-line" />}
                  </motion.div>
                );
              })}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
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
    <motion.button type="button" className="msg-action-btn" onClick={handleCopy} title="Copy" whileTap={{ scale: 0.8 }}>
      <AnimatePresence mode="wait">
        {copied
          ? <motion.span key="check" initial={{ scale: 0 }} animate={{ scale: 1 }} exit={{ scale: 0 }}><Check size={11} color="var(--green)" /></motion.span>
          : <motion.span key="copy"  initial={{ scale: 0 }} animate={{ scale: 1 }} exit={{ scale: 0 }}><Copy size={11} /></motion.span>
        }
      </AnimatePresence>
    </motion.button>
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
      toast("Share link copied!");
      setState("done");
      setTimeout(() => setState("idle"), 2500);
    } else {
      setState("idle");
    }
  }
  return (
    <motion.button
      type="button"
      className="msg-action-btn"
      onClick={handle}
      title={state === "done" ? "Link copied!" : "Share this answer"}
      whileTap={{ scale: 0.8 }}
    >
      <AnimatePresence mode="wait">
        {state === "done"
          ? <motion.span key="link"  initial={{ scale: 0 }} animate={{ scale: 1 }} exit={{ scale: 0 }}><Link size={11} color="var(--green)" /></motion.span>
          : state === "loading"
          ? <motion.span key="spin"  initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="share-spinner" />
          : <motion.span key="share" initial={{ scale: 0 }} animate={{ scale: 1 }} exit={{ scale: 0 }}><Share2 size={11} /></motion.span>
        }
      </AnimatePresence>
    </motion.button>
  );
}

function MessageBubble({
  msg,
  isNewest,
  onShare,
}: {
  msg: ChatMessage;
  isNewest: boolean;
  onShare: (m: ChatMessage) => Promise<string | null>;
}) {
  const isUser = msg.role === "user";
  return (
    <motion.div
      className={`message ${msg.role}`}
      initial={{ opacity: 0, y: 14, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 0.3, ease: [0.4, 0, 0.2, 1] }}
      layout
    >
      {!isUser && (
        <div className="msg-avatar-row">
          <span className="msg-ai-avatar">
            <Sparkles size={10} />
          </span>
          <span className="msg-ai-label">RAGaaS</span>
        </div>
      )}
      <div className="bubble-wrap">
        <div className={`bubble ${isUser ? "bubble-user" : "bubble-ai"}`}>
          {isUser ? (
            msg.text
          ) : (
            <StreamingText text={msg.text} active={isNewest && !isUser} />
          )}
        </div>
        <div className="bubble-meta">
          {msg.timestamp && <span className="msg-time">{relativeTime(msg.timestamp)}</span>}
          <CopyButton text={msg.text} />
          {!isUser && <ShareButton msg={msg} onShare={onShare} />}
        </div>
      </div>
      {!isUser && msg.retrieval && <RetrievalTracePanel r={msg.retrieval} />}
      {msg.citations && msg.citations.length > 0 && (
        <motion.div
          className="citations"
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2, duration: 0.25 }}
        >
          <span className="citations-label">
            <BookOpen size={11} /> Sources
          </span>
          {msg.citations.map((c, i) => (
            <CitationCard key={`${c.file_name}-${c.page}-${i}`} c={c} />
          ))}
        </motion.div>
      )}
    </motion.div>
  );
}

function AutoTextarea({
  value,
  onChange,
  onKeyDown,
  placeholder,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  placeholder: string;
  disabled: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    ref.current.style.height = "auto";
    ref.current.style.height = Math.min(ref.current.scrollHeight, 120) + "px";
  }, [value]);

  return (
    <textarea
      ref={ref}
      className="chat-input"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={onKeyDown}
      placeholder={placeholder}
      disabled={disabled}
      rows={1}
      autoComplete="off"
    />
  );
}

const SUGGESTIONS = [
  { icon: FileText,   text: "Summarize the key documents" },
  { icon: Search,     text: "What is the refund policy?" },
  { icon: BarChart2,  text: "Show me the Q3 revenue numbers" },
  { icon: BookOpen,   text: "What are the onboarding steps?" },
];

export function ChatWindow({
  messages,
  question,
  isLoading,
  onQuestionChange,
  onSend,
  onAsk,
  onShare,
  disabled,
}: ChatWindowProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const assistantIdxs = messages.map((m, i) => ({ m, i })).filter(({ m }) => m.role === "assistant");
  const lastAssistantIdx = assistantIdxs.length > 0 ? assistantIdxs[assistantIdxs.length - 1].i : -1;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isLoading]);

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!disabled && !isLoading && question.trim()) {
        onSend(e as unknown as FormEvent);
      }
    }
  }

  return (
    <div className="chat">
      <div className="messages">

        {/* Empty state */}
        <AnimatePresence>
          {messages.length === 0 && !isLoading && (
            <motion.div
              className="empty-state"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.35 }}
            >
              <motion.div
                className="empty-icon-wrap"
                initial={{ scale: 0.6, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={{ duration: 0.5, ease: [0.34, 1.56, 0.64, 1] }}
              >
                <motion.div
                  animate={{ y: [0, -6, 0] }}
                  transition={{ duration: 3.2, ease: "easeInOut", repeat: Infinity }}
                >
                  <Zap size={28} strokeWidth={1.5} />
                </motion.div>
              </motion.div>

              <motion.h3
                className="empty-title"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.15, duration: 0.35 }}
              >
                Ask anything about your documents
              </motion.h3>
              <motion.p
                className="empty-body"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.22, duration: 0.3 }}
              >
                Your knowledge base is ready. Try one of these:
              </motion.p>

              <div className="empty-suggestions">
                {SUGGESTIONS.map((s, i) => {
                  const Icon = s.icon;
                  return (
                    <motion.button
                      key={s.text}
                      type="button"
                      className="suggestion-chip"
                      onClick={() => onAsk(s.text)}
                      disabled={disabled}
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: 0.3 + i * 0.07, duration: 0.28 }}
                      whileHover={{ y: -2, boxShadow: "var(--shadow-md)" }}
                      whileTap={{ scale: 0.97 }}
                    >
                      <Icon size={13} className="suggestion-chip-icon" />
                      {s.text}
                      <ChevronRight size={12} className="suggestion-chip-arrow" />
                    </motion.button>
                  );
                })}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Messages */}
        <AnimatePresence initial={false}>
          {messages.map((msg, i) => (
            <MessageBubble
              key={i}
              msg={msg}
              isNewest={i === lastAssistantIdx}
              onShare={onShare}
            />
          ))}
        </AnimatePresence>

        {/* Loading bubble */}
        <AnimatePresence>
          {isLoading && (
            <motion.div
              className="message assistant"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.22 }}
            >
              <div className="msg-avatar-row">
                <span className="msg-ai-avatar">
                  <Sparkles size={10} />
                </span>
                <span className="msg-ai-label">RAGaaS</span>
              </div>
              <div className="bubble-wrap">
                <div className="bubble bubble-ai loading-bubble">
                  <span className="loading-dot" />
                  <span className="loading-dot" />
                  <span className="loading-dot" />
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <motion.form
        className="chat-form"
        onSubmit={onSend}
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.1, duration: 0.3 }}
      >
        <AutoTextarea
          value={question}
          onChange={onQuestionChange}
          onKeyDown={handleKeyDown}
          placeholder="Ask a question… (Enter to send, Shift+Enter for newline)"
          disabled={disabled || isLoading}
        />
        <motion.button
          className="btn-send"
          type="submit"
          disabled={disabled || isLoading || !question.trim()}
          whileHover={{ scale: 1.08 }}
          whileTap={{ scale: 0.88 }}
          transition={{ type: "spring", stiffness: 400, damping: 17 }}
        >
          <Send size={15} />
        </motion.button>
      </motion.form>
    </div>
  );
}
