import { FormEvent, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { AuthLayout, Field, PasswordInput, Spinner, isEmail, isPersonalEmail } from "./authKit";

export type CompanySize = "1-10" | "11-50" | "51-200" | "201-1000" | "1000+";
export type Role = "founder" | "hr" | "lnd" | "ops" | "engineering" | "other";
export type PrimaryUse = "onboarding" | "knowledge_base" | "compliance" | "support";

export interface OnboardingAnswers {
  company_size: CompanySize;
  role: Role;
  primary_use: PrimaryUse;
  country: string;          // ISO 3166-1 alpha-2
  phone?: string;
}

export interface SignUpProfile {
  name: string;
  workspace: string;
  onboarding: OnboardingAnswers;
}

interface SignUpFormProps {
  onSignUp: (email: string, password: string, profile: SignUpProfile) => Promise<void>;
  onBackToSignIn: () => void;
  error: string;
}

const SIZES: { value: CompanySize; label: string }[] = [
  { value: "1-10", label: "1–10" }, { value: "11-50", label: "11–50" },
  { value: "51-200", label: "51–200" }, { value: "201-1000", label: "201–1,000" },
  { value: "1000+", label: "1,000+" },
];

const ROLES: { value: Role; label: string }[] = [
  { value: "founder", label: "Founder or executive" },
  { value: "hr", label: "HR / People" },
  { value: "lnd", label: "Learning & development" },
  { value: "ops", label: "Operations" },
  { value: "engineering", label: "Engineering / IT" },
  { value: "other", label: "Something else" },
];

const USES: { value: PrimaryUse; label: string; detail: string }[] = [
  { value: "onboarding", label: "Onboard new hires", detail: "Role-based learning paths and tests" },
  { value: "knowledge_base", label: "Answer internal questions", detail: "One searchable source for policies and docs" },
  { value: "compliance", label: "Compliance training", detail: "Track who has read and passed what" },
  { value: "support", label: "Support team enablement", detail: "Grounded answers for customer-facing staff" },
];

const COUNTRIES = [
  "IN", "US", "GB", "CA", "AU", "SG", "AE", "SA", "DE", "FR", "NL", "IE", "ES", "IT", "SE",
  "CH", "PL", "JP", "KR", "ID", "MY", "PH", "VN", "TH", "NZ", "ZA", "NG", "KE", "EG", "BR",
  "MX", "AR", "CO", "IL", "TR", "BD", "PK", "LK", "NP",
];

function defaultCountry(): string {
  try {
    const region = new Intl.Locale(navigator.language).maximize().region ?? "";
    return COUNTRIES.includes(region) ? region : "";
  } catch { return ""; }
}

function pwScore(pw: string): { score: 0 | 1 | 2 | 3 | 4; label: string } {
  if (pw.length < 8) return { score: pw.length ? 1 : 0, label: pw.length ? "Too short" : "" };
  let s = 2;
  if (/[A-Z]/.test(pw) && /[a-z]/.test(pw) && /\d/.test(pw)) s++;
  if (pw.length >= 12 || /[^A-Za-z0-9]/.test(pw)) s++;
  const score = Math.min(s, 4) as 2 | 3 | 4;
  return { score, label: ({ 2: "Fair", 3: "Good", 4: "Strong" } as const)[score] };
}

export function SignUpForm({ onSignUp, onBackToSignIn, error }: SignUpFormProps) {
  const reduceMotion = useReducedMotion();
  const [step, setStep] = useState<1 | 2>(1);
  const [loading, setLoading] = useState(false);
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const touch = (k: string) => setTouched((t) => ({ ...t, [k]: true }));
  // Leaving an EMPTY field never shows "required" — that error waits for submit.
  // (Showing it on blur shifts the layout under the pointer and eats clicks.)
  const blurTouch = (k: string, v: string) => { if (v.trim()) touch(k); };
  const formRef = useRef<HTMLFormElement>(null);
  const focusFirstInvalid = () => requestAnimationFrame(() =>
    formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"], .is-invalid input')?.focus());

  // Step 1
  const [name, setName]         = useState("");
  const [email, setEmail]       = useState("");
  const [password, setPassword] = useState("");
  // Step 2
  const [company, setCompany]   = useState("");
  const [size, setSize]         = useState<CompanySize | "">("");
  const [role, setRole]         = useState<Role | "">("");
  const [use, setUse]           = useState<PrimaryUse | "">("");
  const [country, setCountry]   = useState(defaultCountry);
  const [phone, setPhone]       = useState("");
  const [agree, setAgree]       = useState(false);

  const regionNames = useMemo(() => {
    try { return new Intl.DisplayNames([navigator.language, "en"], { type: "region" }); }
    catch { return null; }
  }, []);
  const countryOptions = useMemo(
    () => COUNTRIES.map((c) => ({ code: c, name: regionNames?.of(c) ?? c }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    [regionNames],
  );

  const strength = pwScore(password);
  const errors = {
    name: !name.trim() ? "Enter your full name." : "",
    email: !isEmail(email) ? "Enter an email like name@company.com." : "",
    password: password.length < 8 ? "Use at least 8 characters." : "",
    company: !company.trim() ? "Enter your company's name." : "",
    size: !size ? "Choose a company size." : "",
    role: !role ? "Choose the role closest to yours." : "",
    use: !use ? "Choose what you'll use RAGaaS for first." : "",
    country: !country ? "Choose a country or region." : "",
    phone: phone && !/^[+0-9 ()-]{6,32}$/.test(phone) ? "Use digits, spaces and + only." : "",
    agree: !agree ? "Accept the terms to create your workspace." : "",
  };
  const show = (k: keyof typeof errors) => (touched[k] ? errors[k] : "");
  const step1Valid = !errors.name && !errors.email && !errors.password;
  const step2Valid = !errors.company && !errors.size && !errors.role && !errors.use &&
                     !errors.country && !errors.phone && !errors.agree;

  function next(e: FormEvent) {
    e.preventDefault();
    ["name", "email", "password"].forEach(touch);
    if (step1Valid) setStep(2); else focusFirstInvalid();
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    ["company", "size", "role", "use", "country", "phone", "agree"].forEach(touch);
    if (!step2Valid || loading || !size || !role || !use) { focusFirstInvalid(); return; }
    setLoading(true);
    try {
      await onSignUp(email.trim(), password, {
        name: name.trim(),
        workspace: company.trim(),
        onboarding: {
          company_size: size, role, primary_use: use, country,
          ...(phone.trim() ? { phone: phone.trim() } : {}),
        },
      });
    } finally {
      setLoading(false);
    }
  }

  const fade = reduceMotion
    ? { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 }, transition: { duration: 0.12 } }
    : { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 }, transition: { duration: 0.18, ease: [0.16, 1, 0.3, 1] as const } };

  return (
    <AuthLayout>
      <p className="authx-step" aria-live="polite">
        Step {step} of 2 · {step === 1 ? "Your account" : "Your workspace"}
      </p>
      <div className="authx-progress" aria-hidden="true">
        <span className="is-done" /><span className={step === 2 ? "is-done" : ""} />
      </div>

      <AnimatePresence mode="wait" initial={false}>
        {step === 1 ? (
          <motion.div key="s1" className="authx-stage" {...fade}>
            <h1 className="authx-title">Create your account</h1>
            <p className="authx-sub">Three quick fields, then your workspace.</p>
            <form ref={formRef} className="authx-form" onSubmit={next} noValidate>
              <Field label="Full name" error={show("name")}>
                {({ id, describedBy, invalid }) => (
                  <input id={id} className="authx-input" value={name} autoFocus
                         onChange={(e) => setName(e.target.value)} onBlur={() => blurTouch("name", name)}
                         autoComplete="name" aria-invalid={invalid || undefined} aria-describedby={describedBy} />
                )}
              </Field>
              <Field
                label="Work email" error={show("email")}
                hint={email && isEmail(email) && isPersonalEmail(email)
                  ? "Personal address? A work email lets teammates find and join your workspace."
                  : undefined}
              >
                {({ id, describedBy, invalid }) => (
                  <input id={id} type="email" className="authx-input" value={email} inputMode="email"
                         onChange={(e) => setEmail(e.target.value)} onBlur={() => blurTouch("email", email)}
                         autoComplete="email" aria-invalid={invalid || undefined} aria-describedby={describedBy} />
                )}
              </Field>
              <Field
                label="Password" error={show("password")}
                hint={
                  <span className="authx-meter-row">
                    <span className="authx-meter" data-score={strength.score}>
                      <i /><i /><i /><i />
                    </span>
                    <span>{strength.label ? `${strength.label} · ` : ""}At least 8 characters</span>
                  </span>
                }
              >
                {({ id, describedBy, invalid }) => (
                  <PasswordInput id={id} value={password} invalid={invalid}
                                 onChange={(e) => setPassword(e.target.value)} onBlur={() => blurTouch("password", password)}
                                 autoComplete="new-password" aria-describedby={describedBy} />
                )}
              </Field>
              <button type="submit" className="authx-btn authx-btn-primary">Continue</button>
            </form>
          </motion.div>
        ) : (
          <motion.div key="s2" className="authx-stage" {...fade}>
            <h1 className="authx-title">Set up your workspace</h1>
            <p className="authx-sub">This tailors your starting templates. You can change it later.</p>
            <form ref={formRef} className="authx-form" onSubmit={submit} noValidate>
              <Field label="Company name" error={show("company")}>
                {({ id, describedBy, invalid }) => (
                  <input id={id} className="authx-input" value={company} autoFocus
                         onChange={(e) => setCompany(e.target.value)} onBlur={() => blurTouch("company", company)}
                         autoComplete="organization" aria-invalid={invalid || undefined} aria-describedby={describedBy} />
                )}
              </Field>

              <fieldset className={`authx-fieldset${show("size") ? " is-invalid" : ""}`}>
                <legend className="authx-label">Company size</legend>
                <div className="authx-segments" role="radiogroup">
                  {SIZES.map((s) => (
                    <label key={s.value} className="authx-segment">
                      <input type="radio" name="size" value={s.value} checked={size === s.value}
                             onChange={() => { setSize(s.value); touch("size"); }} />
                      <span>{s.label}</span>
                    </label>
                  ))}
                </div>
                {show("size") && <p className="authx-error">{errors.size}</p>}
              </fieldset>

              <div className="authx-two">
                <Field label="Your role" error={show("role")}>
                  {({ id, describedBy, invalid }) => (
                    <select id={id} className="authx-input authx-select" value={role}
                            onChange={(e) => setRole(e.target.value as Role)} onBlur={() => blurTouch("role", role)}
                            aria-invalid={invalid || undefined} aria-describedby={describedBy}>
                      <option value="" disabled>Choose…</option>
                      {ROLES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                    </select>
                  )}
                </Field>
                <Field label="Country or region" error={show("country")} hint="Used to choose where data is stored.">
                  {({ id, describedBy, invalid }) => (
                    <select id={id} className="authx-input authx-select" value={country}
                            onChange={(e) => setCountry(e.target.value)} onBlur={() => blurTouch("country", country)}
                            autoComplete="country" aria-invalid={invalid || undefined} aria-describedby={describedBy}>
                      <option value="" disabled>Choose…</option>
                      {countryOptions.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
                    </select>
                  )}
                </Field>
              </div>

              <fieldset className={`authx-fieldset${show("use") ? " is-invalid" : ""}`}>
                <legend className="authx-label">What will you use it for first?</legend>
                <div className="authx-choices" role="radiogroup">
                  {USES.map((u) => (
                    <label key={u.value} className="authx-choice">
                      <input type="radio" name="use" value={u.value} checked={use === u.value}
                             onChange={() => { setUse(u.value); touch("use"); }} />
                      <span className="authx-choice-body">
                        <span className="authx-choice-label">{u.label}</span>
                        <span className="authx-choice-detail">{u.detail}</span>
                      </span>
                    </label>
                  ))}
                </div>
                {show("use") && <p className="authx-error">{errors.use}</p>}
              </fieldset>

              <Field label="Phone" optional error={show("phone")} hint="Only for account and security contact.">
                {({ id, describedBy, invalid }) => (
                  <input id={id} type="tel" className="authx-input" value={phone} inputMode="tel"
                         onChange={(e) => setPhone(e.target.value)} onBlur={() => blurTouch("phone", phone)}
                         autoComplete="tel" aria-invalid={invalid || undefined} aria-describedby={describedBy} />
                )}
              </Field>

              <label className={`authx-consent${show("agree") ? " is-invalid" : ""}`}>
                <input type="checkbox" checked={agree}
                       onChange={(e) => { setAgree(e.target.checked); touch("agree"); }} />
                <span>I agree to the <a href="/privacy">Privacy &amp; Data Policy</a>.</span>
              </label>
              {show("agree") && <p className="authx-error">{errors.agree}</p>}

              {error && <p className="authx-alert" role="alert">{error}</p>}

              <div className="authx-actions">
                <button type="button" className="authx-btn authx-btn-secondary"
                        onClick={() => setStep(1)} disabled={loading}>
                  Back
                </button>
                <button type="submit" className="authx-btn authx-btn-primary"
                        disabled={loading} aria-busy={loading}>
                  {loading ? <><Spinner /> Creating…</> : "Create workspace"}
                </button>
              </div>
            </form>
          </motion.div>
        )}
      </AnimatePresence>

      <p className="authx-switch">
        Already have an account?{" "}
        <button type="button" className="authx-link" onClick={onBackToSignIn}>Sign in</button>
      </p>
    </AuthLayout>
  );
}
