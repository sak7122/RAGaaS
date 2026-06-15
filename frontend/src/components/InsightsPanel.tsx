import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  TrendingUp, AlertTriangle, MessageSquare, Target,
  RefreshCcw, ChevronDown, Zap, BookOpen,
} from "lucide-react";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell,
} from "recharts";
import { CountUp, SpotlightCard, BlurIn, Skeleton } from "./ui";

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

function StatCard({
  icon, label, value, to, suffix, tone, delay,
}: {
  icon: React.ReactNode;
  label: string;
  value?: string;
  to?: number;
  suffix?: string;
  tone?: "good" | "warn" | "bad";
  delay?: number;
}) {
  return (
    <BlurIn delay={delay ?? 0} className={`insight-stat${tone ? ` ${tone}` : ""}`}>
      <span className="insight-stat-icon">{icon}</span>
      <span className="insight-stat-value">
        {to !== undefined ? <CountUp to={to} suffix={suffix ?? ""} /> : value}
      </span>
      <span className="insight-stat-label">{label}</span>
    </BlurIn>
  );
}

function FaqItem({ item, onAsk }: { item: Insights["faqs"][0]; onAsk: (q: string) => void }) {
  const [open, setOpen] = useState(false);
  const pct = Math.round(item.score * 100);
  const cls = pct >= 70 ? "good" : pct >= 50 ? "warn" : "bad";
  return (
    <motion.div className="faq-card" layout>
      <button type="button" className="faq-header" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="faq-question">{item.question}</span>
        <span className="faq-header-right">
          <span className={`faq-confidence ${cls}`}>{pct}%</span>
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
            transition={{ duration: 0.22 }}
          >
            <p className="faq-answer">{item.answer}</p>
            <button type="button" className="btn-ask-this" onClick={() => onAsk(item.question)}>
              <Zap size={12} /> Ask again in chat
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

// Custom tooltip for recharts
function ChartTooltip({ active, payload }: { active?: boolean; payload?: { payload: { question: string; count: number; avg_score: number } }[] }) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div className="chart-tooltip">
      <p className="chart-tooltip-q">{d.question}</p>
      <p className="chart-tooltip-meta">{d.count}× asked · {Math.round(d.avg_score * 100)}% confidence</p>
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div className="insights-wrap">
      <div className="insights-head">
        <div>
          <Skeleton style={{ width: 180, height: 26, marginBottom: 8 }} />
          <Skeleton style={{ width: 300, height: 16 }} />
        </div>
      </div>
      <div className="insight-stats">
        {[0, 1, 2].map((i) => <Skeleton key={i} style={{ height: 90, borderRadius: 16 }} />)}
      </div>
      <Skeleton style={{ height: 220, borderRadius: 16, marginTop: 16 }} />
    </div>
  );
}

