// ─────────────────────────────────────────────────────────────────────────────
// Demo backend — canned in-browser responses so the app works with NO server.
// Enabled by VITE_DEMO_MODE=true. Lets the hosted frontend be fully clickable
// before the real Cloud Run backend exists.
// ─────────────────────────────────────────────────────────────────────────────

export const DEMO = import.meta.env.VITE_DEMO_MODE === "true";

type DocMeta = { file_name: string; chunks: number; uploaded_at: string };
type Member = { uid: string; email: string; role: string; invited_at: string; joined_at: string | null };

const now = () => new Date().toISOString();

const demoDocs: DocMeta[] = [
  { file_name: "Q3_Earnings_Report.pdf", chunks: 48, uploaded_at: now() },
  { file_name: "Employee_Handbook.pdf", chunks: 132, uploaded_at: now() },
  { file_name: "Product_Roadmap_2026.pdf", chunks: 27, uploaded_at: now() },
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

function cannedAnswer(question: string) {
  queriesUsed += 1;
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
    },
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
    const q = init?.body ? (JSON.parse(init.body as string).message as string) : "";
    return json(cannedAnswer(q));
  }

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
