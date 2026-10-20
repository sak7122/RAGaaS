// Billing: current plan, this month's usage against it, and upgrade via Razorpay
// Checkout (subscriptions). While billing isn't enforced every workspace is on Beta.
import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { Check, CircleAlert, Crown } from "lucide-react";
import "./billing.css";

type Api = (path: string, init?: RequestInit) => Promise<Response>;
export type PlanInfo = {
  id: string; name: string; price_inr: number | null; price_usd: number | null;
  questions: number | null; documents: number | null; seats: number | null;
  channels: boolean; academy: boolean; blurb: string;
};
type Billing = {
  enforced: boolean; plan: PlanInfo; status: string; renews_at: string | null; cancel_at_period_end: boolean;
  usage: { questions: number; documents: number; seats: number };
  plans: PlanInfo[]; checkout_ready: boolean; can_manage: boolean;
};

declare global {
  interface Window { Razorpay?: new (opts: Record<string, unknown>) => { open: () => void } }
}

const EASE = [0.23, 1, 0.32, 1] as const;
// Where Business-plan enquiries go; set VITE_SALES_EMAIL at build time.
const SALES_EMAIL = (import.meta.env.VITE_SALES_EMAIL as string | undefined) ?? "";
const inr = (n: number) => `₹${n.toLocaleString("en-IN")}`;
const limit = (n: number | null, unit: string) => (n === null ? `Unlimited ${unit}` : `${n.toLocaleString()} ${unit}`);

export function planFeatures(p: PlanInfo): string[] {
  return [
    p.questions === null ? "Unlimited questions" : `${p.questions.toLocaleString()} questions a month`,
    limit(p.documents, "documents"),
    p.seats === null ? "Unlimited people" : `${p.seats} people`,
    "Answers cite the page they came from",
    "Website widget",
    ...(p.channels ? ["Slack and WhatsApp"] : []),
    ...(p.academy ? ["Academy: onboarding courses from your documents"] : []),
  ];
}

function loadRazorpay(): Promise<boolean> {
  if (window.Razorpay) return Promise.resolve(true);
  return new Promise((resolve) => {
    const s = document.createElement("script");
    s.src = "https://checkout.razorpay.com/v1/checkout.js";
    s.onload = () => resolve(true);
    s.onerror = () => resolve(false);
    document.body.appendChild(s);
  });
}

function Meter({ label, used, max }: { label: string; used: number; max: number | null }) {
  const share = max ? Math.min(1, used / max) : 0;
  const tone = share >= 1 ? "is-full" : share >= 0.8 ? "is-near" : "";
  return (
    <div className={`bl-meter ${tone}`}>
      <div className="bl-meter-top"><span>{label}</span><span className="num">{used.toLocaleString()}{max !== null ? ` / ${max.toLocaleString()}` : ""}</span></div>
      {max !== null && (
        <span className="bl-meter-bar"><motion.b initial={{ transform: "scaleX(0)" }} animate={{ transform: `scaleX(${share})`, transition: { duration: 0.8, ease: EASE } }} /></span>
      )}
    </div>
  );
}

