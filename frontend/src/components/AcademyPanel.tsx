// Academy admin (M1 + M2): knowledge base, learners, learning paths.
// Reuses the .authx-* field/button styles; layout lives in .acad-* (styles.css).
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LearnerView } from "./LearnerView";
import { Markdown, Notice, readError } from "./academyShared";

interface Props {
  apiUrl: string;
  authHeaders: () => Record<string, string>;
}

type Doc = {
  id: string; title: string; sensitivity: number; dept_tags: string[]; role_tags: string[];
  updated_at: string; version: number; stale_marked?: number; unchanged?: boolean;
};
type Learner = {
  uid: string; email: string; role: string | null; department: string | null;
  seniority: number; clearance: number; pending: boolean;
};
type Item = {
  id: string; module_id: string; type: ItemType; stem: string;
  options: string[] | null; answer: number | boolean | null; explanation: string | null;
  source_doc_ids: string[]; status: string; rubric?: string | null;
};
type ItemType = "mcq" | "true_false" | "short_answer" | "scenario";
const ITEM_LABELS: Record<ItemType, string> = {
  mcq: "Multiple choice", true_false: "True / false", short_answer: "Short answer", scenario: "Scenario",
};
const isFreeText = (t: ItemType) => t === "short_answer" || t === "scenario";
type Module = {
  id: string; position: number; title: string; lesson_md: string;
  source_doc_ids: string[]; status: string; items: Item[];
};
type PathT = {
  id: string; title: string; status: string; error: string | null; updated_at: string;
  rules: { department?: string | null; role?: string | null; clearance?: number; module_count?: number };
  module_count: number; modules?: Module[] | null;
};

const LEVELS = ["Public", "Internal", "Restricted"];
type Section = "kb" | "learners" | "paths" | "learn";

// ── Small helpers ─────────────────────────────────────────────────────────────
function when(iso: string): string {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "" : d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

function StatusBadge({ status }: { status: string }) {
  const label: Record<string, string> = {
    generating: "Generating", failed: "Failed", draft: "Draft", published: "Published", stale: "Needs review",
  };
  return <span className={`acad-badge is-${status}`}>{label[status] ?? status}</span>;
}

function ConfirmButton({ label, confirmLabel, onConfirm, disabled }: {
  label: string; confirmLabel: string; onConfirm: () => void; disabled?: boolean;
}) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(t);
  }, [armed]);
  return armed ? (
    <button type="button" className="acad-btn-danger" disabled={disabled}
            onClick={() => { setArmed(false); onConfirm(); }}>{confirmLabel}</button>
  ) : (
    <button type="button" className="authx-link authx-link-sm" disabled={disabled}
            onClick={() => setArmed(true)}>{label}</button>
  );
}

