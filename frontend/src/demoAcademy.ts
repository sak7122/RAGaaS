// Demo Academy: canned /api/academy/* responses for VITE_DEMO_MODE, so the Academy
// screens can be clicked through without the Supabase-backed service.
const iso = (days: number) => new Date(Date.now() + days * 86400000).toISOString();

type Item = { id: string; type: "mcq" | "true_false" | "short_answer"; stem: string; options: string[] | null;
  answer: number | boolean | null; explanation: string; source: string };
type Mod = { id: string; path_id: string; position: number; title: string; est_minutes: number; lesson_md: string;
  source: string; items: Item[] };

const PATH_ID = "p-onboarding";
const MODULES: Mod[] = [
  { id: "m1", path_id: PATH_ID, position: 1, title: "Day one at Acme", est_minutes: 5, source: "Employee Handbook",
    lesson_md: "## Your first day\n\nIT provisions **email, SSO and repository access** through the IT request form before you arrive. On day one you collect your laptop and enrol in multi-factor authentication.\n\n- Laptop handover happens at the front desk at 9:30.\n- MFA enrolment is required before you can open any internal tool.\n- Your buddy walks you through the team's tools in the afternoon.",
    items: [
      { id: "i1", type: "mcq", stem: "What must you do before you can open any internal tool?", options: ["Book a desk", "Enrol in multi-factor authentication", "Finish security training"], answer: 1, explanation: "MFA enrolment is required on day one.", source: "Employee Handbook" },
      { id: "i2", type: "true_false", stem: "IT sets up your accounts after your first day.", options: null, answer: false, explanation: "Accounts are provisioned before you arrive.", source: "Employee Handbook" },
    ] },
  { id: "m2", path_id: PATH_ID, position: 2, title: "Security training", est_minutes: 6, source: "Employee Handbook",
    lesson_md: "## Security awareness\n\nEveryone completes **security awareness training within five business days** of starting. It covers phishing, password managers and how to report an incident.\n\n> If something looks wrong, report it in #security straight away. Nobody is blamed for reporting.",
    items: [
      { id: "i3", type: "mcq", stem: "When is security training due?", options: ["Within five business days", "Within 30 days", "Before your first review"], answer: 0, explanation: "Five business days from your start date.", source: "Employee Handbook" },
      { id: "i4", type: "short_answer", stem: "Where do you report a suspected phishing email?", options: null, answer: null, explanation: "In the #security channel.", source: "Employee Handbook" },
    ] },
  { id: "m3", path_id: PATH_ID, position: 3, title: "How we ship", est_minutes: 7, source: "Product Roadmap 2026",
    lesson_md: "## The 2026 roadmap\n\nThree things ship this year, in order: **multi-region availability** in Q1, **SSO** in Q2 and the **analytics redesign** in the second half.\n\nEach launch has a named owner and a public changelog entry.",
    items: [
      { id: "i5", type: "mcq", stem: "What ships first in 2026?", options: ["SSO", "Analytics redesign", "Multi-region availability"], answer: 2, explanation: "Multi-region availability ships in Q1.", source: "Product Roadmap 2026" },
    ] },
  { id: "m4", path_id: PATH_ID, position: 4, title: "Reading the numbers", est_minutes: 5, source: "Q3 Earnings Report",
    lesson_md: "## Q3 in one minute\n\nRevenue grew **18% year over year to $4.2M**, led by the enterprise segment. The outlook for the next two quarters is steady growth.",
    items: [
      { id: "i6", type: "mcq", stem: "Which segment led Q3 growth?", options: ["Enterprise", "Self-serve", "Partners"], answer: 0, explanation: "Enterprise led growth.", source: "Q3 Earnings Report" },
    ] },
];

// Learner progress in the demo: first two lessons passed.
const passed = new Set(["m1", "m2"]);
const best: Record<string, number> = { m1: 1, m2: 0.83 };

function learnPath() {
  const mods = MODULES.map((m) => ({
    id: m.id, position: m.position, title: m.title, est_minutes: m.est_minutes, item_count: m.items.length,
    passed: passed.has(m.id), best_score: best[m.id] ?? null, review_due_at: m.id === "m1" ? iso(2) : null,
  }));
  const n = mods.filter((m) => m.passed).length;
  return {
    id: PATH_ID, title: "New starter onboarding", pass_mark: 0.7,
    status: n === mods.length ? "passed" : n ? "in_progress" : "assigned",
    score: n ? Object.values(best).reduce((a, b) => a + b, 0) / Object.values(best).length : null,
    modules_total: mods.length, modules_passed: n, modules: mods, due_at: iso(9), overdue: false, certified_at: null,
  };
}

