import { FormEvent, useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ArrowLeft, Sparkles, ArrowRight, Search, MessageSquare, Workflow, Check, Loader2 } from "lucide-react";
import { watchAuth, devSignInTenant } from "../firebase";
import {
  WorkflowResult, WorkflowSolution, ExecResult,
} from "../components/WorkflowView";
import { DEMO, demoFetch } from "../demoBackend";
import "../styles.css";

const API          = import.meta.env.VITE_API_URL ?? "http://127.0.0.1:8000";
const USE_EMULATOR = import.meta.env.VITE_FIREBASE_USE_EMULATOR === "true";
const apiFetch: typeof fetch = DEMO
  ? ((input, init) => demoFetch(input as string, init as RequestInit)) as typeof fetch
  : fetch;

const PROMPTS = [
  "Onboard a new backend engineer",
  "Draft our incident response runbook",
  "How do we offboard a contractor?",
  "Plan a security audit for next quarter",
];

// ── Auth bootstrap (standalone page needs its own token) ──────────────────────
function useToken() {
  const [token, setToken] = useState(DEMO ? "demo-token" : "");
  const [ready, setReady] = useState(DEMO);
  useEffect(() => {
    if (DEMO) return;
    if (USE_EMULATOR) {
      const email = new URLSearchParams(window.location.search).get("tenant") || "demo@ragaas.local";
      devSignInTenant(email).then((t) => { setToken(t); setReady(true); })
        .catch(() => setReady(true));
      return;
    }
    return watchAuth(async (u) => {
      if (u) setToken(await u.getIdToken());
      setReady(true);
    });
  }, []);
  return { token, ready };
}

// ── Pipeline tracker — perceived progress of retrieve → answer → structure ────
const STAGES = [
  { key: "retrieve",  label: "Retrieving documents", icon: Search },
  { key: "answer",    label: "Reading & answering",  icon: MessageSquare },
  { key: "structure", label: "Building workflow",    icon: Workflow },
];

