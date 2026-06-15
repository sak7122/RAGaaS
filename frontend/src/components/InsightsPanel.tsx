import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { TrendingUp, AlertTriangle, MessageSquare, Target, RefreshCcw, ChevronDown, Zap, BookOpen } from "lucide-react";

export type Insights = {
  total_queries: number;
  avg_confidence: number;
  answered_rate: number;
  top_questions: { question: string; count: number; avg_score: number }[];
  gaps: { question: string; count: number; best_score: number; avg_score: number }[];
  faqs: { question: string; answer: string; score: number; count: number }[];
  window: number;
};

interface Props {
  fetchInsights: () => Promise<Insights | null>;
  onQuickAsk: (q: string) => void;
}

function StatCard({ icon, label, value, tone }: {
  icon: React.ReactNode; label: string; value: string; tone?: "good" | "warn" | "bad";
}) {
  return (
    <motion.div
      className={`insight-stat${tone ? ` ${tone}` : ""}`}
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
    >
      <span className="insight-stat-icon">{icon}</span>
      <span className="insight-stat-value">{value}</span>
      <span className="insight-stat-label">{label}</span>
    </motion.div>
  );
}

function ConfidencePip({ score }: { score: number }) {
  const pct = Math.round(score * 100);
  const cls = pct >= 70 ? "good" : pct >= 50 ? "warn" : "bad";
  return <span className={`faq-confidence ${cls}`}>{pct}% match</span>;
}

function FaqItem({ item, onAsk }: { item: Insights["faqs"][0]; onAsk: (q: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <motion.div className="faq-card" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}>
      <button
        type="button"
        className="faq-header"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span className="faq-question">{item.question}</span>
        <span className="faq-header-right">
          <ConfidencePip score={item.score} />
          <span className="faq-count">{item.count}×</span>
          <ChevronDown size={14} className={`faq-chevron${open ? " open" : ""}`} />
        </span>
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            className="faq-body"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
          >
            <p className="faq-answer">{item.answer}</p>
            <button
              type="button"
              className="btn-ask-this"
              onClick={() => onAsk(item.question)}
            >
              <Zap size={12} /> Ask again in chat
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

export function InsightsPanel({ fetchInsights, onQuickAsk }: Props) {
  const [data, setData] = useState<Insights | null>(null);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    setData(await fetchInsights());
    setLoading(false);
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  if (loading && !data) {
    return <div className="insights-wrap"><p className="insights-empty">Loading insights…</p></div>;
  }
  if (!data || data.total_queries === 0) {
    return (
      <div className="insights-wrap">
        <div className="insights-empty-state">
          <Target size={40} />
          <h3>No questions yet</h3>
          <p>Ask a few questions in chat — this dashboard shows what your team searches for and which answers your documents are missing.</p>
        </div>
      </div>
    );
  }

  const conf = Math.round(data.avg_confidence * 100);
  const answered = Math.round(data.answered_rate * 100);

  return (
    <div className="insights-wrap">
      <div className="insights-head">
        <div>
          <h2 className="insights-title">Knowledge Insights</h2>
          <p className="insights-sub">What your team asks — and what your documents can't answer.</p>
        </div>
        <button type="button" className="btn-ghost" onClick={load}>
          <RefreshCcw size={13} /> Refresh
        </button>
      </div>

      <div className="insight-stats">
        <StatCard icon={<MessageSquare size={16} />} label="Questions asked" value={`${data.total_queries}`} />
        <StatCard
          icon={<TrendingUp size={16} />}
          label="Avg confidence"
          value={`${conf}%`}
          tone={conf >= 60 ? "good" : conf >= 35 ? "warn" : "bad"}
        />
        <StatCard
          icon={<Target size={16} />}
          label="Answered well"
          value={`${answered}%`}
          tone={answered >= 70 ? "good" : answered >= 40 ? "warn" : "bad"}
        />
      </div>

      {/* FAQ — browsable answers for new members */}
      {data.faqs.length > 0 && (
        <section className="insights-section">
          <h3 className="insights-section-title">
            <BookOpen size={14} /> Team FAQ
            <span className="insights-section-hint">Tap a question to see the answer</span>
          </h3>
          <div className="faq-list">
            {data.faqs.map((item) => (
              <FaqItem key={item.question} item={item} onAsk={onQuickAsk} />
            ))}
          </div>
        </section>
      )}

      {/* Knowledge gaps */}
      <section className="insights-section">
        <h3 className="insights-section-title">
          <AlertTriangle size={14} /> Knowledge gaps
        </h3>
        {data.gaps.length === 0 ? (
          <p className="insights-empty">No gaps detected — your documents answer what's being asked. 🎉</p>
        ) : (
          <div className="gap-list">
            {data.gaps.map((g, i) => (
              <motion.div
                key={g.question}
                className="gap-card"
                initial={{ opacity: 0, x: -10 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: i * 0.05 }}
              >
                <div className="gap-main">
                  <span className="gap-question">{g.question}</span>
                  <span className="gap-hint">No document answers this well — add content to cover it.</span>
                </div>
                <div className="gap-meta">
                  <span className="gap-count">asked {g.count}×</span>
                  <span className="gap-score">best {Math.round(g.best_score * 100)}%</span>
                </div>
              </motion.div>
            ))}
          </div>
        )}
      </section>

      {/* Top questions with quick-ask */}
      <section className="insights-section">
        <h3 className="insights-section-title">
          <MessageSquare size={14} /> Top questions
          <span className="insights-section-hint">Click to ask in chat</span>
        </h3>
        <div className="topq-list">
          {data.top_questions.map((q, i) => (
            <motion.div
              key={q.question}
              className="topq-row topq-row-clickable"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: i * 0.04 }}
              onClick={() => onQuickAsk(q.question)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => e.key === "Enter" && onQuickAsk(q.question)}
              title="Click to ask this in chat"
            >
              <span className="topq-rank">{i + 1}</span>
              <span className="topq-text">{q.question}</span>
              <span className="topq-count">{q.count}×</span>
              <span className="topq-bar-track">
                <span
                  className={`topq-bar-fill${q.avg_score < 0.3 ? " low" : ""}`}
                  style={{ width: `${Math.min(q.avg_score * 100, 100)}%` }}
                />
              </span>
              <Zap size={11} className="topq-ask-icon" />
            </motion.div>
          ))}
        </div>
      </section>
    </div>
  );
}