function plan() {
  const next = MODULES.find((m) => !passed.has(m.id));
  const today = [
    ...(next ? [{ kind: "next", path_id: PATH_ID, path_title: "New starter onboarding", module_id: next.id, module_title: next.title, est_minutes: next.est_minutes }] : []),
    { kind: "review", path_id: PATH_ID, path_title: "New starter onboarding", module_id: "m1", module_title: "Day one at Acme", est_minutes: 2 },
  ];
  return {
    preview: true, clearance: 1, department: "Engineering", role: "Engineer",
    paths: [learnPath(), {
      id: "p-security", title: "Security essentials", pass_mark: 0.8, status: "certified", score: 0.94,
      modules_total: 3, modules_passed: 3, due_at: null, overdue: false, certified_at: iso(-12),
      modules: [
        { id: "s1", position: 1, title: "Phishing", est_minutes: 4, item_count: 3, passed: true, best_score: 1, review_due_at: null },
        { id: "s2", position: 2, title: "Passwords and MFA", est_minutes: 4, item_count: 3, passed: true, best_score: 0.9, review_due_at: null },
        { id: "s3", position: 3, title: "Reporting an incident", est_minutes: 3, item_count: 2, passed: true, best_score: 0.92, review_due_at: null },
      ],
    }],
    today, today_minutes: today.reduce((a, t) => a + t.est_minutes, 0), reviews_due: 1,
  };
}

function learnModule(id: string) {
  const m = MODULES.find((x) => x.id === id) ?? MODULES[0];
  return {
    id: m.id, path_id: PATH_ID, path_title: "New starter onboarding", position: m.position, title: m.title,
    lesson_md: m.lesson_md, est_minutes: m.est_minutes, pass_mark: 0.7,
    sources: [{ doc_id: m.source, title: m.source }],
    items: m.items.map(({ id: iid, type, stem, options }) => ({ id: iid, type, stem, options })),
    progress: best[m.id] !== undefined ? { best_score: best[m.id], passed: passed.has(m.id), attempts: 1 } : null,
    review_due_at: null,
  };
}

function submit(id: string, answers: { item_id: string; response: unknown }[]) {
  const m = MODULES.find((x) => x.id === id) ?? MODULES[0];
  const got = new Map(answers.map((a) => [a.item_id, a.response]));
  const results = m.items.map((it) => {
    const r = got.get(it.id);
    const correct = it.type === "short_answer" ? typeof r === "string" && /security/i.test(r) : r === it.answer;
    return {
      item_id: it.id, type: it.type, correct, score: correct ? 1 : 0, feedback: correct ? "Correct." : "Not quite.",
      explanation: it.explanation, correct_answer: it.answer,
      model_answer: it.type === "short_answer" ? "Report it in the #security channel straight away." : null,
      sources: [{ doc_id: it.source, title: it.source }],
    };
  });
  const score = results.reduce((a, r) => a + r.score, 0) / Math.max(1, results.length);
  if (score >= 0.7) { passed.add(m.id); best[m.id] = Math.max(best[m.id] ?? 0, score); }
  return { module_id: m.id, score, passed: score >= 0.7, pass_mark: 0.7, preview: true,
    review_due_at: score >= 0.7 ? iso(7) : null, results, path: learnPath() };
}

const LEARNERS = [
  { uid: "u1", email: "maya@acme.com", name: "Maya Torres", department: "Support", role: "Agent", pending: false, last_active: iso(0), path: { status: "in_progress", passed: 3, score: 0.86, due: iso(4), overdue: false, weak: [] as string[] } },
  { uid: "u2", email: "jonah@acme.com", name: "Jonah Reid", department: "Engineering", role: "Engineer", pending: false, last_active: iso(-1), path: { status: "passed", passed: 4, score: 0.92, due: iso(2), overdue: false, weak: [] } },
  { uid: "u3", email: "priya@acme.com", name: "Priya Nair", department: "Sales", role: "Account executive", pending: false, last_active: iso(-3), path: { status: "in_progress", passed: 1, score: 0.64, due: iso(1), overdue: false, weak: ["Reading the numbers"] } },
  { uid: "u4", email: "sam@acme.com", name: "Sam Okoye", department: "Support", role: "Agent", pending: false, last_active: iso(-9), path: { status: "in_progress", passed: 1, score: 0.58, due: iso(-3), overdue: true, weak: ["Security training"] } },
  { uid: "u5", email: "lena@acme.com", name: "Lena Fischer", department: "Operations", role: "Manager", pending: false, last_active: iso(0), path: { status: "certified", passed: 4, score: 0.97, due: null, overdue: false, weak: [] } },
  { uid: "u6", email: "alex@acme.com", name: null, department: "Engineering", role: "Engineer", pending: true, last_active: null, path: { status: "assigned", passed: 0, score: null, due: iso(12), overdue: false, weak: [] } },
];

