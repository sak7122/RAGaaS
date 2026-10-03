import { FormEvent, useState } from "react";
import { sendPasswordReset, friendlyAuthError } from "../firebase";
import { AuthLayout, Field, PasswordInput, Spinner, isEmail } from "./authKit";

interface AuthFormProps {
  onSignIn: (email: string, password: string) => Promise<void>;
  onSwitchToSignUp: () => void;
  error: string;
}

type Mode = "signin" | "reset" | "reset-sent";

export function AuthForm({ onSignIn, onSwitchToSignUp, error }: AuthFormProps) {
  const [mode, setMode]         = useState<Mode>("signin");
  const [email, setEmail]       = useState("");
  const [password, setPassword] = useState("");
  const [emailTouched, setEmailTouched] = useState(false);
  const [loading, setLoading]   = useState(false);
  const [resetError, setResetError] = useState("");

  const emailError = emailTouched && email && !isEmail(email)
    ? "Enter an email like name@company.com." : "";

  async function handleSignIn(e: FormEvent) {
    e.preventDefault();
    setEmailTouched(true);
    if (!isEmail(email) || !password || loading) return;
    setLoading(true);
    try { await onSignIn(email.trim(), password); } finally { setLoading(false); }
  }

  async function handleReset(e: FormEvent) {
    e.preventDefault();
    setEmailTouched(true);
    if (!isEmail(email) || loading) return;
    setLoading(true);
    setResetError("");
    try {
      await sendPasswordReset(email.trim());
      setMode("reset-sent");
    } catch (err) {
      setResetError(friendlyAuthError(err));
    } finally {
      setLoading(false);
    }
  }

  const emailField = (
    <Field label="Work email" error={emailError}>
      {({ id, describedBy, invalid }) => (
        <input
          id={id} type="email" className="authx-input" value={email}
          onChange={(e) => setEmail(e.target.value)} onBlur={() => setEmailTouched(true)}
          autoComplete="email" inputMode="email" autoFocus required
          aria-invalid={invalid || undefined} aria-describedby={describedBy}
        />
      )}
    </Field>
  );

  if (mode === "reset-sent") {
    return (
      <AuthLayout>
        <h1 className="authx-title">Check your inbox</h1>
        <p className="authx-sub">
          If an account exists for <strong>{email.trim()}</strong>, a reset link is on its way.
          It can take a couple of minutes.
        </p>
        <button type="button" className="authx-btn authx-btn-secondary"
                onClick={() => { setMode("signin"); setPassword(""); }}>
          Back to sign in
        </button>
      </AuthLayout>
    );
  }

  if (mode === "reset") {
    return (
      <AuthLayout>
        <h1 className="authx-title">Reset your password</h1>
        <p className="authx-sub">We'll email you a link to choose a new one.</p>
        <form className="authx-form" onSubmit={handleReset} noValidate>
          {emailField}
          {resetError && <p className="authx-alert" role="alert">{resetError}</p>}
          <button type="submit" className="authx-btn authx-btn-primary"
                  disabled={loading} aria-busy={loading}>
            {loading ? <><Spinner /> Sending…</> : "Send reset link"}
          </button>
        </form>
        <p className="authx-switch">
          <button type="button" className="authx-link" onClick={() => setMode("signin")}>
            Back to sign in
          </button>
        </p>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout>
      <h1 className="authx-title">Sign in</h1>
      <p className="authx-sub">Use the work email your workspace was set up with.</p>

      <form className="authx-form" onSubmit={handleSignIn} noValidate>
        {emailField}
        <Field
          label="Password"
          aside={
            <button type="button" className="authx-link authx-link-sm"
                    onClick={() => { setMode("reset"); setResetError(""); }}>
              Forgot password?
            </button>
          }
        >
          {({ id, describedBy }) => (
            <PasswordInput
              id={id} value={password} onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password" required aria-describedby={describedBy}
            />
          )}
        </Field>

        {error && <p className="authx-alert" role="alert">{error}</p>}

        <button type="submit" className="authx-btn authx-btn-primary"
                disabled={loading || !email || !password} aria-busy={loading}>
          {loading ? <><Spinner /> Signing in…</> : "Sign in"}
        </button>
      </form>

      <p className="authx-switch">
        New to RAGaaS?{" "}
        <button type="button" className="authx-link" onClick={onSwitchToSignUp}>
          Create an account
        </button>
      </p>
      <p className="authx-legal">
        By signing in you agree to the <a href="/privacy">Privacy &amp; Data Policy</a>.
      </p>
    </AuthLayout>
  );
}
