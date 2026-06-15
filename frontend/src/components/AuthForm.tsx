import { FormEvent, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Lock, Mail, Eye, EyeOff, Loader2, AlertCircle } from "lucide-react";
import { Aurora, GradientText, ShinyButton } from "./ui";

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
    <div className="auth-scene">
      <Aurora />

      <motion.div
        className="auth-card glass-card"
        initial={{ opacity: 0, y: 24, scale: 0.96, filter: "blur(8px)" }}
        animate={{ opacity: 1, y: 0, scale: 1, filter: "blur(0px)" }}
        transition={{ duration: 0.5, ease: [0.4, 0, 0.2, 1] }}
      >
        {/* Brand */}
        <div className="auth-brand">
          <motion.span
            className="auth-brand-mark"
            initial={{ scale: 0.5, opacity: 0, rotate: -10 }}
            animate={{ scale: 1, opacity: 1, rotate: 0 }}
            transition={{ delay: 0.15, duration: 0.45, ease: [0.34, 1.56, 0.64, 1] }}
          >
            R
          </motion.span>
          <motion.span
            className="auth-brand-name"
            initial={{ opacity: 0, x: -8 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: 0.25, duration: 0.35 }}
          >
            <GradientText>RAGaaS</GradientText>
          </motion.span>
        </div>

        <motion.h2
          className="auth-title"
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3, duration: 0.3 }}
        >
          Welcome back
        </motion.h2>
        <motion.p
          className="auth-sub"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.38, duration: 0.3 }}
        >
          Sign in to your knowledge base
        </motion.p>

        <motion.form
          className="auth-form"
          onSubmit={handleSubmit}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.42, duration: 0.3 }}
        >
          <div className="auth-field">
            <Mail size={15} className="auth-field-icon" />
            <input
              type="email"
              className="auth-input"
              placeholder="Email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              autoFocus
              required
            />
          </div>

          <div className="auth-field">
            <Lock size={15} className="auth-field-icon" />
            <input
              type={showPw ? "text" : "password"}
              className="auth-input"
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

          <AnimatePresence mode="wait">
            {error && (
              <motion.div
                className="error-banner"
                initial={{ opacity: 0, height: 0, y: -4 }}
                animate={{ opacity: 1, height: "auto", y: 0 }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.22 }}
              >
                <AlertCircle size={13} />
                {error}
              </motion.div>
            )}
          </AnimatePresence>

          <ShinyButton
            type="submit"
            className="auth-submit"
            disabled={!canSubmit}
          >
            {loading ? <Loader2 size={16} className="auth-spin" /> : "Sign in →"}
          </ShinyButton>
        </motion.form>

        <motion.div
          className="auth-footer"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.55 }}
        >
          <button type="button" className="auth-toggle" onClick={onSwitchToSignUp}>
            No account? <span className="auth-toggle-accent">Create one</span>
          </button>
          <p className="auth-privacy">
            By continuing you agree to our{" "}
            <a href="/privacy" className="auth-privacy-link">Privacy &amp; Data Policy</a>.
          </p>
        </motion.div>
      </motion.div>
    </div>
  );
}
