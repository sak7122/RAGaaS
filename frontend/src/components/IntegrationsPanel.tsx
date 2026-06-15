import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Key, Slack, Plus, Trash2, Copy, Check, Code, ChevronDown, RefreshCcw, MessageSquare } from "lucide-react";

interface Props {
  apiUrl: string;
  authHeaders: () => Record<string, string>;
  appBaseUrl: string;
}

type WidgetKey = { key_id: string; label: string; created_at: string };
type SlackConn = { team_id: string; team_name: string; connected_at: string };

function CopySnippet({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  function doCopy() {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    });
  }
  return (
    <div className="snippet-wrap">
      <pre className="snippet-code">{text}</pre>
      <button type="button" className="snippet-copy" onClick={doCopy} title="Copy">
        {copied ? <Check size={12} color="var(--green)" /> : <Copy size={12} />}
      </button>
    </div>
  );
}

function WidgetSection({ apiUrl, authHeaders }: Pick<Props, "apiUrl" | "authHeaders">) {
  const [keys, setKeys] = useState<WidgetKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newLabel, setNewLabel] = useState("My website");
  const [newKey, setNewKey] = useState<{ key_id: string; key: string; label: string } | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [snippetFor, setSnippetFor] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      const r = await fetch(`${apiUrl}/api/tenant/widget-keys`, { headers: authHeaders() });
      if (r.ok) setKeys(await r.json());
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  async function create() {
    setCreating(true);
    try {
      const r = await fetch(`${apiUrl}/api/tenant/widget-keys`, {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ label: newLabel }),
      });
      if (r.ok) {
        const body = await r.json();
        setNewKey(body);
        setShowForm(false);
        setNewLabel("My website");
        load();
      }
    } finally {
      setCreating(false);
    }
  }

  async function revoke(key_id: string) {
    if (!confirm("Revoke this API key? Embeds using it will stop working.")) return;
    await fetch(`${apiUrl}/api/tenant/widget-keys/${key_id}`, {
      method: "DELETE", headers: authHeaders(),
    });
    setKeys((prev) => prev.filter((k) => k.key_id !== key_id));
  }

  const embedSnippet = (key: string) =>
    `<script src="${apiUrl.replace('/api', '')}/widget.js"\n  data-widget-key="${key}"\n  data-api-url="${apiUrl}"\n  data-title="Ask our docs"\n></script>`;

  return (
    <section className="integrations-section">
      <h3 className="integrations-section-title"><Key size={14} /> Widget API Keys</h3>
      <p className="integrations-hint">Generate a key to embed RAGaaS on any website. Viewers can chat without signing in.</p>

      {/* New key revealed once */}
      <AnimatePresence>
        {newKey && (
          <motion.div className="new-key-banner" initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
            <strong>Key created — save it now, it won't be shown again:</strong>
            <CopySnippet text={newKey.key} />
            <p className="integrations-hint">Embed snippet:</p>
            <CopySnippet text={embedSnippet(newKey.key)} />
            <button type="button" className="btn-ghost" onClick={() => setNewKey(null)}>Dismiss</button>
          </motion.div>
        )}
      </AnimatePresence>

      {loading ? (
        <p className="integrations-empty">Loading…</p>
      ) : (
        <>
          {keys.length === 0 && !showForm && (
            <p className="integrations-empty">No widget keys yet.</p>
          )}
          <div className="key-list">
            {keys.map((k) => (
              <div key={k.key_id} className="key-row">
                <div className="key-row-info">
                  <span className="key-label">{k.label}</span>
                  <span className="key-meta">{k.key_id.slice(0, 8)}… · {new Date(k.created_at).toLocaleDateString()}</span>
                </div>
                <div className="key-row-actions">
                  <button
                    type="button" className="btn-ghost btn-xs"
                    onClick={() => setSnippetFor(snippetFor === k.key_id ? null : k.key_id)}
                  >
                    <Code size={11} /> Embed
                    <ChevronDown size={10} className={snippetFor === k.key_id ? "open" : ""} />
                  </button>
                  <button type="button" className="btn-danger-xs" onClick={() => revoke(k.key_id)} title="Revoke">
                    <Trash2 size={11} />
                  </button>
                </div>
              </div>
            ))}
            {/* Snippet drawer */}
            <AnimatePresence>
              {snippetFor && (
                <motion.div
                  className="snippet-drawer"
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.2 }}
                >
                  <p className="integrations-hint">Paste before &lt;/body&gt;. Replace key with your actual key.</p>
                  <CopySnippet text={embedSnippet("<your-key-here>")} />
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {showForm ? (
            <div className="key-create-form">
              <input
                type="text"
                className="inp-sm"
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                placeholder="Label (e.g. Company website)"
                maxLength={80}
              />
              <button type="button" className="btn-primary-sm" onClick={create} disabled={creating || !newLabel.trim()}>
                {creating ? "Creating…" : "Create"}
              </button>
              <button type="button" className="btn-ghost" onClick={() => setShowForm(false)}>Cancel</button>
            </div>
          ) : (
            <button type="button" className="btn-ghost" onClick={() => setShowForm(true)}>
              <Plus size={13} /> New API key
            </button>
          )}
        </>
      )}
    </section>
  );
}

