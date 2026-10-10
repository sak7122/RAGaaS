// ─────────────────────────────────────────────────────────────────────────────
// Demo backend — canned in-browser responses so the app works with NO server.
// Enabled by VITE_DEMO_MODE=true. Lets the hosted frontend be fully clickable
// before the real Cloud Run backend exists.
// ─────────────────────────────────────────────────────────────────────────────

export const DEMO = import.meta.env.VITE_DEMO_MODE === "true";

type DocMeta = {
  file_name: string; chunks: number; uploaded_at: string;
  title: string; pages: number; summary: string; questions: string[]; profile_source: string;
};
type Member = { uid: string; email: string; role: string; invited_at: string; joined_at: string | null };

const now = () => new Date().toISOString();

const demoDocs: DocMeta[] = [
  { file_name: "Q3_Earnings_Report.pdf", chunks: 48, uploaded_at: now(), title: "Q3 Earnings Report", pages: 14,
    profile_source: "generated",
    summary: "Third-quarter results: revenue, margins and segment growth, with the outlook for the next two quarters.",
    questions: ["What was Q3 revenue?", "Which segment grew fastest?", "What is the Q4 outlook?"] },
  { file_name: "Employee_Handbook.pdf", chunks: 132, uploaded_at: now(), title: "Employee Handbook", pages: 42,
    profile_source: "generated",
    summary: "Policies, benefits and day-one setup for every employee: access, leave, security training and the 30-day ramp.",
    questions: ["What happens on day one?", "When is security training due?", "How many days of leave do I get?"] },
  { file_name: "Product_Roadmap_2026.pdf", chunks: 27, uploaded_at: now(), title: "Product Roadmap 2026", pages: 9,
    profile_source: "generated",
    summary: "What ships in 2026 and in what order: multi-region availability, SSO and the analytics redesign.",
    questions: ["What ships in Q1 2026?", "When does SSO launch?"] },
];

const demoMembers: Member[] = [
  { uid: "demo-admin", email: "you@acme.com", role: "admin", invited_at: now(), joined_at: now() },
  { uid: "demo-uploader", email: "sam@acme.com", role: "uploader", invited_at: now(), joined_at: now() },
  { uid: "demo-viewer", email: "alex@acme.com", role: "viewer", invited_at: now(), joined_at: null },
];

let queriesUsed = 42;

const demoStatus = () => ({
  tenant_id: "acme-corp",
  tenant_name: "Acme Corp",
  queries_used: queriesUsed,
  query_limit: 1000,
  documents: demoDocs.length,
});

function cannedAnswer(question: string, scope: string[] = []) {
  queriesUsed += 1;
  if (scope.length && !scope.some((f) => f !== "Employee_Handbook.pdf")) {
    // The handbook doesn't cover revenue or roadmap questions: show the scoped miss.
    return {
      answer: "I cannot find that answer in the selected documents.",
      citations: [],
      retrieval: { engine: "Hybrid Vector Search", query_terms: [], chunks_searched: 132, candidates_ranked: 0,
        top_k: 0, max_score: 0, latency_ms: 140, scoped_to: scope },
      tenant_id: "acme-corp", queries_used: queriesUsed, query_limit: 1000,
    };
  }
  const terms = Array.from(
    new Set(question.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []),
  ).sort();
  return {
    answer:
      `Based on your documents, here's what I found regarding "${question.slice(0, 60)}": ` +
      "Q3 revenue grew 18% YoY to $4.2M, driven by enterprise expansion. The roadmap " +
      "prioritizes the multi-region rollout for Q1 2026. (This is a demo response — wire " +
      "the real backend to replace it with live RAG answers.)",
    citations: [
      { file_name: "Q3_Earnings_Report.pdf", page: 4, chunk_index: 12, score: 0.92, excerpt: "Total revenue for the third quarter reached $4.2M, an 18% increase year over year, led by enterprise segment growth." },
      { file_name: "Product_Roadmap_2026.pdf", page: 2, chunk_index: 3, score: 0.74, excerpt: "Q1 2026 focus: multi-region availability, SSO, and the redesigned analytics dashboard." },
    ],
    retrieval: {
      engine: "Hybrid Vector Search",
      query_terms: terms,
      chunks_searched: 207,
      candidates_ranked: 11,
      top_k: 2,
      max_score: 0.92,
      latency_ms: 180 + Math.floor(Math.random() * 90),
      scoped_to: scope,
    },
    tenant_id: "acme-corp",
    queries_used: queriesUsed,
    query_limit: 1000,
  };
}