export function BillingPanel({ api }: { api: Api }) {
  const [b, setB] = useState<Billing | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  async function load() {
    const r = await api("/api/billing");
    if (r.ok) setB(await r.json());
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  async function upgrade(plan: PlanInfo) {
    setBusy(plan.id); setMsg(null);
    try {
      const r = await api("/api/billing/checkout", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ plan: plan.id }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) { setMsg({ kind: "error", text: typeof body.detail === "string" ? body.detail : "Couldn't start checkout." }); return; }
      if (!(await loadRazorpay()) || !window.Razorpay) { setMsg({ kind: "error", text: "Couldn't load the payment window. Check your connection." }); return; }
      const rzp = new window.Razorpay({
        key: body.key_id,
        subscription_id: body.subscription_id,
        name: "RAGaaS",
        description: `${plan.name} plan for ${body.workspace}`,
        prefill: { email: body.email ?? "" },
        theme: { color: "#0066cc" },
        handler: async (resp: Record<string, string>) => {
          const v = await api("/api/billing/verify", {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(resp),
          });
          setMsg(v.ok ? { kind: "ok", text: `You're on ${plan.name}. Thank you!` } : { kind: "error", text: "Payment received but not confirmed yet. Refresh in a minute." });
          load();
        },
      });
      rzp.open();
    } finally { setBusy(null); }
  }

  async function cancel() {
    if (!confirm("Cancel your plan? It stays active until the end of the paid period.")) return;
    const r = await api("/api/billing/cancel", { method: "POST" });
    setMsg(r.ok ? { kind: "ok", text: "Cancelled. Your plan stays active until the period ends." } : { kind: "error", text: "Couldn't cancel right now." });
    load();
  }

  if (!b) return <div className="bl-wrap"><div className="bl-skel" /></div>;
  const p = b.plan;
  return (
    <div className="bl-wrap">
      <header className="bl-hero">
        <p className="bl-eyebrow">Billing</p>
        <h2 className="bl-title">You're on <span className="bl-hl">{p.name}</span>.</h2>
        <p className="bl-sub">
          {!b.enforced ? "RAGaaS is free during the pilot. Plans below are what you'll choose from when it ends."
            : b.cancel_at_period_end && b.renews_at ? `Cancelled: active until ${new Date(b.renews_at).toLocaleDateString()}.`
            : b.renews_at ? `Renews on ${new Date(b.renews_at).toLocaleDateString()}.` : p.blurb}
        </p>
      </header>

      <section className="bl-card bl-usage" aria-label="Usage this month">
        <Meter label="Questions this month" used={b.usage.questions} max={p.questions} />
        <Meter label="Documents" used={b.usage.documents} max={p.documents} />
        <Meter label="People" used={b.usage.seats} max={p.seats} />
      </section>

      {msg && <p className={`bl-msg is-${msg.kind}`} role="status">{msg.kind === "ok" ? <Check size={14} /> : <CircleAlert size={14} />} {msg.text}</p>}

      <div className="bl-plans">
        {b.plans.map((plan, i) => {
          const current = plan.id === p.id;
          const selfServe = plan.id === "starter" || plan.id === "team";
          return (
            <motion.section key={plan.id} className={`bl-plan${plan.id === "team" ? " is-featured" : ""}${current ? " is-current" : ""}`}
              initial={{ opacity: 0, transform: "translateY(12px)" }}
              animate={{ opacity: 1, transform: "translateY(0px)", transition: { duration: 0.45, ease: EASE, delay: 0.05 + i * 0.06 } }}>
              {plan.id === "team" && <span className="bl-badge"><Crown size={11} /> Most popular</span>}
              <h3>{plan.name}</h3>
              <p className="bl-price">
                {plan.price_inr === null ? <span className="bl-amt">Let's talk</span>
                  : plan.price_inr === 0 ? <span className="bl-amt">Free</span>
                  : <><span className="bl-amt">{inr(plan.price_inr)}</span><span className="bl-per">/month</span></>}
              </p>
              {plan.price_usd ? <p className="bl-usd">about ${plan.price_usd}/month outside India</p> : <p className="bl-usd">&nbsp;</p>}
              <p className="bl-blurb">{plan.blurb}</p>
              <ul>{planFeatures(plan).map((f) => <li key={f}><Check size={13} aria-hidden="true" /> {f}</li>)}</ul>
              <span className="bl-spacer" />
              {current ? (
                <span className="bl-current">Current plan</span>
              ) : !b.can_manage ? (
                <span className="bl-current is-muted">Ask an admin to change plans</span>
              ) : selfServe ? (
                <button type="button" className={`bl-cta${plan.id === "team" ? " is-primary" : ""}`} disabled={!!busy || !b.enforced}
                  title={!b.enforced ? "Plans start when the pilot ends" : undefined} onClick={() => upgrade(plan)}>
                  {busy === plan.id ? "Opening checkout…" : `Choose ${plan.name}`}
                </button>
              ) : plan.id === "business" ? (
                SALES_EMAIL
                  ? <a className="bl-cta" href={`mailto:${SALES_EMAIL}?subject=RAGaaS%20Business%20plan`}>Contact us</a>
                  : <span className="bl-current is-muted">Contact your RAGaaS representative</span>
              ) : null}
            </motion.section>
          );
        })}
      </div>

      <p className="bl-foot">
        Prices include all answers; there are no per-message charges. Payments are handled by Razorpay (cards, UPI, netbanking).
        {b.enforced && b.can_manage && b.plan.id !== "free" && !b.cancel_at_period_end && b.status === "active" && (
          <> <button type="button" className="bl-link" onClick={cancel}>Cancel plan</button></>
        )}
      </p>
    </div>
  );
}