function SlackSection({ apiUrl, authHeaders }: Pick<Props, "apiUrl" | "authHeaders">) {
  const [conns, setConns] = useState<SlackConn[]>([]);
  const [loading, setLoading] = useState(true);
  const [teamId, setTeamId] = useState("");
  const [teamName, setTeamName] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [instructions, setInstructions] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const r = await fetch(`${apiUrl}/api/integrations/slack/connections`, { headers: authHeaders() });
      if (r.ok) setConns(await r.json());
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  function buildInstructions(id: string): string {
    return [
      `1. In your Slack app settings → Slash Commands → Create New Command:`,
      `   Command:      /ask`,
      `   Request URL:  ${apiUrl}/api/integrations/slack/command`,
      `   Description:  Ask your company knowledge base`,
      `   Usage hint:   [your question]`,
      ``,
      `2. Copy the Signing Secret from your Slack app:`,
      `   Basic Information → App Credentials → Signing Secret`,
      ``,
      `3. Set it on Cloud Run:`,
      `   gcloud run services update ragaas-backend --set-env-vars SLACK_SIGNING_SECRET=<secret>`,
      ``,
      `Connected team ID: ${id}`,
    ].join("\n");
  }

  async function connect() {
    setConnecting(true);
    try {
      const r = await fetch(`${apiUrl}/api/integrations/slack/connect`, {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ team_id: teamId.trim(), team_name: teamName.trim() }),
      });
      if (r.ok) {
        setInstructions(buildInstructions(teamId.trim()));
        setTeamId("");
        setTeamName("");
        setShowForm(false);
        load();
      }
    } finally {
      setConnecting(false);
    }
  }

  async function disconnect(team_id: string) {
    if (!confirm("Disconnect this Slack workspace? /ask will stop working there.")) return;
    await fetch(`${apiUrl}/api/integrations/slack/connections/${team_id}`, {
      method: "DELETE", headers: authHeaders(),
    });
    setConns((prev) => prev.filter((c) => c.team_id !== team_id));
  }

  return (
    <section className="integrations-section">
      <h3 className="integrations-section-title"><Slack size={14} /> Slack Bot</h3>
      <p className="integrations-hint">Let your team use <code>/ask</code> in Slack to query your knowledge base.</p>

      <AnimatePresence>
        {instructions !== null && (
          <motion.div className="new-key-banner" initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
            <strong>Workspace connected. Setup steps:</strong>
            <pre className="snippet-code" style={{ whiteSpace: "pre-wrap", overflowX: "auto" }}>{instructions}</pre>
            <button type="button" className="btn-ghost" onClick={() => setInstructions(null)}>Dismiss</button>
          </motion.div>
        )}
      </AnimatePresence>

      {loading ? (
        <p className="integrations-empty">Loading…</p>
      ) : (
        <>
          {conns.length === 0 && !showForm && (
            <p className="integrations-empty">No Slack workspaces connected.</p>
          )}
          <div className="key-list">
            {conns.map((c) => (
              <div key={c.team_id} className="key-row">
                <div className="key-row-info">
                  <span className="key-label">{c.team_name}</span>
                  <span className="key-meta">{c.team_id} · connected {new Date(c.connected_at).toLocaleDateString()}</span>
                </div>
                <button type="button" className="btn-danger-xs" onClick={() => disconnect(c.team_id)} title="Disconnect">
                  <Trash2 size={11} />
                </button>
              </div>
            ))}
          </div>

          {showForm ? (
            <div className="key-create-form">
              <input className="inp-sm" value={teamId} onChange={(e) => setTeamId(e.target.value)} placeholder="Slack Team ID (e.g. T04AB…)" maxLength={32} />
              <input className="inp-sm" value={teamName} onChange={(e) => setTeamName(e.target.value)} placeholder="Workspace name (display only)" maxLength={128} />
              <button type="button" className="btn-primary-sm" onClick={connect} disabled={connecting || !teamId.trim() || !teamName.trim()}>
                {connecting ? "Connecting…" : "Connect"}
              </button>
              <button type="button" className="btn-ghost" onClick={() => setShowForm(false)}>Cancel</button>
              <p className="integrations-hint">Find your Team ID in Slack: Administration → Workspace Settings → scroll to bottom.</p>
            </div>
          ) : (
            <button type="button" className="btn-ghost" onClick={() => setShowForm(true)}>
              <Plus size={13} /> Connect workspace
            </button>
          )}
        </>
      )}
    </section>
  );
}

