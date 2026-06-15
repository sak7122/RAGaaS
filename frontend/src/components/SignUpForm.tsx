import { FormEvent, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Lock, Mail, Eye, EyeOff, Loader2, User, Building2, Check, AlertCircle } from "lucide-react";
import { Aurora, GradientText, ShinyButton } from "./ui";

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
    <div className="auth-scene">
      <Aurora />

      <motion.div
        className="auth-card auth-card-wide glass-card"
        initial={{ opacity: 0, y: 24, scale: 0.96, filter: "blur(8px)" }}
        animate={{ opacity: 1, y: 0, scale: 1, filter: "blur(0px)" }}
        transition={{ duration: 0.5, ease: [0.4, 0, 0.2, 1] }}
      >
        <div className="auth-brand">
          <motion.span
            className="auth-brand-mark"
            initial={{ scale: 0.5, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ delay: 0.15, duration: 0.45, ease: [0.34, 1.56, 0.64, 1] }}
          >
            R
          </motion.span>
          <span className="auth-brand-name"><GradientText>RAGaaS</GradientText></span>
        </div>

        <h2 className="auth-title">Create your workspace</h2>
        <p className="auth-sub">Set up your private knowledge base in seconds.</p>

        <form className="auth-form" onSubmit={handleSubmit}>
          <div className="auth-row">
            <div className="auth-field">
              <User size={15} className="auth-field-icon" />
              <input className="auth-input" placeholder="Full name" value={name}
                     onChange={(e) => setName(e.target.value)} autoComplete="name" autoFocus required />
            </div>
            <div className="auth-field">
              <Building2 size={15} className="auth-field-icon" />
              <input className="auth-input" placeholder="Workspace / company" value={workspace}
                     onChange={(e) => setWorkspace(e.target.value)} autoComplete="organization" required />
            </div>
          </div>

          <div className="auth-field">
            <Mail size={15} className="auth-field-icon" />
            <input type="email" className="auth-input" placeholder="Work email" value={email}
                   onChange={(e) => setEmail(e.target.value)} autoComplete="email" required />
          </div>

          <div className="auth-field">
            <Lock size={15} className="auth-field-icon" />
            <input type={showPw ? "text" : "password"} className="auth-input" placeholder="Password" value={password}
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
                  <motion.span
                    key={i}
                    className={`pw-bar${i < strength.score ? ` s${Math.min(strength.score, 5)}` : ""}`}
                    animate={{ opacity: i < strength.score ? 1 : 0.3 }}
                    transition={{ duration: 0.2 }}
                  />
                ))}
              </div>
              <span className={`pw-label s${Math.min(strength.score, 5)}`}>{strength.label}</span>
            </div>
          )}

          <div className={`auth-field${mismatch ? " invalid" : ""}`}>
            <Lock size={15} className="auth-field-icon" />
            <input type={showPw ? "text" : "password"} className="auth-input" placeholder="Confirm password"
                   value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" required />
            <AnimatePresence>
              {confirm.length > 0 && !mismatch && (
                <motion.span initial={{ scale: 0 }} animate={{ scale: 1 }} exit={{ scale: 0 }}>
                  <Check size={15} color="var(--green)" />
                </motion.span>
              )}
            </AnimatePresence>
          </div>

          {pwTooShort && <div className="auth-hint">Password must be at least 6 characters.</div>}
          {mismatch && <div className="auth-hint error">Passwords don't match.</div>}

          <label className="auth-check">
            <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
            <span>I agree to the <a href="/privacy" className="auth-privacy-link">Privacy &amp; Data Policy</a>.</span>
          </label>

          <AnimatePresence mode="wait">
            {error && (
              <motion.div className="error-banner"
                initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}>
                <AlertCircle size={13} /> {error}
              </motion.div>
            )}
          </AnimatePresence>

          <ShinyButton type="submit" className="auth-submit" disabled={!canSubmit}>
            {loading ? <Loader2 size={16} className="auth-spin" /> : "Create workspace →"}
          </ShinyButton>
        </form>

        <div className="auth-footer">
          <button type="button" className="auth-toggle" onClick={onBackToSignIn}>
            Already have an account? <span className="auth-toggle-accent">Sign in</span>
          </button>
        </div>
      </motion.div>
    </div>
  );
}