function cannedWorkflow(problem: string) {
  queriesUsed += 1;
  const summary = problem.slice(0, 80);
  return {
    problem,
    steps: [
      {
        n: 1,
        action: "Provision accounts and access for the new hire (email, SSO, repository).",
        rationale: "Standard first-day setup from the onboarding guide.",
        owner_hint: "IT", blocking: true,
        sources: [{ file_name: "Employee_Handbook.pdf", page: 12, chunk_index: 4, score: 0.88,
          excerpt: "New hires receive email, SSO, and repository access on day one via the IT request form." }],
        suggested_tool_call: { tool: "generate_document",
          args: { doc_type: "onboarding plan", title: summary,
            instructions: "Draft a first-week onboarding plan from the handbook." },
          requires_approval: true, status: "proposed" },
      },
      {
        n: 2,
        action: "Schedule security awareness training and a team introduction.",
        rationale: "Training must be completed within the first five business days.",
        owner_hint: "People Ops", blocking: false,
        sources: [{ file_name: "Employee_Handbook.pdf", page: 14, chunk_index: 1, score: 0.79,
          excerpt: "Security awareness training must be completed within the first five business days." }],
        suggested_tool_call: { tool: "send_email", args: { to: "newhire@acme.com",
          subject: "Welcome — your first-week schedule", body: "Here is your onboarding plan…" },
          requires_approval: true, status: "proposed" },
      },
      {
        n: 3,
        action: "Assign a 30-day ramp plan and pair the hire with a buddy.",
        rationale: "Improves ramp speed and retention per the handbook.",
        owner_hint: "Manager", blocking: false,
        sources: [{ file_name: "Employee_Handbook.pdf", page: 15, chunk_index: 2, score: 0.71,
          excerpt: "Each new hire is paired with a buddy and given a 30-day ramp plan." }],
      },
    ],
    open_questions: ["Which equipment tier applies to this role? Not specified in the documents."],
    confidence: 0.82,
    tenant_id: "acme-corp",
    queries_used: queriesUsed,
    query_limit: 1000,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Drop-in replacement for fetch() — matches on the path suffix.
export async function demoFetch(input: string, init?: RequestInit): Promise<Response> {
  const url = new URL(input, "http://demo.local");
  const path = url.pathname;
  const method = (init?.method ?? "GET").toUpperCase();

  // Small latency so loading states are visible
  await new Promise((r) => setTimeout(r, 350));

  if (path.endsWith("/api/tenant/status")) return json(demoStatus());
  if (path.endsWith("/api/documents") && method === "GET") return json(demoDocs);
  if (path.includes("/api/documents/") && method === "DELETE") return json({ ok: true });
  if (path.endsWith("/api/tenant/members") && method === "GET") return json(demoMembers);
  if (path.endsWith("/api/tenant/invite")) return json({ ok: true, uid: "demo-invited", email_sent: true }, 201);
  if (path.endsWith("/api/tenant/accept-invite")) return json({ ok: true, tenant_id: "tenant-demo", role: "viewer", claim_set: true });
  if (path.endsWith("/api/tenant/profile") && method === "PUT") return json({ ok: true });
  if (path.includes("/api/tenant/members/")) return json({ ok: true });

  if (path.endsWith("/api/chat") && method === "POST") {
    const b = init?.body ? JSON.parse(init.body as string) : {};
    return json(cannedAnswer(String(b.message ?? ""), b.file_names ?? []));
  }
  if (path.endsWith("/profile") && path.includes("/api/documents/") && method === "POST") {
    const name = decodeURIComponent(path.split("/api/documents/")[1].replace(/\/profile$/, ""));
    const doc = demoDocs.find((d) => d.file_name === name);
    return doc ? json(doc) : json({ detail: "Document not found" }, 404);
  }

  if (path.endsWith("/api/solve") && method === "POST") {
    const p = init?.body ? (JSON.parse(init.body as string).problem as string) : "";
    return json(cannedWorkflow(p));
  }

  if (path.endsWith("/api/actions/execute") && method === "POST") {
    const b = init?.body ? JSON.parse(init.body as string) : {};
    if (b.tool === "generate_document") {
      const title = String(b.args?.title ?? "Onboarding Plan");
      return json({ ok: true, tool: b.tool, status: "executed", detail: {
        title, sources: ["Employee_Handbook.pdf"],
        document:
          `# ${title}\n\n## Day 1 — Access & setup\n- Provision email, SSO, and repository access via the IT request form (Employee_Handbook.pdf p.12).\n- Hand over laptop and confirm MFA enrolment.\n\n## Week 1 — Training\n- Complete security awareness training within five business days (p.14).\n- Team introductions and product overview session.\n\n## First 30 days — Ramp\n- Pair with an assigned buddy and follow the 30-day ramp plan (p.15).\n- Weekly check-ins with the manager.\n\n_Grounded in Employee_Handbook.pdf. Demo output._`,
      } });
    }
    if (b.tool === "publish_workflow") {
      return json({ ok: true, tool: b.tool, status: "executed",
        detail: { url: "https://demo.ragaas.app/share/demo-workflow-xyz", title: b.args?.title } });
    }
    // Other tools: demo dry-runs — no real side effect.
    return json({ ok: true, tool: b.tool, status: "executed",
      detail: { dry_run: true, would_send: b.args } });
  }
  if (path.endsWith("/api/actions/audit") && method === "GET") return json([]);

  if (path.endsWith("/api/share") && method === "POST") {
    return json({ share_id: "demo-abc123", url: "https://demo.ragaas.app/share/demo-abc123" }, 201);
  }
  if (path.includes("/api/share/")) return json({
    question: "What are the Q3 revenue numbers?",
    answer: "Q3 revenue was $4.2M, up 18% YoY.",
    citations: [{ file_name: "Q3_Earnings_Report.pdf", page: 4, score: 0.92 }],
    created_at: new Date().toISOString(),
  });

  if (path.endsWith("/api/tenant/widget-keys") && method === "GET") return json([
    { key_id: "demo-key-1", label: "Company website", created_at: new Date().toISOString() },
  ]);
  if (path.endsWith("/api/tenant/widget-keys") && method === "POST") return json({
    key_id: "demo-key-2", key: "wk_demo_REPLACE_WITH_REAL_KEY", label: "New site", created_at: new Date().toISOString(),
  }, 201);
  if (path.includes("/api/tenant/widget-keys/") && method === "DELETE") return json({ ok: true });

  if (path.endsWith("/api/slack/queries") && method === "GET") return json([
    { question: "What is the refund policy?", slack_user: "alice", score: 0.21, answer: "No document answers this well.", ts: new Date(Date.now() - 3600000).toISOString() },
    { question: "What are the Q3 revenue numbers?", slack_user: "bob", score: 0.92, answer: "Q3 revenue was $4.2M, up 18% YoY.", ts: new Date(Date.now() - 7200000).toISOString() },
    { question: "When does SSO ship?", slack_user: "carol", score: 0.74, answer: "SSO is planned for Q2 2026.", ts: new Date(Date.now() - 86400000).toISOString() },
  ]);
  if (path.endsWith("/api/integrations/slack/connections") && method === "GET") return json([]);
  if (path.endsWith("/api/integrations/slack/connect") && method === "POST") return json({
    ok: true, team_id: "T_DEMO",
    instructions: "Add /ask slash command pointing to your Cloud Run URL + /api/integrations/slack/command",
  });
  if (path.includes("/api/integrations/slack/connections/") && method === "DELETE") return json({ ok: true });

  if (path.endsWith("/api/insights")) {
    return json({
      total_queries: 184,
      avg_confidence: 0.61,
      answered_rate: 0.72,
      window: 1000,
      top_questions: [
        { question: "What is the refund policy?", count: 23, avg_score: 0.18 },
        { question: "How do I reset my password?", count: 19, avg_score: 0.81 },
        { question: "What are the Q3 revenue numbers?", count: 14, avg_score: 0.92 },
        { question: "When does the roadmap ship SSO?", count: 11, avg_score: 0.74 },
        { question: "What is the cancellation window?", count: 9, avg_score: 0.12 },
      ],
      gaps: [
        { question: "What is the refund policy?", count: 23, best_score: 0.21, avg_score: 0.18 },
        { question: "What is the cancellation window?", count: 9, best_score: 0.15, avg_score: 0.12 },
        { question: "Do you offer enterprise SLAs?", count: 6, best_score: 0.19, avg_score: 0.14 },
      ],
      faqs: [
        { question: "How do I reset my password?", answer: "Navigate to the login page and click 'Forgot password'. You will receive a reset link within 2 minutes. Links expire after 24 hours.", score: 0.81, count: 19 },
        { question: "What are the Q3 revenue numbers?", answer: "Q3 revenue was $4.2M, up 18% YoY. ARR crossed $16M. EBITDA margin improved to 12% from 7% last quarter.", score: 0.92, count: 14 },
        { question: "When does the roadmap ship SSO?", answer: "SSO (SAML 2.0 + OIDC) is planned for Q2 2026 in the Enterprise tier. Beta access available to customers on the growth plan.", score: 0.74, count: 11 },
      ],
    });
  }

  return json({ detail: "Demo: endpoint not mocked" }, 404);
}
