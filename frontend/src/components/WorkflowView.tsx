import { MouseEvent, ReactNode, useRef, useState } from "react";
import {
  motion,
  AnimatePresence,
  useMotionValue,
  useSpring,
  useTransform,
} from "framer-motion";
import {
  FileText, UserRound, Lock,
  CircleHelp, Check, X, Loader2, Zap, ShieldCheck,
} from "lucide-react";

// ── Types (mirror backend/workflow.py) ────────────────────────────────────────
export type SourceRef = {
  file_name: string; page: number; chunk_index: number; excerpt: string; score: number;
};
export type ToolCall = {
  tool: string; args: Record<string, unknown>;
  requires_approval: boolean; status: string;
  idempotency_key?: string | null; result?: Record<string, unknown> | null;
};
export type WorkflowStep = {
  n: number; action: string; rationale: string;
  owner_hint?: string | null; blocking: boolean;
  sources: SourceRef[]; suggested_tool_call?: ToolCall | null;
};
export type WorkflowSolution = {
  problem: string; steps: WorkflowStep[]; open_questions: string[];
  confidence: number; tenant_id: string; queries_used: number; query_limit: number;
};

export type ExecResult = { ok: boolean; status: string; detail: Record<string, unknown> };
export type OnExecute = (tool: string, args: Record<string, unknown>) => Promise<ExecResult | null>;

// ── Pointer-tilt card — the mouse tracker ─────────────────────────────────────
function TiltCard({ children, className }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const px = useMotionValue(0.5);
  const py = useMotionValue(0.5);
  const rx = useSpring(useTransform(py, [0, 1], [6, -6]), { stiffness: 200, damping: 18 });
  const ry = useSpring(useTransform(px, [0, 1], [-6, 6]), { stiffness: 200, damping: 18 });

  function onMove(e: MouseEvent<HTMLDivElement>) {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const y = (e.clientY - r.top) / r.height;
    px.set(x); py.set(y);
    el.style.setProperty("--spot-x", `${x * 100}%`);
    el.style.setProperty("--spot-y", `${y * 100}%`);
  }
  function onLeave() { px.set(0.5); py.set(0.5); }

  return (
    <motion.div
      ref={ref}
      className={`wf-tilt ${className ?? ""}`}
      onMouseMove={onMove}
      onMouseLeave={onLeave}
      style={{ rotateX: rx, rotateY: ry, transformPerspective: 900 }}
    >
      {children}
    </motion.div>
  );
}

// ── Confidence ring ───────────────────────────────────────────────────────────
function ConfidenceRing({ value }: { value: number }) {
  const pct = Math.round(value * 100);
  const R = 22, C = 2 * Math.PI * R;
  const tone = value >= 0.66 ? "var(--green)" : value >= 0.33 ? "var(--orange)" : "var(--red)";
  return (
    <div className="wf-ring" title="Planner confidence">
      <svg width="56" height="56" viewBox="0 0 56 56">
        <circle cx="28" cy="28" r={R} fill="none" stroke="var(--hairline)" strokeWidth="5" />
        <motion.circle
          cx="28" cy="28" r={R} fill="none" stroke={tone} strokeWidth="5"
          strokeLinecap="round" transform="rotate(-90 28 28)"
          strokeDasharray={C}
          initial={{ strokeDashoffset: C }}
          animate={{ strokeDashoffset: C - (C * value) }}
          transition={{ duration: 1, ease: [0.4, 0, 0.2, 1] }}
        />
      </svg>
      <span className="wf-ring-num">{pct}<small>%</small></span>
    </div>
  );
}

