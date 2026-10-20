// Academy admin dashboard (M4): who is ready, who is stuck, what to fix in the content.
import { useCallback, useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { Award, CircleCheck, Download, Hourglass, PlayCircle, TriangleAlert, Users } from "lucide-react";
import { Avatar, Bar, CountUp, EASE_OUT, rise } from "./academyMotion";
import { Notice, downloadFile, readError } from "./academyShared";

type Api = (path: string, init?: RequestInit) => Promise<Response>;
type Status = "assigned" | "in_progress" | "passed" | "certified";
type Totals = {
  learners: number; not_signed_in: number; assignments: number; in_progress: number;
  completed: number; awaiting_signoff: number; certified: number; overdue: number;
};
type DashPath = {
  id: string; title: string; status: string; pass_mark: number; due_days: number | null; lessons: number;
  eligible: number; started: number; passed: number; certified: number; overdue: number;
  avg_score: number | null; median_days_to_ready: number | null;
};
type LearnerPath = {
  path_id: string; title: string; status: Status; score: number | null; modules_passed: number;
  modules_total: number; assigned_at: string | null; due_at: string | null; overdue: boolean;
  completed_at: string | null; certified_at: string | null; weak_modules: string[];
};
type DashLearner = {
  uid: string; email: string; name: string | null; department: string | null; role: string | null;
  pending: boolean; last_active: string | null; paths: LearnerPath[];
};
type Dash = {
  totals: Totals; paths: DashPath[]; learners: DashLearner[];
  hardest: { item_id: string; stem: string; type: string; module_title: string; path_title: string; attempts: number; avg_score: number }[];
  gaps: { question: string; count: number; last_asked: string }[];
  stale: { path_id: string; title: string; status: string; stale_lessons: number; stale_questions: number }[];
};
type Filter = "all" | "overdue" | "signoff" | "not_started";
const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "Everyone" }, { id: "overdue", label: "Overdue" },
  { id: "signoff", label: "Awaiting sign-off" }, { id: "not_started", label: "Not started" },
];

// Funnel stages are ordinal, so one hue light → dark (validated: adjacent ΔE ≥ 15).
const STAGES = [
  { key: "not_started", label: "Not started", cls: "is-s0" },
  { key: "in_progress", label: "In progress", cls: "is-s1" },
  { key: "awaiting", label: "Passed, awaiting sign-off", cls: "is-s2" },
  { key: "certified", label: "Certified", cls: "is-s3" },
] as const;
const STATUS_LABEL: Record<Status, string> = {
  assigned: "Not started", in_progress: "In progress", passed: "Awaiting sign-off", certified: "Certified",
};