type SlackQuery = {
  question: string;
  slack_user: string;
  score: number;
  answer: string;
  ts: string;
};

function SlackQueryLog({ apiUrl, authHeaders }: Pick<Props, "apiUrl" | "authHeaders">) {
  const [queries, setQueries] = useState<SlackQuery[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<number | null>(null);

  async function load() {
    setLoading(true);
    try {
      const r = await fetch(`${apiUrl}/api/slack/queries`, { headers: authHeaders() });
      if (r.ok) setQueries(await r.json());
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  function fmtTime(ts: string) {
    try { return new Date(ts).toLocaleString(); } catch { return ts; }
  }
  function confCls(s: number) { return s >= 0.5 ? "good" : s >= 0.3 ? "warn" : "bad"; }

  return (
    <section className="integrations-section">
      <h3 className="integrations-section-title">
        <MessageSquare size={14} /> Slack Questions
        <button type="button" className="btn-ghost btn-xs" style={{ marginLeft: "auto" }} onClick={load}>
          <RefreshCcw size={11} /> Refresh
        </button>
      </h3>
      <p className="integrations-hint">All questions asked via <code>/ask</code> in Slack — visible to admins only.</p>

      {loading ? (
        <p className="integrations-empty">Loading…</p>
      ) : queries.length === 0 ? (
        <p className="integrations-empty">No Slack questions yet. Try <code>/ask</code> in a Slack channel.</p>
      ) : (
        <div className="key-list">
          {queries.map((q, i) => (
            <motion.div
              key={i}
              className="slack-query-card"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.03 }}
            >
              <div className="slack-query-header" onClick={() => setExpanded(expanded === i ? null : i)}>
                <span className="slack-query-user">@{q.slack_user}</span>
                <span className="slack-query-q">{q.question}</span>
                <span className={`faq-confidence ${confCls(q.score)}`}>{Math.round(q.score * 100)}%</span>
                <span className="slack-query-time">{fmtTime(q.ts)}</span>
                <ChevronDown size={12} className={`faq-chevron${expanded === i ? " open" : ""}`} />
              </div>
              <AnimatePresence>
                {expanded === i && q.answer && (
                  <motion.div
                    className="slack-query-answer"
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: "auto", opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.18 }}
                  >
                    {q.answer}
                  </motion.div>
                )}
              </AnimatePresence>
            </motion.div>
          ))}
        </div>
      )}
    </section>
  );
}

export function IntegrationsPanel({ apiUrl, authHeaders }: Props) {
  return (
    <div className="insights-wrap">
      <div className="insights-head">
        <div>
          <h2 className="insights-title">Integrations</h2>
          <p className="insights-sub">Embed RAGaaS anywhere — your website, Slack, or any tool.</p>
        </div>
      </div>
      <SlackQueryLog apiUrl={apiUrl} authHeaders={authHeaders} />
      <SlackSection apiUrl={apiUrl} authHeaders={authHeaders} />
      <WidgetSection apiUrl={apiUrl} authHeaders={authHeaders} />
    </div>
  );
}