export function InsightsPanel({ fetchInsights, onQuickAsk }: Props) {
  const [data, setData] = useState<Insights | null>(null);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    const result = await fetchInsights();
    if (result) result.faqs = result.faqs ?? [];
    setData(result);
    setLoading(false);
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  if (loading && !data) return <LoadingSkeleton />;

  if (!data || data.total_queries === 0) {
    return (
      <div className="insights-wrap">
        <div className="insights-empty-state">
          <motion.div
            animate={{ y: [0, -8, 0] }}
            transition={{ duration: 3, repeat: Infinity, ease: "easeInOut" }}
          >
            <Target size={44} strokeWidth={1.2} color="var(--primary)" />
          </motion.div>
          <h3>No questions yet</h3>
          <p>Ask a few questions in chat — this dashboard shows what your team searches for and where your knowledge base has gaps.</p>
        </div>
      </div>
    );
  }

  const conf = Math.round(data.avg_confidence * 100);
  const answered = Math.round(data.answered_rate * 100);

  const chartData = data.top_questions.slice(0, 6).map((q) => ({
    question: q.question.length > 32 ? q.question.slice(0, 30) + "…" : q.question,
    fullQuestion: q.question,
    count: q.count,
    avg_score: q.avg_score,
  }));

  return (
    <div className="insights-wrap">
      <div className="insights-head">
        <div>
          <h2 className="insights-title">Knowledge Insights</h2>
          <p className="insights-sub">What your team asks — and where your documents fall short.</p>
        </div>
        <motion.button
          type="button"
          className="btn-ghost"
          onClick={load}
          whileHover={{ scale: 1.04 }}
          whileTap={{ scale: 0.94 }}
        >
          <RefreshCcw size={13} className={loading ? "spin" : ""} /> Refresh
        </motion.button>
      </div>

      {/* Stats row */}
      <div className="insight-stats">
        <StatCard
          icon={<MessageSquare size={16} />}
          label="Questions asked"
          to={data.total_queries}
          delay={0}
        />
        <StatCard
          icon={<TrendingUp size={16} />}
          label="Avg confidence"
          to={conf}
          suffix="%"
          tone={conf >= 60 ? "good" : conf >= 35 ? "warn" : "bad"}
          delay={0.08}
        />
        <StatCard
          icon={<Target size={16} />}
          label="Answered well"
          to={answered}
          suffix="%"
          tone={answered >= 70 ? "good" : answered >= 40 ? "warn" : "bad"}
          delay={0.16}
        />
      </div>

      {/* Top questions bar chart */}
      {chartData.length > 0 && (
        <BlurIn delay={0.24} className="insights-section">
          <h3 className="insights-section-title">
            <MessageSquare size={14} /> Top questions
            <span className="insights-section-hint">Click bar to ask in chat</span>
          </h3>
          <div className="chart-wrap">
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={chartData} layout="vertical" margin={{ left: 0, right: 16, top: 4, bottom: 4 }}>
                <XAxis type="number" hide />
                <YAxis
                  type="category"
                  dataKey="question"
                  width={180}
                  tick={{ fontSize: 11, fill: "var(--ink-48)" }}
                  axisLine={false}
                  tickLine={false}
                />
                <Tooltip content={<ChartTooltip />} cursor={{ fill: "rgba(0,102,204,0.06)" }} />
                <Bar
                  dataKey="count"
                  radius={[0, 6, 6, 0]}
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  onClick={(d: any) => d?.fullQuestion && onQuickAsk(d.fullQuestion)}
                  cursor="pointer"
                >
                  {chartData.map((entry, i) => (
                    <Cell
                      key={i}
                      fill={entry.avg_score >= 0.5
                        ? `rgba(0,102,204,${0.4 + i * 0.08})`
                        : `rgba(255,159,10,${0.5 + i * 0.05})`}
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </BlurIn>
      )}

      {/* FAQs */}
      {data.faqs.length > 0 && (
        <BlurIn delay={0.32} className="insights-section">
          <h3 className="insights-section-title">
            <BookOpen size={14} /> Team FAQ
            <span className="insights-section-hint">Tap to expand answer</span>
          </h3>
          <div className="faq-list">
            {data.faqs.map((item, i) => (
              <motion.div
                key={item.question}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.35 + i * 0.05 }}
              >
                <FaqItem item={item} onAsk={onQuickAsk} />
              </motion.div>
            ))}
          </div>
        </BlurIn>
      )}

      {/* Knowledge gaps */}
      <BlurIn delay={0.4} className="insights-section">
        <h3 className="insights-section-title">
          <AlertTriangle size={14} /> Knowledge gaps
          <span className="insights-section-hint">Upload docs to cover these</span>
        </h3>
        {data.gaps.length === 0 ? (
          <p className="insights-empty">No gaps — your documents cover what's being asked. 🎉</p>
        ) : (
          <div className="gap-list">
            {data.gaps.map((g, i) => (
              <SpotlightCard key={g.question} className="gap-card">
                <motion.div
                  initial={{ opacity: 0, x: -12 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: 0.42 + i * 0.06 }}
                >
                  <div className="gap-main">
                    <span className="gap-question">{g.question}</span>
                    <span className="gap-hint">Add content to cover this gap.</span>
                  </div>
                  <div className="gap-meta">
                    <span className="gap-count">asked {g.count}×</span>
                    <span className="gap-score bad">best {Math.round(g.best_score * 100)}%</span>
                    <motion.button
                      type="button"
                      className="btn-ask-this"
                      onClick={() => onQuickAsk(g.question)}
                      whileHover={{ scale: 1.04 }}
                      whileTap={{ scale: 0.95 }}
                    >
                      <Zap size={10} /> Try in chat
                    </motion.button>
                  </div>
                </motion.div>
              </SpotlightCard>
            ))}
          </div>
        )}
      </BlurIn>
    </div>
  );
}