const pct = (x: number) => `${Math.round(x * 100)}%`;
function day(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "" : d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

export function ProgressDashboard({ api, onOpenPath }: { api: Api; onOpenPath: (pathId: string) => void }) {
  const [data, setData] = useState<Dash | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api("/api/academy/dashboard");
      if (!r.ok) { setError(await readError(r)); return; }
      setData(await r.json()); setError("");
    } catch { setError("Network error. Check your connection and try again."); }
  }, [api]);
  useEffect(() => { load(); }, [load]);

  const rows = useMemo(() => {
    if (!data) return [];
    const q = query.trim().toLowerCase();
    return data.learners.flatMap((lr) => lr.paths.map((p) => ({ lr, p })))
      .filter(({ lr, p }) =>
        (!q || [lr.name, lr.email, lr.department, lr.role, p.title].some((v) => v?.toLowerCase().includes(q)))
        && (filter === "all" || (filter === "overdue" && p.overdue) || (filter === "signoff" && p.status === "passed")
            || (filter === "not_started" && p.status === "assigned")))
      .sort((a, b) => Number(b.p.overdue) - Number(a.p.overdue)
        || Number(b.p.status === "passed") - Number(a.p.status === "passed"));
  }, [data, filter, query]);

  const counts = useMemo(() => {
    const all = data ? data.learners.flatMap((lr) => lr.paths) : [];
    return {
      all: all.length, overdue: all.filter((p) => p.overdue).length,
      signoff: all.filter((p) => p.status === "passed").length, not_started: all.filter((p) => p.status === "assigned").length,
    } as Record<Filter, number>;
  }, [data]);

  async function signOff(lr: DashLearner, p: LearnerPath) {
    setBusy(`${lr.uid}:${p.path_id}`); setNotice(null);
    try {
      const r = await api(`/api/academy/paths/${p.path_id}/learners/${encodeURIComponent(lr.uid)}/certify`, { method: "POST" });
      if (!r.ok) { setNotice({ kind: "error", text: await readError(r) }); return; }
      setNotice({ kind: "ok", text: `${lr.name || lr.email} is certified for ${p.title}.` });
      await load();
    } finally { setBusy(null); }
  }

  async function certificate(lr: DashLearner, p: LearnerPath) {
    const err = await downloadFile(api, `/api/academy/paths/${p.path_id}/learners/${encodeURIComponent(lr.uid)}/certificate`,
                                   "certificate.pdf");
    if (err) setNotice({ kind: "error", text: err });
  }

  if (!data) {
    return (
      <div className="acad-section">
        {error ? <Notice kind="error">{error}</Notice> : <div className="acx-skel" aria-label="Loading progress"><i /><i /><i /></div>}
      </div>
    );
  }
  const t = data.totals;
  return (
    <div className="acad-section">
      <div className="dash-tiles">
        <Tile i={0} icon={<Users size={15} />} label="Learners" value={t.learners} note={t.not_signed_in ? `${t.not_signed_in} not signed in yet` : undefined} />
        <Tile i={1} icon={<PlayCircle size={15} />} label="In progress" value={t.in_progress} note={`of ${t.assignments} assignment${t.assignments === 1 ? "" : "s"}`} />
        <Tile i={2} icon={<Hourglass size={15} />} label="Completed" value={t.completed} note={t.awaiting_signoff ? `${t.awaiting_signoff} awaiting sign-off` : undefined} />
        <Tile i={3} icon={<CircleCheck size={15} />} label="Certified" value={t.certified} good />
        <Tile i={4} icon={<TriangleAlert size={15} />} label="Overdue" value={t.overdue} warn={t.overdue > 0} />
      </div>

      {notice && <Notice kind={notice.kind} onClose={() => setNotice(null)}>{notice.text}</Notice>}

      <section className="acad-card" aria-labelledby="dash-paths-h">
        <div className="learn-card-head">
          <h3 className="acad-h3" id="dash-paths-h">Paths</h3>
          <span className="acad-spacer" />
          <ul className="dash-legend" aria-label="Legend">
            {STAGES.map((s) => <li key={s.key}><span className={`dash-swatch ${s.cls}`} aria-hidden="true" />{s.label}</li>)}
          </ul>
        </div>
        {data.paths.length === 0 ? (
          <p className="acad-empty">No published paths yet. Generate and publish one in Learning paths.</p>
        ) : (
          <ul className="dash-paths">{data.paths.map((p, i) => <FunnelRow key={p.id} p={p} i={i} />)}</ul>
        )}
      </section>

      <section className="acad-card" aria-labelledby="dash-people-h">
        <div className="learn-card-head">
          <h3 className="acad-h3" id="dash-people-h">People</h3>
          <span className="acad-spacer" />
          <label className="sr-only" htmlFor="dash-q">Search people</label>
          <input id="dash-q" className="authx-input dash-search" placeholder="Search name, team, path"
                 value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <div className="acx-chips" role="radiogroup" aria-label="Show">
          {FILTERS.map((f) => {
            const on = filter === f.id;
            return (
              <button key={f.id} type="button" role="radio" aria-checked={on}
                      className={`acx-chip${on ? " is-on" : ""}`} onClick={() => setFilter(f.id)}>
                {on && <motion.span layoutId="dash-filter-pill" className="acx-chip-pill" transition={{ type: "spring", stiffness: 500, damping: 40 }} />}
                <span>{f.label}</span><span className="acx-chip-n">{counts[f.id]}</span>
              </button>
            );
          })}
        </div>
        {data.learners.length === 0 ? (
          <p className="acad-empty">No learners yet. Add them under Learners; progress shows up here once they start.</p>
        ) : rows.length === 0 ? (
          <p className="acad-empty">Nobody matches this view.</p>
        ) : (
          <div className="acad-table-wrap">
            <table className="acad-table dash-table">
              <thead><tr><th>Person</th><th>Path</th><th>Progress</th><th>Due</th><th>Status</th></tr></thead>
              <tbody>
                {rows.map(({ lr, p }, i) => (
                  <motion.tr key={`${lr.uid}:${p.path_id}`} {...rise(i, 0.05)}>
                    <td>
                      <span className="acx-person">
                        <Avatar name={lr.name || lr.email} />
                        <span>
                          <span className="acad-strong">{lr.name || lr.email}</span>
                          {lr.pending && <span className="acad-pill">Not signed in yet</span>}
                          <span className="acad-muted acad-small acad-block">
                            {[lr.department, lr.role].filter(Boolean).join(" · ") || "No team set"}
                            {lr.last_active && ` · active ${day(lr.last_active)}`}
                          </span>
                        </span>
                      </span>
                    </td>
                    <td>
                      {p.title}
                      {p.weak_modules.length > 0 && (
                        <span className="acad-small acad-block dash-weak">Struggling with: {p.weak_modules.join(", ")}</span>
                      )}
                    </td>
                    <td className="acx-prog-cell">
                      <span className="acx-prog">
                        <Bar value={p.modules_total ? p.modules_passed / p.modules_total : 0}
                             tone={p.overdue ? "red" : p.status === "certified" || p.status === "passed" ? "green" : "blue"} delay={0.1 + i * 0.04} />
                        <span className="num">{p.modules_passed}/{p.modules_total}</span>
                      </span>
                      {p.score !== null && <span className="acad-muted acad-small acad-block">score {pct(p.score)}</span>}
                    </td>
                    <td>
                      {p.overdue ? (
                        <span className="dash-overdue"><TriangleAlert size={14} aria-hidden="true" /> Overdue · {day(p.due_at)}</span>
                      ) : p.due_at && p.status !== "passed" && p.status !== "certified" ? day(p.due_at) : <span className="acad-muted">—</span>}
                    </td>
                    <td>
                      <div className="dash-status">
                      <span className={`acad-badge${p.status === "certified" ? " is-published" : ""}`}>{STATUS_LABEL[p.status]}</span>
                      {p.status === "passed" && (
                        <button type="button" className="authx-btn authx-btn-primary acad-btn-auto dash-btn"
                                disabled={busy === `${lr.uid}:${p.path_id}`} onClick={() => signOff(lr, p)}>
                          <Award size={14} aria-hidden="true" /> Sign off
                        </button>
                      )}
                      {p.status === "certified" && (
                        <button type="button" className="authx-link authx-link-sm dash-link" onClick={() => certificate(lr, p)}>
                          <Download size={13} aria-hidden="true" /> Certificate
                        </button>
                      )}
                      </div>
                    </td>
                  </motion.tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <div className="acad-two">
        <section className="acad-card" aria-labelledby="dash-hard-h">
          <h3 className="acad-h3" id="dash-hard-h">Hardest questions</h3>
          <p className="acad-help">Lowest average score, from questions answered at least 3 times. Rewrite these, or the lesson behind them.</p>
          {data.hardest.length === 0 ? <p className="acad-empty">Not enough answers yet.</p> : (
            <ol className="dash-list">
              {data.hardest.map((h, i) => (
                <motion.li key={h.item_id} {...rise(i, 0.1)}>
                  <span className="dash-list-main">
                    <span>{h.stem}</span>
                    <span className="acad-muted acad-small">{h.path_title} · {h.module_title}</span>
                    <Bar value={h.avg_score} tone={h.avg_score < 0.5 ? "red" : h.avg_score < 0.7 ? "orange" : "green"} delay={0.2 + i * 0.06} />
                  </span>
                  <span className="dash-num">{pct(h.avg_score)}<span className="acad-muted acad-small"> avg · {h.attempts}×</span></span>
                </motion.li>
              ))}
            </ol>
          )}
        </section>

        <section className="acad-card" aria-labelledby="dash-gaps-h">
          <h3 className="acad-h3" id="dash-gaps-h">Knowledge gaps</h3>
          <p className="acad-help">Questions people asked that your documents couldn't answer. Each one is a doc worth writing.</p>
          {data.gaps.length === 0 ? <p className="acad-empty">No unanswered questions yet.</p> : (
            <ol className="dash-list">
              {data.gaps.map((g, i) => (
                <motion.li key={g.question} {...rise(i, 0.1)}>
                  <span className="dash-list-main">
                    <span>{g.question}</span>
                    <span className="acad-muted acad-small">last asked {day(g.last_asked)}</span>
                  </span>
                  <span className="dash-num acx-bubble">{g.count}×</span>
                </motion.li>
              ))}
            </ol>
          )}
        </section>
      </div>

      {data.stale.length > 0 && (
        <section className="acad-card" aria-labelledby="dash-stale-h">
          <h3 className="acad-h3" id="dash-stale-h">Needs review</h3>
          <p className="acad-help">These paths cite documents that changed. Learners don't see the affected lessons until you review and republish.</p>
          <ul className="dash-list">
            {data.stale.map((s) => (
              <li key={s.path_id}>
                <span className="dash-list-main">
                  <span className="acad-strong">{s.title}</span>
                  <span className="acad-muted acad-small">
                    {s.stale_lessons} lesson{s.stale_lessons === 1 ? "" : "s"}, {s.stale_questions} question{s.stale_questions === 1 ? "" : "s"}
                  </span>
                </span>
                <button type="button" className="authx-btn authx-btn-secondary acad-btn-auto dash-btn" onClick={() => onOpenPath(s.path_id)}>Review</button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function Tile({ label, value, note, warn, good, icon, i }: {
  label: string; value: number; note?: string; warn?: boolean; good?: boolean; icon: React.ReactNode; i: number;
}) {
  return (
    <motion.div className={`dash-tile${warn ? " is-warn" : ""}${good ? " is-good" : ""}`} {...rise(i)}>
      <span className="dash-tile-label"><span className="acx-tile-ico" aria-hidden="true">{icon}</span>{label}</span>
      <span className="dash-tile-value"><CountUp value={value} /></span>
      {note && <span className="acad-muted acad-small">{note}</span>}
    </motion.div>
  );
}

function FunnelRow({ p, i }: { p: DashPath; i: number }) {
  const counts = {
    not_started: p.eligible - p.started, in_progress: p.started - p.passed,
    awaiting: p.passed - p.certified, certified: p.certified,
  };
  const meta = [
    `${p.lessons} lesson${p.lessons === 1 ? "" : "s"}`, `pass mark ${pct(p.pass_mark)}`,
    p.due_days ? `due in ${p.due_days} days` : "",
    p.avg_score !== null ? `avg score ${pct(p.avg_score)}` : "",
    p.median_days_to_ready !== null ? `ready in ${p.median_days_to_ready} days (median)` : "",
  ].filter(Boolean).join(" · ");
  return (
    <motion.li className="dash-path" {...rise(i, 0.1)}>
      <div className="dash-path-head">
        <span className="acad-strong">{p.title}</span>
        {p.status !== "published" && <span className="acad-badge is-stale">{p.status === "stale" ? "Needs review" : "Has unpublished edits"}</span>}
        <span className="acad-spacer" />
        {p.overdue > 0 && <span className="dash-overdue"><TriangleAlert size={14} aria-hidden="true" /> {p.overdue} overdue</span>}
      </div>
      {p.eligible > 0 ? (
        <motion.div className="dash-bar acx-funnel" role="img"
             aria-label={STAGES.map((s) => `${s.label}: ${counts[s.key]}`).join(", ")}
             initial={{ transform: "scaleX(0)" }}
             animate={{ transform: "scaleX(1)", transition: { duration: 0.9, ease: EASE_OUT, delay: 0.2 + i * 0.08 } }}>
          {STAGES.filter((s) => counts[s.key] > 0).map((s) => (
            <span key={s.key} className={`dash-seg ${s.cls}`} style={{ flexGrow: counts[s.key] }}
                  title={`${s.label}: ${counts[s.key]} of ${p.eligible}`} />
          ))}
        </motion.div>
      ) : <p className="acad-muted acad-small">Nobody matches this path's audience yet.</p>}
      <p className="acad-small dash-counts">
        <span className="acad-strong">{p.eligible}</span> assigned · <span className="acad-strong">{p.started}</span> started ·{" "}
        <span className="acad-strong">{p.passed}</span> passed · <span className="acad-strong">{p.certified}</span> certified
      </p>
      <p className="acad-muted acad-small">{meta}</p>
    </motion.li>
  );
}