// ── Tool-call approval card ───────────────────────────────────────────────────
function ActionCard({ call, onExecute, disabled }: {
  call: ToolCall;
  onExecute: OnExecute;
  disabled: boolean;
}) {
  const [state, setState] = useState<"idle" | "running" | "done" | "blocked" | "error">("idle");
  const [msg, setMsg] = useState("");

  async function approve() {
    if (state === "running" || state === "done") return;
    setState("running");
    const res = await onExecute(call.tool, call.args);
    if (!res) { setState("error"); setMsg("Network error"); return; }
    if (res.status === "executed") {
      setState("done");
      setMsg(res.detail?.dry_run ? "Dry-run — no external call made" : "Executed");
    } else if (res.status === "rejected") {
      setState("blocked"); setMsg(String(res.detail?.reason ?? "Rejected"));
    } else {
      setState("error"); setMsg(String(res.detail?.error ?? "Failed"));
    }
  }

  return (
    <motion.div
      className={`wf-action wf-action-${state}`}
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.15 }}
    >
      <div className="wf-action-head">
        <Zap size={12} />
        <code className="wf-action-tool">{call.tool}</code>
        <span className="wf-action-gate"><Lock size={10} /> needs approval</span>
      </div>
      <div className="wf-action-args">
        {Object.entries(call.args).map(([k, v]) => (
          <span key={k} className="wf-arg"><b>{k}</b>{String(v)}</span>
        ))}
      </div>
      <div className="wf-action-foot">
        <AnimatePresence mode="wait">
          {state === "idle" ? (
            <motion.button
              key="approve" type="button" className="wf-approve"
              onClick={approve} disabled={disabled}
              whileHover={{ scale: 1.04 }} whileTap={{ scale: 0.94 }}
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            >
              <ShieldCheck size={13} /> Approve &amp; run
            </motion.button>
          ) : (
            <motion.span
              key="status" className="wf-action-status"
              initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }}
            >
              {state === "running" && <><Loader2 size={13} className="wf-spin" /> Running…</>}
              {state === "done" && <><Check size={13} color="var(--green)" /> {msg}</>}
              {state === "blocked" && <><X size={13} color="var(--orange)" /> {msg}</>}
              {state === "error" && <><X size={13} color="var(--red)" /> {msg}</>}
            </motion.span>
          )}
        </AnimatePresence>
      </div>
    </motion.div>
  );
}

// ── Step card ─────────────────────────────────────────────────────────────────
function StepCard({ step, onExecute, disabled }: {
  step: WorkflowStep; onExecute: OnExecute; disabled: boolean;
}) {
  return (
    <motion.li
      className="wf-step"
      initial={{ opacity: 0, x: -18 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ type: "spring", stiffness: 260, damping: 26 }}
    >
      <span className="wf-step-rail">
        <motion.span
          className="wf-step-num"
          initial={{ scale: 0 }} animate={{ scale: 1 }}
          transition={{ type: "spring", stiffness: 400, damping: 14, delay: 0.05 }}
        >
          {step.n}
        </motion.span>
      </span>
      <TiltCard className="wf-step-body">
        <div className="wf-step-spot" />
        <div className="wf-step-action">{step.action}</div>
        {step.rationale && <div className="wf-step-rationale">{step.rationale}</div>}
        <div className="wf-step-tags">
          {step.blocking && <span className="wf-tag wf-tag-block"><Lock size={10} /> blocking</span>}
          {step.owner_hint && <span className="wf-tag"><UserRound size={10} /> {step.owner_hint}</span>}
        </div>
        {step.sources.length > 0 && (
          <div className="wf-sources">
            {step.sources.map((s, i) => (
              <span key={i} className="wf-source" title={s.excerpt}>
                <FileText size={10} />
                {s.file_name.replace(/_/g, " ").replace(/\.(pdf|docx)$/i, "")}
                <em>p.{s.page}</em>
                <span className="wf-source-score">{Math.round(s.score * 100)}%</span>
              </span>
            ))}
          </div>
        )}
        {step.suggested_tool_call && (
          <ActionCard call={step.suggested_tool_call} onExecute={onExecute} disabled={disabled} />
        )}
      </TiltCard>
    </motion.li>
  );
}

// ── Result renderer (used by the standalone /solve page) ──────────────────────
export function WorkflowResult({ solution, onExecute, disabled }: {
  solution: WorkflowSolution;
  onExecute: OnExecute;
  disabled: boolean;
}) {
  return (
    <motion.div className="wf-result"
      initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35 }}>
      <div className="wf-result-head">
        <div className="wf-result-problem">
          <span className="wf-result-label">Workflow for</span>
          <h3>{solution.problem}</h3>
          <span className="wf-result-meta">
            {solution.steps.length} steps · {solution.tenant_id}
          </span>
        </div>
        <ConfidenceRing value={solution.confidence} />
      </div>

      {solution.steps.length > 0 ? (
        <motion.ol className="wf-steps"
          initial="hidden" animate="show"
          variants={{ show: { transition: { staggerChildren: 0.09 } } }}>
          {solution.steps.map((s) => (
            <StepCard key={s.n} step={s} onExecute={onExecute} disabled={disabled} />
          ))}
        </motion.ol>
      ) : (
        <div className="wf-empty-steps">
          <Zap size={18} /> No grounded steps — see open questions below.
        </div>
      )}

      {solution.open_questions.length > 0 && (
        <motion.div className="wf-gaps"
          initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2 }}>
          <span className="wf-gaps-label"><CircleHelp size={13} /> Open questions</span>
          <ul>
            {solution.open_questions.map((q, i) => <li key={i}>{q}</li>)}
          </ul>
        </motion.div>
      )}
    </motion.div>
  );
}
