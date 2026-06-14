import { FormEvent, useState } from "react";
import { motion } from "framer-motion";
import { Lock, Mail, Eye, EyeOff, Loader2, User, Building2, Check } from "lucide-react";

export interface SignUpProfile {
  name: string;
  workspace: string;
}

interface SignUpFormProps {
  onSignUp: (email: string, password: string, profile: SignUpProfile) => Promise<void>;
  onBackToSignIn: () => void;
  error: string;
}

function pwStrength(pw: string): { score: number; label: string } {
  let s = 0;
  if (pw.length >= 6) s++;
  if (pw.length >= 10) s++;
  if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) s++;
  if (/\d/.test(pw)) s++;
  if (/[^A-Za-z0-9]/.test(pw)) s++;
  const labels = ["Too short", "Weak", "Fair", "Good", "Strong", "Strong"];
  return { score: s, label: labels[s] };
}

export function SignUpForm({ onSignUp, onBackToSignIn, error }: SignUpFormProps) {
  const [name, setName]         = useState("");
  const [workspace, setWorkspace] = useState("");
  const [email, setEmail]       = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm]   = useState("");
  const [showPw, setShowPw]     = useState(false);
  const [agree, setAgree]       = useState(false);
  const [loading, setLoading]   = useState(false);

  const strength = pwStrength(password);
  const pwTooShort = password.length > 0 && password.length < 6;
  const mismatch = confirm.length > 0 && confirm !== password;
  const canSubmit =
    !!name && !!workspace && !!email && password.length >= 6 &&
    confirm === password && agree && !loading;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setLoading(true);
    try {
      await onSignUp(email, password, { name: name.trim(), workspace: workspace.trim() });
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="auth-form-wrap">
      <motion.div
        className="auth-card auth-card-wide"
        initial={{ opacity: 0, y: 16, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.4, ease: [0.4, 0, 0.2, 1] }}
      >
        <div className="auth-brand">
          <span className="auth-brand-mark">R</span>
          <span className="auth-brand-name">RAGaaS</span>
        </div>

        <h2 className="auth-title">Create your workspace</h2>
        <p className="auth-sub">Set up your private knowledge base in seconds.</p>

        <form className="auth-form" onSubmit={handleSubmit}>
          <div className="auth-row">
            <div className="auth-field">
              <User size={15} color="var(--ink-48)" />
              <input className="chat-input" placeholder="Full name" value={name}
                     onChange={(e) => setName(e.target.value)} autoComplete="name" autoFocus required />
            </div>
            <div className="auth-field">
              <Building2 size={15} color="var(--ink-48)" />
              <input className="chat-input" placeholder="Workspace / company" value={workspace}
                     onChange={(e) => setWorkspace(e.target.value)} autoComplete="organization" required />
            </div>
          </div>

          <div className="auth-field">
            <Mail size={15} color="var(--ink-48)" />
            <input type="email" className="chat-input" placeholder="Work email" value={email}
                   onChange={(e) => setEmail(e.target.value)} autoComplete="email" required />
          </div>

          <div className="auth-field">
            <Lock size={15} color="var(--ink-48)" />
            <input type={showPw ? "text" : "password"} className="chat-input" placeholder="Password" value={password}
                   onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" required />
            <button type="button" className="auth-eye" tabIndex={-1}
                    onClick={() => setShowPw((v) => !v)} aria-label="Toggle password">
              {showPw ? <EyeOff size={15} /> : <Eye size={15} />}
            </button>
          </div>

          {password.length > 0 && (
            <div className="pw-strength">
              <div className="pw-bars">
                {[0, 1, 2, 3, 4].map((i) => (
                  <span key={i} className={`pw-bar${i < strength.score ? ` s${Math.min(strength.score, 5)}` : ""}`} />
                ))}
              </div>
              <span className={`pw-label s${Math.min(strength.score, 5)}`}>{strength.label}</span>
            </div>
          )}

          <div className={`auth-field${mismatch ? " invalid" : ""}`}>
            <Lock size={15} color="var(--ink-48)" />
            <input type={showPw ? "text" : "password"} className="chat-input" placeholder="Confirm password"
                   value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" required />
            {confirm.length > 0 && !mismatch && <Check size={15} color="var(--green)" />}
          </div>

          {pwTooShort && <div className="auth-hint">Password must be at least 6 characters.</div>}
          {mismatch && <div className="auth-hint">Passwords don't match.</div>}

          <label className="auth-check">
            <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
            <span>I agree to the <a href="/privacy" className="auth-privacy-link">Privacy &amp; Data Policy</a>.</span>
          </label>

          {error && (
            <motion.div className="error-banner" initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }}>
              {error}
            </motion.div>
          )}

          <button type="submit" className="btn-primary auth-submit" disabled={!canSubmit}>
            {loading ? <Loader2 size={16} className="auth-spin" /> : "Create workspace"}
          </button>
        </form>

        <button type="button" className="auth-toggle" onClick={onBackToSignIn}>
          Already have an account? Sign in
        </button>
      </motion.div>
    </div>
  );
}
