// WhatsApp channel (team members only). Everyone can link their own phone with a
// one-time code; admins connect the workspace's WhatsApp Business number.
import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Check, CircleAlert, ExternalLink, Phone, Plus, Smartphone, Trash2 } from "lucide-react";

type Api = (path: string, init?: RequestInit) => Promise<Response>;
type MyLink = { available: boolean; send_to: string | null; linked: boolean; phone: string | null; linked_at: string | null };
type Code = { code: string; message: string; send_to: string; expires_at: string };
type Numbers = {
  numbers: { phone_number_id: string; display_phone: string; connected_at: string }[];
  webhook_url: string;
  configured: { access_token: boolean; app_secret: boolean; verify_token: boolean };
};

const EASE = [0.23, 1, 0.32, 1] as const;
const digits = (s: string) => s.replace(/\D/g, "");

async function detail(r: Response): Promise<string> {
  try { const b = await r.json(); return typeof b.detail === "string" ? b.detail : `Request failed (${r.status})`; }
  catch { return `Request failed (${r.status})`; }
}

function MyPhone({ api }: { api: Api }) {
  const [me, setMe] = useState<MyLink | null>(null);
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState<Code | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [left, setLeft] = useState(0);

  async function load() {
    const r = await api("/api/integrations/whatsapp/link");
    if (r.ok) {
      const next: MyLink = await r.json();
      setMe(next);
      if (next.linked) setCode(null);
    }
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  // While a code is showing: count down, and check every few seconds whether it was used.
  useEffect(() => {
    if (!code) return;
    const tick = () => setLeft(Math.max(0, Math.round((new Date(code.expires_at).getTime() - Date.now()) / 1000)));
    tick();
    const t = setInterval(tick, 1000);
    const p = setInterval(load, 4000);
    return () => { clearInterval(t); clearInterval(p); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

  async function start() {
    setBusy(true); setError("");
    try {
      const r = await api("/api/integrations/whatsapp/link", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phone }),
      });
      if (!r.ok) { setError(await detail(r)); return; }
      setCode(await r.json());
    } finally { setBusy(false); }
  }

  async function unlink() {
    if (!confirm("Unlink your phone? You'll stop getting answers on WhatsApp.")) return;
    await api("/api/integrations/whatsapp/link", { method: "DELETE" });
    load();
  }

  if (!me) return null;
  if (!me.available) {
    return <p className="integrations-empty">WhatsApp isn't connected for this workspace yet. An admin can connect it below.</p>;
  }
  if (me.linked) {
    return (
      <motion.div className="wa-linked" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0, transition: { ease: EASE } }}>
        <span className="wa-ok"><Check size={14} /></span>
        <div className="key-row-info">
          <span className="key-label">Your phone {me.phone} is linked</span>
          <span className="key-meta">Message {me.send_to} on WhatsApp with any question.</span>
        </div>
        <button type="button" className="btn-ghost btn-xs" onClick={unlink}>Unlink</button>
      </motion.div>
    );
  }
  const mm = String(Math.floor(left / 60)).padStart(1, "0");
  const ss = String(left % 60).padStart(2, "0");
  return (
    <div className="wa-link">
      <AnimatePresence mode="wait" initial={false}>
        {!code ? (
          <motion.div key="form" className="key-create-form" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: 0.12 } }}>
            <input className="inp-sm" value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel"
                   placeholder="Your WhatsApp number, e.g. +44 7700 900123" maxLength={32} aria-label="Your WhatsApp number" />
            <button type="button" className="btn-primary-sm" onClick={start} disabled={busy || digits(phone).length < 8}>
              {busy ? "Getting a code…" : "Link my phone"}
            </button>
          </motion.div>
        ) : (
          <motion.div key="code" className="wa-code-card" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0, transition: { duration: 0.3, ease: EASE } }}>
            <p className="integrations-hint">From that phone, send this message to <strong>{code.send_to}</strong> on WhatsApp:</p>
            <div className="wa-code" aria-label={`Message: ${code.message}`}>{code.message}</div>
            <div className="wa-code-actions">
              <a className="btn-primary-sm wa-open" target="_blank" rel="noreferrer"
                 href={`https://wa.me/${digits(code.send_to)}?text=${encodeURIComponent(code.message)}`}>
                <ExternalLink size={12} /> Open WhatsApp
              </a>
              <span className="key-meta">{left > 0 ? `Expires in ${mm}:${ss} · waiting for your message…` : "Code expired."}</span>
              <button type="button" className="btn-ghost btn-xs" onClick={() => setCode(null)}>{left > 0 ? "Cancel" : "Get a new code"}</button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      {error && <p className="wa-error"><CircleAlert size={12} /> {error}</p>}
    </div>
  );
}

