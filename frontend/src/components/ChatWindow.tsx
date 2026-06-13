import { FormEvent, KeyboardEvent, useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Send, ChevronDown, Copy, Check, Zap, ChevronRight, Search, Sparkles, Layers, Timer, Hash } from "lucide-react";

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
      whileTap={{ scale: 0.99 }}
      layout
    >
      <span className="citation-header">
        <span className="citation-file-icon">📄</span>
        <span className="citation-meta">{shortName}</span>
        <span className="citation-page">p.{c.page}</span>
        {typeof c.score === "number" && (
          <span className="citation-score" title="Relevance score">
            <span className="citation-score-track">
              <motion.span
                className="citation-score-fill"
                initial={{ width: 0 }}
                animate={{ width: `${Math.min(c.score * 100, 100)}%` }}
                transition={{ duration: 0.6, ease: [0.4, 0, 0.2, 1] }}
              />
            </span>
            <span className="citation-score-num">{Math.round(c.score * 100)}%</span>
          </span>
        )}
        <ChevronDown
          size={11}
          className={`citation-chevron${expanded ? " flipped" : ""}`}
        />
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
    { icon: Sparkles, label: "Embed query", detail: `${r.query_terms.length} terms` },
    { icon: Search,   label: r.engine,       detail: `${r.chunks_searched} chunks scanned` },
    { icon: Layers,   label: "Rank candidates", detail: `${r.candidates_ranked} matched` },
    { icon: Hash,     label: "Select top-k", detail: `${r.top_k} returned · best ${Math.round(r.max_score * 100)}%` },
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
        <span className="retrieval-stat">
          <Timer size={11} /> {r.latency_ms} ms
        </span>
        <span className="retrieval-stat">
          {r.chunks_searched} chunks
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
      setTimeout(() => setCopied(false), 1500);
    });
  }
  return (
    <motion.button
      type="button"
      className="msg-copy"
      onClick={handleCopy}
      title="Copy"
      whileTap={{ scale: 0.85 }}
    >
      <AnimatePresence mode="wait">
        {copied
          ? <motion.span key="check" initial={{ scale: 0 }} animate={{ scale: 1 }} exit={{ scale: 0 }}><Check size={11} color="var(--green)" /></motion.span>
          : <motion.span key="copy"  initial={{ scale: 0 }} animate={{ scale: 1 }} exit={{ scale: 0 }}><Copy size={11} /></motion.span>
        }
      </AnimatePresence>
    </motion.button>
  );
}

function MessageBubble({ msg, index }: { msg: ChatMessage; index: number }) {
  const isUser = msg.role === "user";
  return (
    <motion.div
      className={`message ${msg.role}`}
      initial={{ opacity: 0, y: 12, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 0.28, ease: [0.4, 0, 0.2, 1], delay: 0 }}
      layout
    >
      <div className="bubble-wrap">
        <div className="bubble">{msg.text}</div>
        <div className="bubble-meta">
          {msg.timestamp && (
            <span className="msg-time">{relativeTime(msg.timestamp)}</span>
          )}
          <CopyButton text={msg.text} />
        </div>
      </div>
      {!isUser && msg.retrieval && <RetrievalTracePanel r={msg.retrieval} />}
      {msg.citations && msg.citations.length > 0 && (
        <motion.div
          className="citations"
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.15, duration: 0.25 }}
        >
          <span className="citations-label">Sources</span>
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
  "How many PTO days do employees get?",
  "What is the minimum password length?",
  "What are the vendor payment terms?",
];

export function ChatWindow({
  messages,
  question,
  isLoading,
  onQuestionChange,
  onSend,
  onAsk,
  disabled,
}: ChatWindowProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

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
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              transition={{ duration: 0.35, ease: "easeOut" }}
            >
              <motion.div
                className="empty-icon-wrap float"
                animate={{ y: [0, -8, 0] }}
                transition={{ duration: 3, ease: "easeInOut", repeat: Infinity }}
              >
                <Zap size={28} strokeWidth={1.5} />
              </motion.div>

              <h3 className="empty-title">Ask anything about your documents</h3>
              <p className="empty-body">
                Your knowledge base is ready. Try one of these:
              </p>

              <div className="empty-suggestions">
                {SUGGESTIONS.map((s, i) => (
                  <motion.button
                    key={s}
                    type="button"
                    className="suggestion-chip"
                    onClick={() => onAsk(s)}
                    disabled={disabled}
                    initial={{ opacity: 0, x: -12 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: 0.1 + i * 0.08, duration: 0.28, ease: "easeOut" }}
                    whileHover={{ x: 4 }}
                    whileTap={{ scale: 0.98 }}
                  >
                    <ChevronRight size={13} className="suggestion-chip-icon" />
                    {s}
                  </motion.button>
                ))}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Messages */}
        <AnimatePresence initial={false}>
          {messages.map((msg, i) => (
            <MessageBubble key={i} msg={msg} index={i} />
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
              <div className="bubble-wrap">
                <div className="bubble loading-bubble">
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
      <form className="chat-form" onSubmit={onSend}>
        <AutoTextarea
          value={question}
          onChange={onQuestionChange}
          onKeyDown={handleKeyDown}
          placeholder="Ask a question… (Enter to send, Shift+Enter for new line)"
          disabled={disabled || isLoading}
        />
        <motion.button
          className="btn-send"
          type="submit"
          disabled={disabled || isLoading || !question.trim()}
          whileHover={{ scale: 1.06 }}
          whileTap={{ scale: 0.90 }}
        >
          <Send size={15} />
        </motion.button>
      </form>
    </div>
  );
}