function PipelineTracker({ stage }: { stage: number }) {
  return (
    <div className="sp-pipe">
      {STAGES.map((s, i) => {
        const Icon = s.icon;
        const state = i < stage ? "done" : i === stage ? "active" : "pending";
        return (
          <div key={s.key} className={`sp-pipe-row sp-pipe-${state}`}>
            <span className="sp-pipe-icon">
              {state === "done" ? <Check size={14} />
                : state === "active" ? <Loader2 size={14} className="wf-spin" />
                : <Icon size={14} />}
            </span>
            <span className="sp-pipe-label">{s.label}</span>
            <span className="sp-pipe-dots">
              {[0, 1, 2, 3].map((d) => (
                <motion.span key={d} className="sp-pipe-dot"
                  animate={state === "active"
                    ? { opacity: [0.25, 1, 0.25] }
                    : { opacity: state === "done" ? 1 : 0.25 }}
                  transition={{ duration: 1, repeat: state === "active" ? Infinity : 0, delay: d * 0.12 }} />
              ))}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ── Orb idle toy — fidget while you wait ──────────────────────────────────────
type Pop = { id: number; x: number; y: number };
function OrbToy() {
  const [score, setScore] = useState(0);
  const [combo, setCombo] = useState(0);
  const [pops, setPops] = useState<Pop[]>([]);
  const idRef = useRef(0);
  const comboTimer = useRef<number | null>(null);

  function tap(e: React.MouseEvent<HTMLButtonElement>) {
    const r = e.currentTarget.getBoundingClientRect();
    const id = idRef.current++;
    setPops((p) => [...p, { id, x: e.clientX - r.left, y: e.clientY - r.top }]);
    setTimeout(() => setPops((p) => p.filter((q) => q.id !== id)), 650);
    setCombo((c) => c + 1);
    setScore((s) => s + 1 + Math.floor(combo / 5));
    if (comboTimer.current) window.clearTimeout(comboTimer.current);
    comboTimer.current = window.setTimeout(() => setCombo(0), 1200);
  }

  return (
    <div className="sp-toy">
      <div className="sp-toy-head">
        <span>Bored? Tap the orb.</span>
        <span className="sp-toy-score">
          {score} pts{combo > 2 && <em className="sp-toy-combo"> ×{combo} combo!</em>}
        </span>
      </div>
      <motion.button type="button" className="sp-orb" onClick={tap}
        whileTap={{ scale: 0.86 }}
        animate={{ scale: [1, 1.04, 1] }}
        transition={{ scale: { duration: 2.4, repeat: Infinity, ease: "easeInOut" } }}>
        <span className="sp-orb-core" />
        <AnimatePresence>
          {pops.map((p) => (
            <motion.span key={p.id} className="sp-orb-pop"
              style={{ left: p.x, top: p.y }}
              initial={{ opacity: 1, scale: 0.4, y: 0 }}
              animate={{ opacity: 0, scale: 1.4, y: -34 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.65 }}>+{1 + Math.floor(combo / 5)}</motion.span>
          ))}
        </AnimatePresence>
      </motion.button>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────
export function SolvePage() {
  const { token, ready } = useToken();
  const [problem, setProblem] = useState("");
  const [solution, setSolution] = useState<WorkflowSolution | null>(null);
  const [error, setError] = useState("");
  const [solving, setSolving] = useState(false);
  const [stage, setStage] = useState(0);
  const heroRef = useRef<HTMLDivElement>(null);

  function spotlight(e: React.MouseEvent<HTMLDivElement>) {
    const el = heroRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    el.style.setProperty("--spot-x", `${e.clientX - r.left}px`);
    el.style.setProperty("--spot-y", `${e.clientY - r.top}px`);
  }

  async function run(text: string) {
    const q = text.trim();
    if (!q || solving || !token) return;
    setSolving(true); setSolution(null); setError(""); setStage(0);
    // Perceived-progress: advance stages on a timer while the request is in flight.
    const t1 = window.setTimeout(() => setStage(1), 700);
    const t2 = window.setTimeout(() => setStage(2), 1600);
    try {
      const res = await apiFetch(`${API}/api/solve`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ problem: q }),
      });
      window.clearTimeout(t1); window.clearTimeout(t2);
      setStage(3);
      if (!res.ok) { setError(`Solve failed (HTTP ${res.status}).`); }
      else { await new Promise((r) => setTimeout(r, 350)); setSolution(await res.json()); }
    } catch {
      setError("Network error — is the backend running?");
    } finally {
      window.clearTimeout(t1); window.clearTimeout(t2);
      setSolving(false);
    }
  }

  async function execute(tool: string, args: Record<string, unknown>): Promise<ExecResult | null> {
    try {
      const res = await apiFetch(`${API}/api/actions/execute`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ tool, args, approved: true }),
      });
      const body = await res.json();
      return { ok: !!body.ok, status: body.status, detail: body.detail ?? {} };
    } catch { return null; }
  }

  function submit(e: FormEvent) { e.preventDefault(); run(problem); }

  const needsAuth = ready && !token && !DEMO;

  return (
    <div className="sp">
      <header className="sp-bar">
        <a className="sp-back" href="/"><ArrowLeft size={16} /> Back</a>
        <span className="sp-brand">RAGaaS</span>
        <span className="sp-bar-tag"><Workflow size={12} /> Workflow Engine</span>
      </header>

      <main className="sp-main">
        <motion.div ref={heroRef} className="sp-hero" onMouseMove={spotlight}
          initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4 }}>
          <div className="sp-hero-glow" />
          <h1 className="sp-title">Describe a problem.<br /><span>Get a grounded plan.</span></h1>
          <p className="sp-sub">Not just an answer — an ordered, cited workflow with actions you can run.</p>

          <form className="sp-form" onSubmit={submit}>
            <input
              className="sp-input"
              value={problem}
              onChange={(e) => setProblem(e.target.value)}
              placeholder="e.g. Onboard a new backend engineer…"
              disabled={solving || needsAuth}
            />
            <motion.button type="submit" className="sp-go"
              disabled={solving || needsAuth || !problem.trim()}
              whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}>
              {solving ? <Loader2 size={16} className="wf-spin" /> : <Sparkles size={16} />}
              {!solving && <ArrowRight size={16} />}
            </motion.button>
          </form>

          {!solving && !solution && (
            <div className="sp-prompts">
              {PROMPTS.map((p, i) => (
                <motion.button key={p} type="button" className="sp-chip"
                  onClick={() => { setProblem(p); run(p); }} disabled={needsAuth}
                  initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.12 + i * 0.05 }} whileHover={{ y: -2 }}>
                  {p}
                </motion.button>
              ))}
            </div>
          )}
        </motion.div>

        {needsAuth && (
          <div className="sp-note">Sign in on the <a href="/">main app</a> first, then return here.</div>
        )}

        <AnimatePresence mode="wait">
          {solving && (
            <motion.div key="run" className="sp-running"
              initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
              <PipelineTracker stage={stage} />
              <OrbToy />
            </motion.div>
          )}

          {error && !solving && (
            <motion.div key="err" className="sp-error"
              initial={{ opacity: 0 }} animate={{ opacity: 1 }}>{error}</motion.div>
          )}

          {solution && !solving && (
            <motion.div key="res" className="sp-result"
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              <WorkflowResult solution={solution} onExecute={execute} disabled={needsAuth} />
              <button className="sp-again" onClick={() => { setSolution(null); setProblem(""); }}>
                ← Solve another problem
              </button>
            </motion.div>
          )}
        </AnimatePresence>
      </main>
    </div>
  );
}