function AdminNumbers({ api }: { api: Api }) {
  const [data, setData] = useState<Numbers | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [pnid, setPnid] = useState("");
  const [display, setDisplay] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function load() {
    const r = await api("/api/integrations/whatsapp/connections");
    if (r.status === 403) { setForbidden(true); return; }
    if (r.ok) setData(await r.json());
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  async function connect() {
    setBusy(true); setError("");
    try {
      const r = await api("/api/integrations/whatsapp/connect", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone_number_id: pnid.trim(), display_phone: display.trim() }),
      });
      if (!r.ok) { setError(await detail(r)); return; }
      setShowForm(false); setPnid(""); setDisplay("");
      load();
    } finally { setBusy(false); }
  }

  async function disconnect(id: string) {
    if (!confirm("Disconnect this WhatsApp number? Linked phones stop getting answers.")) return;
    await api(`/api/integrations/whatsapp/connections/${id}`, { method: "DELETE" });
    load();
  }

  if (forbidden || !data) return null;
  const c = data.configured;
  const ready = c.access_token && c.app_secret && c.verify_token;
  return (
    <div className="wa-admin">
      <h4 className="wa-sub">Workspace number <span className="key-meta">admins</span></h4>
      {data.numbers.length === 0 && !showForm && <p className="integrations-empty">No WhatsApp number connected.</p>}
      <div className="key-list">
        {data.numbers.map((n) => (
          <div key={n.phone_number_id} className="key-row">
            <div className="key-row-info">
              <span className="key-label"><Phone size={11} /> {n.display_phone}</span>
              <span className="key-meta">ID {n.phone_number_id} · connected {new Date(n.connected_at).toLocaleDateString()}</span>
            </div>
            <button type="button" className="btn-danger-xs" onClick={() => disconnect(n.phone_number_id)} title="Disconnect"><Trash2 size={11} /></button>
          </div>
        ))}
      </div>
      {showForm ? (
        <div className="key-create-form">
          <input className="inp-sm" value={pnid} onChange={(e) => setPnid(digits(e.target.value))} placeholder="Phone number ID (from Meta: WhatsApp → API Setup)" maxLength={32} />
          <input className="inp-sm" value={display} onChange={(e) => setDisplay(e.target.value)} placeholder="The number people message, e.g. +1 555 013 2233" maxLength={32} />
          <button type="button" className="btn-primary-sm" onClick={connect} disabled={busy || pnid.length < 5 || display.trim().length < 4}>
            {busy ? "Connecting…" : "Connect"}
          </button>
          <button type="button" className="btn-ghost" onClick={() => setShowForm(false)}>Cancel</button>
          {error && <p className="wa-error"><CircleAlert size={12} /> {error}</p>}
        </div>
      ) : data.numbers.length === 0 && (
        <button type="button" className="btn-ghost" onClick={() => setShowForm(true)}><Plus size={13} /> Connect a number</button>
      )}

      <details className="wa-setup" open={!ready}>
        <summary>Setup steps {ready ? <span className="wa-pill is-ok">Server ready</span> : <span className="wa-pill">Server needs settings</span>}</summary>
        <ol>
          <li>In Meta for Developers, create an app (type <em>Business</em>) and add the <strong>WhatsApp</strong> product. Meta gives you a free test number.</li>
          <li>Under <em>WhatsApp → API Setup</em>, add your team's phones as test recipients (the test number can message up to 5), and copy the <strong>Phone number ID</strong> into the form above.</li>
          <li>Under <em>WhatsApp → Configuration</em>, set the webhook:
            <pre className="snippet-code">{`Callback URL:  ${data.webhook_url}\nVerify token:  the value of WHATSAPP_VERIFY_TOKEN`}</pre>
            then subscribe to the <code>messages</code> field.</li>
          <li>Store these in Google Secret Manager; the next deploy attaches them to the backend:
            <ul className="wa-env">
              <li className={c.access_token ? "is-ok" : ""}>{c.access_token ? <Check size={12} /> : <CircleAlert size={12} />} <code>ragaas-whatsapp-access-token</code>: the API access token</li>
              <li className={c.app_secret ? "is-ok" : ""}>{c.app_secret ? <Check size={12} /> : <CircleAlert size={12} />} <code>ragaas-whatsapp-app-secret</code>: App settings → Basic → App secret</li>
              <li className={c.verify_token ? "is-ok" : ""}>{c.verify_token ? <Check size={12} /> : <CircleAlert size={12} />} <code>ragaas-whatsapp-verify-token</code>: any random string, also typed in step 3</li>
            </ul>
          </li>
          <li>Each teammate links their phone above with <em>Link my phone</em>. Only linked members get answers.</li>
        </ol>
      </details>
    </div>
  );
}

export function WhatsAppSection({ api }: { api: Api }) {
  return (
    <section className="integrations-section">
      <h3 className="integrations-section-title"><Smartphone size={14} /> WhatsApp</h3>
      <p className="integrations-hint">Your team messages the workspace's WhatsApp number and gets answers from your documents, with the page they came from.</p>
      <MyPhone api={api} />
      <AdminNumbers api={api} />
    </section>
  );
}