function dashboard() {
  return {
    totals: { learners: 6, not_signed_in: 1, assignments: 6, in_progress: 3, completed: 2, awaiting_signoff: 1, certified: 1, overdue: 1 },
    paths: [
      { id: PATH_ID, title: "New starter onboarding", status: "published", pass_mark: 0.7, due_days: 14, lessons: 4,
        eligible: 6, started: 5, passed: 2, certified: 1, overdue: 1, avg_score: 0.79, median_days_to_ready: 8 },
      { id: "p-security", title: "Security essentials", status: "published", pass_mark: 0.8, due_days: 7, lessons: 3,
        eligible: 6, started: 6, passed: 5, certified: 4, overdue: 0, avg_score: 0.9, median_days_to_ready: 3 },
      { id: "p-sales", title: "Selling the 2026 roadmap", status: "stale", pass_mark: 0.7, due_days: 21, lessons: 5,
        eligible: 2, started: 1, passed: 0, certified: 0, overdue: 0, avg_score: 0.61, median_days_to_ready: null },
    ],
    learners: LEARNERS.map((l) => ({
      uid: l.uid, email: l.email, name: l.name, department: l.department, role: l.role, pending: l.pending, last_active: l.last_active,
      paths: [{ path_id: PATH_ID, title: "New starter onboarding", status: l.path.status, score: l.path.score,
        modules_passed: l.path.passed, modules_total: 4, assigned_at: iso(-10), due_at: l.path.due, overdue: l.path.overdue,
        completed_at: null, certified_at: l.path.status === "certified" ? iso(-2) : null, weak_modules: l.path.weak }],
    })),
    hardest: [
      { item_id: "i6", stem: "Which segment led Q3 growth?", type: "mcq", module_title: "Reading the numbers", path_title: "New starter onboarding", attempts: 9, avg_score: 0.44 },
      { item_id: "i4", stem: "Where do you report a suspected phishing email?", type: "short_answer", module_title: "Security training", path_title: "New starter onboarding", attempts: 11, avg_score: 0.62 },
      { item_id: "i2", stem: "IT sets up your accounts after your first day.", type: "true_false", module_title: "Day one at Acme", path_title: "New starter onboarding", attempts: 12, avg_score: 0.75 },
    ],
    gaps: [
      { question: "What is the refund policy?", count: 23, last_asked: iso(-1) },
      { question: "Do we offer enterprise SLAs?", count: 6, last_asked: iso(-4) },
    ],
    stale: [{ path_id: "p-sales", title: "Selling the 2026 roadmap", status: "stale", stale_lessons: 2, stale_questions: 3 }],
  };
}

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });

export function demoAcademy(path: string, method: string, body: unknown): Response | null {
  if (!path.includes("/api/academy/")) return null;
  const p = path.slice(path.indexOf("/api/academy/") + "/api/academy".length);
  if (p === "/me") return json({ enabled: true, is_admin: true });
  if (p === "/dashboard") return json(dashboard());
  if (p === "/learn/plan") return json(plan());
  const mod = /^\/learn\/modules\/([^/]+)(\/submit)?$/.exec(p);
  if (mod && !mod[2]) return json(learnModule(mod[1]));
  if (mod && mod[2] && method === "POST") return json(submit(mod[1], (body as { answers?: [] })?.answers ?? []));
  if (p === "/ask" && method === "POST") return json({
    answer: "Report it in the **#security** channel straight away. Nobody is blamed for reporting.",
    grounded: true, citations: [{ doc_id: "hb", title: "Employee Handbook", excerpt: "report it in #security" }],
  });
  if (p === "/documents" && method === "GET") return json([
    { id: "d1", title: "Employee Handbook", sensitivity: 0, dept_tags: [], role_tags: [], updated_at: iso(-20), version: 3 },
    { id: "d2", title: "Product Roadmap 2026", sensitivity: 1, dept_tags: ["Engineering", "Sales"], role_tags: [], updated_at: iso(-4), version: 2 },
    { id: "d3", title: "Q3 Earnings Report", sensitivity: 1, dept_tags: [], role_tags: ["Manager"], updated_at: iso(-30), version: 1 },
  ]);
  if (p === "/learners" && method === "GET") return json(LEARNERS.map((l) => ({
    uid: l.uid, email: l.email, role: l.role, department: l.department, seniority: 1, clearance: 1, pending: l.pending, name: l.name,
  })));
  if (p === "/paths" && method === "GET") return json(dashboard().paths.map((x) => ({
    id: x.id, title: x.title, status: x.status, error: null, updated_at: iso(-3), pass_mark: x.pass_mark,
    rules: { department: null, role: null, clearance: 1, due_days: x.due_days }, module_count: x.lessons,
  })));
  return json({ ok: true });
}
