import { FormEvent, useState } from "react";
import { Lock, Mail } from "lucide-react";

interface AuthFormProps {
  onAuth: (email: string, password: string, isNew: boolean) => Promise<void>;
  error: string;
}

export function AuthForm({ onAuth, error }: AuthFormProps) {
  const [email, setEmail]       = useState("");
  const [password, setPassword] = useState("");
  const [isNew, setIsNew]       = useState(false);
  const [loading, setLoading]   = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!email || !password) return;
    setLoading(true);
    try {
      await onAuth(email, password, isNew);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="auth-form-wrap">
      <div className="auth-card">
        <h2 className="auth-title">Sign in to RAGaaS</h2>
        <p className="auth-sub">Ask questions about your documents</p>

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
              required
            />
          </div>
          <div className="auth-field">
            <Lock size={15} color="var(--ink-48)" />
            <input
              type="password"
              className="chat-input"
              placeholder="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={isNew ? "new-password" : "current-password"}
              required
            />
          </div>

          {error && <div className="error-banner">{error}</div>}

          <button type="submit" className="btn-primary" disabled={loading} style={{ width: "100%" }}>
            {loading ? "…" : isNew ? "Create account" : "Sign in"}
          </button>
        </form>

        <button
          type="button"
          className="auth-toggle"
          onClick={() => setIsNew((v) => !v)}
        >
          {isNew ? "Already have an account? Sign in" : "No account? Create one"}
        </button>

        <p className="auth-privacy">
          By signing in you agree to our{" "}
          <a href="/privacy" className="auth-privacy-link">Privacy &amp; Data Policy</a>.
        </p>
      </div>
    </div>
  );
}
