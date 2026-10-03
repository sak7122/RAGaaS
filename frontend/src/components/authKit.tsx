// Shared building blocks for the sign-in / sign-up screens (.authx-* in styles.css).
// Labels sit above inputs (placeholders are never the label); errors appear on
// blur, not per keystroke, and say how to fix the input.
import { ReactNode, useId, useState, InputHTMLAttributes } from "react";

export function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="authx">
      <main className="authx-main">
        <div className="authx-panel">
          <div className="authx-wordmark" aria-label="RAGaaS">RAGaaS</div>
          {children}
        </div>
      </main>
      <aside className="authx-aside" aria-label="About RAGaaS">
        <div className="authx-aside-inner">
          <h2 className="authx-aside-title">Your company's documents, answered.</h2>
          <ul className="authx-facts">
            <li>
              <strong>Every answer cites its source.</strong>
              <span>Replies quote the document and page they came from, so people can check.</span>
            </li>
            <li>
              <strong>People see only what they're cleared for.</strong>
              <span>Access follows department, role and sensitivity, enforced before search runs.</span>
            </li>
            <li>
              <strong>One isolated workspace per company.</strong>
              <span>Your files and questions are never mixed with another customer's.</span>
            </li>
          </ul>
        </div>
      </aside>
    </div>
  );
}

interface FieldProps {
  label: string;
  hint?: ReactNode;
  error?: string;
  optional?: boolean;
  aside?: ReactNode;               // e.g. "Forgot password?" next to the label
  children: (ids: { id: string; describedBy: string | undefined; invalid: boolean }) => ReactNode;
}

export function Field({ label, hint, error, optional, aside, children }: FieldProps) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errId = error ? `${id}-err` : undefined;
  const describedBy = [errId, hintId].filter(Boolean).join(" ") || undefined;
  return (
    <div className={`authx-field${error ? " is-invalid" : ""}`}>
      <div className="authx-label-row">
        <label className="authx-label" htmlFor={id}>
          {label}
          {optional && <span className="authx-optional"> (optional)</span>}
        </label>
        {aside}
      </div>
      {children({ id, describedBy, invalid: !!error })}
      {error && <p className="authx-error" id={errId}>{error}</p>}
      {!error && hint && <p className="authx-hint" id={hintId}>{hint}</p>}
    </div>
  );
}

type PasswordInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & { invalid?: boolean };

export function PasswordInput({ invalid, ...props }: PasswordInputProps) {
  const [shown, setShown] = useState(false);
  return (
    <div className="authx-input-wrap">
      <input
        {...props}
        type={shown ? "text" : "password"}
        className="authx-input authx-input-pw"
        aria-invalid={invalid || undefined}
      />
      <button
        type="button"
        className="authx-reveal"
        onClick={() => setShown((v) => !v)}
        aria-pressed={shown}
        aria-controls={props.id}
      >
        {shown ? "Hide" : "Show"}
      </button>
    </div>
  );
}

export function Spinner() {
  return <span className="authx-spinner" aria-hidden="true" />;
}

const FREE_MAIL = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "yahoo.co.in", "outlook.com", "hotmail.com",
  "live.com", "icloud.com", "me.com", "aol.com", "proton.me", "protonmail.com",
  "rediffmail.com", "zoho.com", "gmx.com", "yandex.com",
]);

export function isEmail(v: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.trim());
}

export function isPersonalEmail(v: string): boolean {
  const domain = v.trim().toLowerCase().split("@")[1] ?? "";
  return FREE_MAIL.has(domain);
}