// ── Knowledge base ────────────────────────────────────────────────────────────
function KnowledgeBase({ api, docs, reload }: {
  api: (path: string, init?: RequestInit) => Promise<Response>; docs: Doc[]; reload: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [level, setLevel] = useState("1");
  const [depts, setDepts] = useState("");
  const [roles, setRoles] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [inputKey, setInputKey] = useState(0);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!file || busy) return;
    setBusy(true); setNotice(null);
    const fd = new FormData();
    fd.append("file", file); fd.append("sensitivity", level);
    fd.append("dept_tags", depts); fd.append("role_tags", roles);
    try {
      const r = await api("/api/academy/documents", { method: "POST", body: fd });
      if (!r.ok) { setNotice({ kind: "error", text: await readError(r) }); return; }
      const d: Doc = await r.json();
      setNotice({
        kind: "ok",
        text: d.unchanged ? `${d.title} is already up to date.`
          : d.version > 1 ? `${d.title} updated to version ${d.version}.` +
            (d.stale_marked ? ` ${d.stale_marked} lesson or question${d.stale_marked > 1 ? "s" : ""} now need review.` : "")
          : `${d.title} added. It becomes searchable within a few minutes.`,
      });
      setFile(null); setInputKey((k) => k + 1); reload();
    } catch {
      setNotice({ kind: "error", text: "Network error. Check your connection and try again." });
    } finally { setBusy(false); }
  }

  async function remove(d: Doc) {
    const r = await api(`/api/academy/documents/${d.id}`, { method: "DELETE" });
    if (!r.ok) { setNotice({ kind: "error", text: await readError(r) }); return; }
    const body = await r.json();
    setNotice({ kind: "ok", text: `${d.title} removed.` + (body.stale_marked ? ` ${body.stale_marked} items now need review.` : "") });
    reload();
  }

  return (
    <div className="acad-section">
      <form className="acad-card acad-upload" onSubmit={submit}>
        <h3 className="acad-h3">Add a document</h3>
        <p className="acad-help">PDF, Word, Markdown or text, up to 10 MB. Uploading a file with the same name replaces it as a new version.</p>
        <div className="acad-grid">
          <div className="authx-field acad-span-2">
            <label className="authx-label" htmlFor="acad-file">File</label>
            <input key={inputKey} id="acad-file" type="file" className="authx-input acad-file"
                   accept=".pdf,.docx,.md,.txt" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </div>
          <div className="authx-field">
            <label className="authx-label" htmlFor="acad-level">Who can see it</label>
            <select id="acad-level" className="authx-input authx-select" value={level} onChange={(e) => setLevel(e.target.value)}>
              <option value="0">Public: everyone</option>
              <option value="1">Internal: staff</option>
              <option value="2">Restricted: cleared people only</option>
            </select>
          </div>
          <div className="authx-field">
            <label className="authx-label" htmlFor="acad-depts">Departments <span className="authx-optional">(optional)</span></label>
            <input id="acad-depts" className="authx-input" value={depts} placeholder="sales, support"
                   onChange={(e) => setDepts(e.target.value)} aria-describedby="acad-depts-hint" />
            <p className="authx-hint" id="acad-depts-hint">Leave empty for every department.</p>
          </div>
          <div className="authx-field">
            <label className="authx-label" htmlFor="acad-roles">Roles <span className="authx-optional">(optional)</span></label>
            <input id="acad-roles" className="authx-input" value={roles} placeholder="sdr, manager"
                   onChange={(e) => setRoles(e.target.value)} />
          </div>
        </div>
        {notice && <Notice kind={notice.kind} onClose={() => setNotice(null)}>{notice.text}</Notice>}
        <div className="acad-actions">
          <button type="submit" className="authx-btn authx-btn-primary acad-btn-auto" disabled={!file || busy} aria-busy={busy}>
            {busy ? <><span className="authx-spinner" aria-hidden="true" /> Uploading…</> : "Upload"}
          </button>
        </div>
      </form>

      <div className="acad-card">
        <h3 className="acad-h3">Documents <span className="acad-count">{docs.length}</span></h3>
        {docs.length === 0 ? (
          <p className="acad-empty">No documents yet. Add your handbook or a policy to start.</p>
        ) : (
          <div className="acad-table-wrap">
            <table className="acad-table">
              <thead><tr><th>Document</th><th>Visibility</th><th>Tags</th><th>Updated</th><th><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>
                {docs.map((d) => (
                  <tr key={d.id}>
                    <td><span className="acad-strong">{d.title}</span>{d.version > 1 && <span className="acad-muted"> · v{d.version}</span>}</td>
                    <td><span className={`acad-level is-${d.sensitivity}`}>{LEVELS[d.sensitivity]}</span></td>
                    <td className="acad-muted">{[...d.dept_tags, ...d.role_tags].join(", ") || "Everyone"}</td>
                    <td className="acad-muted">{when(d.updated_at)}</td>
                    <td className="acad-row-actions"><ConfirmButton label="Delete" confirmLabel="Confirm delete" onConfirm={() => remove(d)} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Learners ──────────────────────────────────────────────────────────────────
function Learners({ api }: { api: (path: string, init?: RequestInit) => Promise<Response> }) {
  const [list, setList] = useState<Learner[]>([]);
  const [email, setEmail] = useState("");
  const [dept, setDept] = useState("");
  const [role, setRole] = useState("");
  const [level, setLevel] = useState("1");
  const [csv, setCsv] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string; lines?: string[] } | null>(null);

  const load = useCallback(async () => {
    const r = await api("/api/academy/learners");
    if (r.ok) setList(await r.json());
  }, [api]);
  useEffect(() => { load(); }, [load]);

  async function addOne(e: FormEvent) {
    e.preventDefault();
    if (!email.trim() || busy) return;
    setBusy(true); setNotice(null);
    const existing = list.find((l) => l.email === email.trim().toLowerCase());
    const uid = existing?.uid ?? `email:${email.trim().toLowerCase()}`;
    const r = await api(`/api/academy/learners/${encodeURIComponent(uid)}`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: email.trim(), department: dept || null, role: role || null, clearance: Number(level) }),
    });
    setBusy(false);
    if (!r.ok) { setNotice({ kind: "error", text: await readError(r) }); return; }
    setNotice({ kind: "ok", text: `${email.trim()} saved. They're matched when they sign in with that email.` });
    setEmail(""); setDept(""); setRole(""); load();
  }

  async function importCsv() {
    if (!csv.trim() || busy) return;
    setBusy(true); setNotice(null);
    const r = await api("/api/academy/learners/import", { method: "POST", headers: { "Content-Type": "text/csv" }, body: csv });
    setBusy(false);
    if (!r.ok) { setNotice({ kind: "error", text: await readError(r) }); return; }
    const b: { created: number; updated: number; errors: { line: number; message: string }[] } = await r.json();
    setNotice({
      kind: b.errors.length ? "error" : "ok",
      text: `${b.created} added, ${b.updated} updated` + (b.errors.length ? `, ${b.errors.length} row${b.errors.length > 1 ? "s" : ""} skipped:` : "."),
      lines: b.errors.map((e) => `Line ${e.line}: ${e.message}`),
    });
    if (!b.errors.length) setCsv("");
    load();
  }

  async function remove(l: Learner) {
    const r = await api(`/api/academy/learners/${encodeURIComponent(l.uid)}`, { method: "DELETE" });
    if (r.ok) load(); else setNotice({ kind: "error", text: await readError(r) });
  }

  return (
    <div className="acad-section">
      <div className="acad-two">
        <form className="acad-card" onSubmit={addOne}>
          <h3 className="acad-h3">Add a learner</h3>
          <div className="authx-field">
            <label className="authx-label" htmlFor="ln-email">Work email</label>
            <input id="ln-email" type="email" className="authx-input" value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div className="acad-grid">
            <div className="authx-field">
              <label className="authx-label" htmlFor="ln-dept">Department</label>
              <input id="ln-dept" className="authx-input" value={dept} placeholder="sales" onChange={(e) => setDept(e.target.value)} />
            </div>
            <div className="authx-field">
              <label className="authx-label" htmlFor="ln-role">Role</label>
              <input id="ln-role" className="authx-input" value={role} placeholder="sdr" onChange={(e) => setRole(e.target.value)} />
            </div>
          </div>
          <div className="authx-field">
            <label className="authx-label" htmlFor="ln-level">Clearance</label>
            <select id="ln-level" className="authx-input authx-select" value={level} onChange={(e) => setLevel(e.target.value)}>
              <option value="0">Public</option><option value="1">Internal</option><option value="2">Restricted</option>
            </select>
          </div>
          <div className="acad-actions">
            <button type="submit" className="authx-btn authx-btn-primary acad-btn-auto" disabled={!email.trim() || busy}>Save learner</button>
          </div>
        </form>

        <div className="acad-card">
          <h3 className="acad-h3">Import from CSV</h3>
          <p className="acad-help">Header row required. Only <code>email</code> is mandatory; clearance is public, internal or restricted.</p>
          <div className="authx-field">
            <label className="authx-label" htmlFor="ln-csv">CSV</label>
            <textarea id="ln-csv" className="authx-input acad-textarea" rows={6} value={csv} onChange={(e) => setCsv(e.target.value)}
                      placeholder={"email,department,role,clearance\npriya@company.com,sales,sdr,internal"} />
          </div>
          <div className="acad-actions">
            <label className="authx-btn authx-btn-secondary acad-file-btn">
              Choose file
              <input type="file" accept=".csv,text/csv" className="sr-only"
                     onChange={async (e) => { const f = e.target.files?.[0]; if (f) setCsv(await f.text()); }} />
            </label>
            <button type="button" className="authx-btn authx-btn-primary acad-btn-auto" onClick={importCsv} disabled={!csv.trim() || busy}>Import</button>
          </div>
        </div>
      </div>

      {notice && (
        <Notice kind={notice.kind} onClose={() => setNotice(null)}>
          {notice.text}
          {notice.lines && notice.lines.length > 0 && <ul className="acad-errlist">{notice.lines.slice(0, 8).map((l) => <li key={l}>{l}</li>)}</ul>}
        </Notice>
      )}

      <div className="acad-card">
        <h3 className="acad-h3">Learners <span className="acad-count">{list.length}</span></h3>
        {list.length === 0 ? <p className="acad-empty">No learners yet. People without a profile only see public documents.</p> : (
          <div className="acad-table-wrap">
            <table className="acad-table">
              <thead><tr><th>Email</th><th>Department</th><th>Role</th><th>Clearance</th><th><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>
                {list.map((l) => (
                  <tr key={l.uid}>
                    <td><span className="acad-strong">{l.email}</span>{l.pending && <span className="acad-pill">Not signed in yet</span>}</td>
                    <td className="acad-muted">{l.department ?? "Any"}</td>
                    <td className="acad-muted">{l.role ?? "Any"}</td>
                    <td><span className={`acad-level is-${l.clearance}`}>{LEVELS[l.clearance]}</span></td>
                    <td className="acad-row-actions"><ConfirmButton label="Remove" confirmLabel="Confirm remove" onConfirm={() => remove(l)} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Paths ─────────────────────────────────────────────────────────────────────
function ItemEditor({ item, api, onSaved, onDeleted }: {
  item: Item; api: (path: string, init?: RequestInit) => Promise<Response>;
  onSaved: (i: Item) => void; onDeleted: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [stem, setStem] = useState(item.stem);
  const [type, setType] = useState<ItemType>(item.type);
  const [options, setOptions] = useState<string[]>(item.options ?? ["", "", "", ""]);
  const [answer, setAnswer] = useState<number | boolean>(item.answer ?? 0);
  const [explanation, setExplanation] = useState(item.explanation ?? "");
  const [rubric, setRubric] = useState(item.rubric ?? "");
  const [error, setError] = useState("");

  async function save() {
    setError("");
    const body = isFreeText(type)
      ? { stem, type, rubric, explanation }
      : { stem, type, options: type === "mcq" ? options : null,
          answer: type === "mcq" ? Number(answer) || 0 : Boolean(answer), explanation };
    const r = await api(`/api/academy/items/${item.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) { setError(await readError(r)); return; }
    onSaved(await r.json()); setEditing(false);
  }

  async function del() {
    const r = await api(`/api/academy/items/${item.id}`, { method: "DELETE" });
    if (r.ok) onDeleted(); else setError(await readError(r));
  }

  if (!editing) {
    return (
      <li className={`acad-item${item.status === "stale" ? " is-stale" : ""}`}>
        <div className="acad-item-head">
          <span className="acad-item-type">{ITEM_LABELS[item.type] ?? item.type}</span>
          {item.status === "stale" && <StatusBadge status="stale" />}
          <span className="acad-spacer" />
          <button type="button" className="authx-link authx-link-sm" onClick={() => setEditing(true)}>Edit</button>
          <ConfirmButton label="Delete" confirmLabel="Confirm delete" onConfirm={del} />
        </div>
        <p className="acad-stem">{item.stem}</p>
        {item.type === "mcq" && item.options ? (
          <ol className="acad-options">
            {item.options.map((o, i) => <li key={i} className={i === item.answer ? "is-correct" : ""}>{o}{i === item.answer && <span className="sr-only"> (correct)</span>}</li>)}
          </ol>
        ) : isFreeText(item.type)
          ? <p className="acad-muted">Graded against: <span className="acad-strong">{item.rubric || "(no rubric yet)"}</span></p>
          : <p className="acad-muted">Answer: <span className="acad-strong">{item.answer ? "True" : "False"}</span></p>}
        {item.explanation && <p className="acad-muted acad-small">{item.explanation}</p>}
        {error && <p className="authx-error">{error}</p>}
      </li>
    );
  }

  return (
    <li className="acad-item is-editing">
      <div className="acad-grid">
        <div className="authx-field acad-span-2">
          <label className="authx-label" htmlFor={`stem-${item.id}`}>Question</label>
          <textarea id={`stem-${item.id}`} className="authx-input acad-textarea" rows={2} value={stem} onChange={(e) => setStem(e.target.value)} />
        </div>
        <div className="authx-field">
          <label className="authx-label" htmlFor={`type-${item.id}`}>Type</label>
          <select id={`type-${item.id}`} className="authx-input authx-select" value={type}
                  onChange={(e) => { const t = e.target.value as ItemType; setType(t); setAnswer(t === "mcq" ? 0 : true); }}>
            {(Object.keys(ITEM_LABELS) as ItemType[]).map((t) => <option key={t} value={t}>{ITEM_LABELS[t]}</option>)}
          </select>
        </div>
      </div>
      {isFreeText(type) ? (
        <div className="authx-field">
          <label className="authx-label" htmlFor={`rubric-${item.id}`}>Rubric <span className="authx-optional">(the points a correct answer must cover)</span></label>
          <textarea id={`rubric-${item.id}`} className="authx-input acad-textarea" rows={3} value={rubric} onChange={(e) => setRubric(e.target.value)} />
        </div>
      ) : type === "mcq" ? (
        <fieldset className="authx-fieldset">
          <legend className="authx-label">Options (select the correct one)</legend>
          {options.map((o, i) => (
            <div key={i} className="acad-option-row">
              <input type="radio" name={`ans-${item.id}`} checked={Number(answer) === i} onChange={() => setAnswer(i)} aria-label={`Option ${i + 1} is correct`} />
              <input className="authx-input" value={o} aria-label={`Option ${i + 1}`}
                     onChange={(e) => setOptions(options.map((x, j) => (j === i ? e.target.value : x)))} />
            </div>
          ))}
        </fieldset>
      ) : (
        <fieldset className="authx-fieldset">
          <legend className="authx-label">Correct answer</legend>
          <div className="acad-inline">
            <label className="authx-consent"><input type="radio" checked={answer === true} onChange={() => setAnswer(true)} /> True</label>
            <label className="authx-consent"><input type="radio" checked={answer === false} onChange={() => setAnswer(false)} /> False</label>
          </div>
        </fieldset>
      )}
      <div className="authx-field">
        <label className="authx-label" htmlFor={`exp-${item.id}`}>Explanation <span className="authx-optional">(shown after answering)</span></label>
        <input id={`exp-${item.id}`} className="authx-input" value={explanation} onChange={(e) => setExplanation(e.target.value)} />
      </div>
      {error && <p className="authx-error">{error}</p>}
      <div className="acad-actions">
        <button type="button" className="authx-btn authx-btn-secondary" onClick={() => setEditing(false)}>Cancel</button>
        <button type="button" className="authx-btn authx-btn-primary acad-btn-auto" onClick={save}>Save question</button>
      </div>
    </li>
  );
}

function ModuleEditor({ mod, docTitle, api, onChange }: {
  mod: Module; docTitle: (id: string) => string;
  api: (path: string, init?: RequestInit) => Promise<Response>; onChange: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(mod.title);
  const [lesson, setLesson] = useState(mod.lesson_md);
  const [error, setError] = useState("");

  async function save() {
    setError("");
    const r = await api(`/api/academy/modules/${mod.id}`, { method: "PUT", headers: { "Content-Type": "application/json" },
                                                             body: JSON.stringify({ title, lesson_md: lesson }) });
    if (!r.ok) { setError(await readError(r)); return; }
    setEditing(false); onChange();
  }

  return (
    <section className={`acad-module${mod.status === "stale" ? " is-stale" : ""}`}>
      <header className="acad-module-head">
        <span className="acad-module-num">{mod.position}</span>
        <h4 className="acad-h4">{mod.title}</h4>
        {mod.status === "stale" && <StatusBadge status="stale" />}
        <span className="acad-spacer" />
        {!editing && <button type="button" className="authx-link authx-link-sm" onClick={() => setEditing(true)}>Edit lesson</button>}
      </header>
      {mod.status === "stale" && <p className="acad-help">A source document changed. Check the lesson, then save it to mark it reviewed.</p>}
      {editing ? (
        <div className="acad-stack">
          <div className="authx-field">
            <label className="authx-label" htmlFor={`mt-${mod.id}`}>Title</label>
            <input id={`mt-${mod.id}`} className="authx-input" value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div className="authx-field">
            <label className="authx-label" htmlFor={`ml-${mod.id}`}>Lesson (Markdown)</label>
            <textarea id={`ml-${mod.id}`} className="authx-input acad-textarea" rows={10} value={lesson} onChange={(e) => setLesson(e.target.value)} />
          </div>
          {error && <p className="authx-error">{error}</p>}
          <div className="acad-actions">
            <button type="button" className="authx-btn authx-btn-secondary" onClick={() => { setEditing(false); setTitle(mod.title); setLesson(mod.lesson_md); }}>Cancel</button>
            <button type="button" className="authx-btn authx-btn-primary acad-btn-auto" onClick={save}>Save lesson</button>
          </div>
        </div>
      ) : <Markdown text={mod.lesson_md} />}
      {mod.source_doc_ids.length > 0 && (
        <p className="acad-sources">Sources: {mod.source_doc_ids.map(docTitle).join(" · ")}</p>
      )}
      <h5 className="acad-h5">Questions <span className="acad-count">{mod.items.length}</span></h5>
      {mod.items.length === 0 ? <p className="acad-empty">No questions were generated for this lesson.</p> : (
        <ul className="acad-items">
          {mod.items.map((it) => (
            <ItemEditor key={it.id} item={it} api={api} onSaved={onChange} onDeleted={onChange} />
          ))}
        </ul>
      )}
    </section>
  );
}

function Paths({ api, docs }: { api: (path: string, init?: RequestInit) => Promise<Response>; docs: Doc[] }) {
  const [paths, setPaths] = useState<PathT[]>([]);
  const [open, setOpen] = useState<PathT | null>(null);
  const [title, setTitle] = useState("");
  const [dept, setDept] = useState("");
  const [role, setRole] = useState("");
  const [level, setLevel] = useState("1");
  const [count, setCount] = useState("4");
  const [qpm, setQpm] = useState("4");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  const docTitle = useMemo(() => {
    const m = new Map(docs.map((d) => [d.id, d.title]));
    return (id: string) => m.get(id) ?? "Removed document";
  }, [docs]);

  const load = useCallback(async () => {
    const r = await api("/api/academy/paths");
    if (r.ok) setPaths(await r.json());
  }, [api]);
  useEffect(() => { load(); }, [load]);

  const openPath = useCallback(async (id: string) => {
    const r = await api(`/api/academy/paths/${id}`);
    if (r.ok) setOpen(await r.json());
  }, [api]);

  async function create(e: FormEvent) {
    e.preventDefault();
    if (title.trim().length < 2 || busy) return;
    setBusy(true); setNotice(null);
    try {
      const r = await api("/api/academy/paths", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: title.trim(), department: dept || null, role: role || null,
                               clearance: Number(level), module_count: Number(count), questions_per_module: Number(qpm) }),
      });
      if (!r.ok) { setNotice({ kind: "error", text: await readError(r) }); return; }
      const p: PathT = await r.json();
      setNotice(p.status === "failed"
        ? { kind: "error", text: p.error ?? "Generation failed." }
        : { kind: "ok", text: `Draft ready: ${p.module_count} lesson${p.module_count === 1 ? "" : "s"}. Review it, then publish.` });
      setTitle(""); load();
      if (p.status !== "failed") setOpen(p);
    } catch {
      setNotice({ kind: "error", text: "The request timed out or the network dropped. Refresh the list in a minute." });
    } finally { setBusy(false); }
  }

  async function publish(p: PathT) {
    const r = await api(`/api/academy/paths/${p.id}/publish`, { method: "POST" });
    if (!r.ok) { setNotice({ kind: "error", text: await readError(r) }); return; }
    setOpen(await r.json()); load();
    setNotice({ kind: "ok", text: `${p.title} is published.` });
  }

  async function remove(p: PathT) {
    const r = await api(`/api/academy/paths/${p.id}`, { method: "DELETE" });
    if (!r.ok) { setNotice({ kind: "error", text: await readError(r) }); return; }
    if (open?.id === p.id) setOpen(null);
    load();
  }

  const audience = (p: PathT) => [p.rules.department, p.rules.role].filter(Boolean).join(" · ") || "Everyone";

  if (open) {
    const staleCount = (open.modules ?? []).filter((m) => m.status === "stale").length;
    return (
      <div className="acad-section">
        <button type="button" className="authx-link" onClick={() => { setOpen(null); load(); }}>← All paths</button>
        <div className="acad-card acad-path-head">
          <div className="acad-path-title">
            <h3 className="acad-h3">{open.title}</h3>
            <StatusBadge status={open.status} />
          </div>
          <p className="acad-muted">
            For {audience(open)} · {LEVELS[open.rules.clearance ?? 1]} clearance · {open.modules?.length ?? 0} lessons
          </p>
          {notice && <Notice kind={notice.kind} onClose={() => setNotice(null)}>{notice.text}</Notice>}
          <div className="acad-actions">
            <ConfirmButton label="Delete path" confirmLabel="Confirm delete" onConfirm={() => remove(open)} />
            <span className="acad-spacer" />
            <button type="button" className="authx-btn authx-btn-primary acad-btn-auto"
                    disabled={open.status === "published" || staleCount > 0 || !(open.modules?.length)}
                    onClick={() => publish(open)}>
              {open.status === "published" ? "Published" : staleCount ? `Review ${staleCount} lesson${staleCount > 1 ? "s" : ""} first` : "Publish"}
            </button>
          </div>
        </div>
        {(open.modules ?? []).map((m) => (
          <ModuleEditor key={m.id} mod={m} docTitle={docTitle} api={api} onChange={() => openPath(open.id)} />
        ))}
      </div>
    );
  }

  return (
    <div className="acad-section">
      <form className="acad-card" onSubmit={create}>
        <h3 className="acad-h3">Generate a learning path</h3>
        <p className="acad-help">Lessons and questions are written only from documents this audience is allowed to see, with sources attached. Takes about a minute.</p>
        <div className="acad-grid">
          <div className="authx-field acad-span-2">
            <label className="authx-label" htmlFor="p-title">Path name</label>
            <input id="p-title" className="authx-input" value={title} placeholder="Sales: first two weeks" onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div className="authx-field">
            <label className="authx-label" htmlFor="p-dept">Department <span className="authx-optional">(optional)</span></label>
            <input id="p-dept" className="authx-input" value={dept} placeholder="sales" onChange={(e) => setDept(e.target.value)} />
          </div>
          <div className="authx-field">
            <label className="authx-label" htmlFor="p-role">Role <span className="authx-optional">(optional)</span></label>
            <input id="p-role" className="authx-input" value={role} placeholder="sdr" onChange={(e) => setRole(e.target.value)} />
          </div>
          <div className="authx-field">
            <label className="authx-label" htmlFor="p-level">Audience clearance</label>
            <select id="p-level" className="authx-input authx-select" value={level} onChange={(e) => setLevel(e.target.value)}>
              <option value="0">Public</option><option value="1">Internal</option><option value="2">Restricted</option>
            </select>
          </div>
          <div className="authx-field">
            <label className="authx-label" htmlFor="p-count">Lessons</label>
            <select id="p-count" className="authx-input authx-select" value={count} onChange={(e) => setCount(e.target.value)}>
              {[2, 3, 4, 5, 6, 8].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </div>
          <div className="authx-field">
            <label className="authx-label" htmlFor="p-qpm">Questions per lesson</label>
            <select id="p-qpm" className="authx-input authx-select" value={qpm} onChange={(e) => setQpm(e.target.value)}>
              {[3, 4, 5, 6].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </div>
        </div>
        {notice && <Notice kind={notice.kind} onClose={() => setNotice(null)}>{notice.text}</Notice>}
        <div className="acad-actions">
          <button type="submit" className="authx-btn authx-btn-primary acad-btn-auto" disabled={title.trim().length < 2 || busy || docs.length === 0} aria-busy={busy}>
            {busy ? <><span className="authx-spinner" aria-hidden="true" /> Generating… about a minute</> : "Generate draft"}
          </button>
          {docs.length === 0 && <span className="acad-muted acad-small">Add a document first.</span>}
        </div>
      </form>

      <div className="acad-card">
        <h3 className="acad-h3">Paths <span className="acad-count">{paths.length}</span></h3>
        {paths.length === 0 ? <p className="acad-empty">No paths yet.</p> : (
          <ul className="acad-path-list">
            {paths.map((p) => (
              <li key={p.id}>
                <button type="button" className="acad-path-row" onClick={() => openPath(p.id)}>
                  <span className="acad-strong">{p.title}</span>
                  <span className="acad-muted">{audience(p)} · {p.module_count} lessons · {when(p.updated_at)}</span>
                  <StatusBadge status={p.status} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// ── Shell ─────────────────────────────────────────────────────────────────────
export function AcademyPanel({ apiUrl, authHeaders }: Props) {
  const [section, setSection] = useState<Section>("kb");
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [docs, setDocs] = useState<Doc[]>([]);

  // authHeaders is a fresh function on every App render; read it through a ref so
  // `api` stays stable and the load effects don't refire in a loop.
  const headersRef = useRef(authHeaders);
  headersRef.current = authHeaders;
  const api = useCallback((path: string, init: RequestInit = {}) =>
    fetch(`${apiUrl}${path}`, { ...init, headers: { ...headersRef.current(), ...(init.headers ?? {}) } }),
  [apiUrl]);

  const loadDocs = useCallback(async () => {
    const r = await api("/api/academy/documents");
    if (r.ok) setDocs(await r.json());
  }, [api]);

  useEffect(() => {
    (async () => {
      try {
        const r = await api("/api/academy/me");
        const me = r.ok ? await r.json() : null;
        setEnabled(!!me?.enabled);
        setIsAdmin(!!me?.is_admin);
        if (me?.enabled && me?.is_admin) loadDocs();
      } catch { setEnabled(false); }
    })();
  }, [api, loadDocs]);

  if (enabled === null) return <div className="acad"><p className="acad-muted">Loading Academy…</p></div>;
  if (!enabled) {
    return (
      <div className="acad">
        <div className="acad-card acad-off">
          <h2 className="acad-h2">Academy isn't switched on for this workspace</h2>
          <p className="acad-muted">Academy turns your documents into onboarding paths with tests. Ask your RAGaaS contact to enable it.</p>
        </div>
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <div className="acad">
        <header className="acad-header"><h2 className="acad-h2">Your onboarding</h2></header>
        <LearnerView api={api} />
      </div>
    );
  }

  const tabs: { id: Section; label: string }[] = [
    { id: "kb", label: "Knowledge base" }, { id: "learners", label: "Learners" }, { id: "paths", label: "Learning paths" },
    { id: "learn", label: "Learner preview" },
  ];
  return (
    <div className="acad">
      <header className="acad-header">
        <h2 className="acad-h2">Academy</h2>
        <div className="acad-tabs" role="tablist" aria-label="Academy sections">
          {tabs.map((t) => (
            <button key={t.id} type="button" role="tab" aria-selected={section === t.id}
                    className={`acad-tab${section === t.id ? " is-active" : ""}`} onClick={() => setSection(t.id)}>
              {t.label}
            </button>
          ))}
        </div>
      </header>
      {section === "kb" && <KnowledgeBase api={api} docs={docs} reload={loadDocs} />}
      {section === "learners" && <Learners api={api} />}
      {section === "paths" && <Paths api={api} docs={docs} />}
      {section === "learn" && <LearnerView api={api} />}
    </div>
  );
}
