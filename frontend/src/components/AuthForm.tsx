import { FormEvent, useState } from "react";
import { motion } from "framer-motion";
import { Lock, Mail, Eye, EyeOff, Loader2 } from "lucide-react";

interface AuthFormProps {
  onSignIn: (email: string, password: string) => Promise<void>;
  onSwitchToSignUp: () => void;
  error: string;
}

export function AuthForm({ onSignIn, onSwitchToSignUp, error }: AuthFormProps) {
  const [email, setEmail]       = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw]     = useState(false);
  const [loading, setLoading]   = useState(false);

  const canSubmit = !!email && !!password && !loading;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setLoading(true);
    try {
      await onSignIn(email, password);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="auth-form-wrap">
      <motion.div
        className="auth-card"
        initial={{ opacity: 0, y: 16, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.4, ease: [0.4, 0, 0.2, 1] }}
      >
        <div className="auth-brand">
          <span className="auth-brand-mark">R</span>
          <span className="auth-brand-name">RAGaaS</span>
        </div>

        <h2 className="auth-title">Welcome back</h2>
        <p className="auth-sub">Sign in to your knowledge base</p>

        <form className="auth-form" onSubmit={handleSubmit}>
          <div className="auth-field">
            <Mail size={15} color="var(--ink-48)" />
            <input
              type="email"
              className="chat-input"
              placeholder="Email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              autoFocus
              required
            />
          </div>

          <div className="auth-field">
            <Lock size={15} color="var(--ink-48)" />
            <input
              type={showPw ? "text" : "password"}
              className="chat-input"
              placeholder="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
            <button
              type="button"
              className="auth-eye"
              onClick={() => setShowPw((v) => !v)}
              tabIndex={-1}
              aria-label={showPw ? "Hide password" : "Show password"}
            >
              {showPw ? <EyeOff size={15} /> : <Eye size={15} />}
            </button>
          </div>

          {error && (
            <motion.div
              className="error-banner"
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
            >
              {error}
            </motion.div>
          )}

          <button type="submit" className="btn-primary auth-submit" disabled={!canSubmit}>
            {loading ? <Loader2 size={16} className="auth-spin" /> : "Sign in"}
          </button>
        </form>

        <button type="button" className="auth-toggle" onClick={onSwitchToSignUp}>
          No account? Create one
        </button>

        <p className="auth-privacy">
          By continuing you agree to our{" "}
          <a href="/privacy" className="auth-privacy-link">Privacy &amp; Data Policy</a>.
        </p>
      </motion.div>
    </div>
  );
}
