// Demo-mode responses for the product features: streamed answers, saved
// conversations, feedback, richer Insights, the digest, billing and imports.
type Answer = {
  answer: string; citations: unknown[]; retrieval: Record<string, unknown>;
  queries_used: number; query_limit: number;
};

const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });

type Conv = { id: string; title: string; updated_at: string; messages: Record<string, unknown>[] };
const convs = new Map<string, Conv>();
let seq = 0;

/** The canned answer, written word by word as NDJSON events. */
export function demoStream(a: Answer, question: string, conversationId: string | null): Response {
  const id = `demo-answer-${++seq}`;
  let conv = conversationId ? convs.get(conversationId) : undefined;
  if (!conv) {
    conv = { id: `demo-conv-${seq}`, title: question.slice(0, 80), updated_at: "", messages: [] };
    convs.set(conv.id, conv);
  }
  const now = Date.now();
  conv.messages.push({ role: "user", text: question, timestamp: now },
    { role: "assistant", text: a.answer, citations: a.citations, retrieval: a.retrieval, timestamp: now, answer_id: id });
  conv.updated_at = new Date().toISOString();
  const words = a.answer.split(" ");
  const enc = new TextEncoder();
  const line = (o: unknown) => enc.encode(JSON.stringify(o) + "\n");
  const cid = conv.id;
  const body = new ReadableStream<Uint8Array>({
    async start(c) {
      c.enqueue(line({ type: "meta", citations: a.citations, retrieval: a.retrieval, queries_used: a.queries_used, query_limit: a.query_limit }));
      for (let i = 0; i < words.length; i += 2) {
        await new Promise((r) => setTimeout(r, 45));
        c.enqueue(line({ type: "delta", text: (i ? " " : "") + words.slice(i, i + 2).join(" ") }));
      }
      c.enqueue(line({ type: "done", answer: a.answer, answer_id: id, conversation_id: cid, retrieval: a.retrieval }));
      c.close();
    },
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "application/x-ndjson" } });
}

const week = (i: number) => {
  const d = new Date();
  d.setDate(d.getDate() - d.getDay() + 1 - 7 * i);
  return d.toISOString().slice(0, 10);
};

const insights = {
  total_queries: 184, avg_confidence: 0.61, answered_rate: 0.72, answered: 132, window: 1000,
  top_questions: [
    { question: "How do I reset my password?", count: 19, avg_score: 0.81, variants: ["forgot my password"] },
    { question: "What are the Q3 revenue numbers?", count: 14, avg_score: 0.92 },
    { question: "When does the roadmap ship SSO?", count: 11, avg_score: 0.74 },
    { question: "How many days of leave do I get?", count: 8, avg_score: 0.77 },
  ],
  gaps: [
    { question: "What is the refund policy?", count: 23, best_score: 0.21, avg_score: 0.18,
      variants: ["Do we give refunds?", "refund window for annual plans"], last_asked: new Date().toISOString() },
    { question: "What is the cancellation window?", count: 9, best_score: 0.15, avg_score: 0.12, variants: [] },
    { question: "Do you offer enterprise SLAs?", count: 6, best_score: 0.19, avg_score: 0.14, variants: ["uptime SLA"] },
  ],
  faqs: [
    { question: "How do I reset my password?", answer: "Go to the sign-in page and choose 'Forgot password'. The reset link arrives within 2 minutes and expires after 24 hours.", score: 0.81, count: 19 },
    { question: "What are the Q3 revenue numbers?", answer: "Q3 revenue was $4.2M, up 18% year over year, led by the enterprise segment.", score: 0.92, count: 14 },
  ],
  trend: [7, 6, 5, 4, 3, 2, 1, 0].map((i, k) => {
    const q = [9, 14, 12, 21, 26, 30, 34, 38][k];
    const a = [5, 9, 8, 14, 19, 22, 26, 29][k];
    return { week: week(i), questions: q, answered: a };
  }),
  channels: [{ source: "chat", count: 121 }, { source: "slack", count: 44 }, { source: "whatsapp", count: 19 }],
  documents: [
    { file_name: "Employee_Handbook.pdf", title: "Employee Handbook", citations: 96 },
    { file_name: "Q3_Earnings_Report.pdf", title: "Q3 Earnings Report", citations: 41 },
    { file_name: "Product_Roadmap_2026.pdf", title: "Product Roadmap 2026", citations: 0 },
  ],
  feedback: { helpful: 37, unhelpful: 5, rate: 0.881, recent_unhelpful: [
    { question: "How many days of leave do I get?", answer: "Full-time employees get 20 days of paid leave a year…", ts: new Date().toISOString() },
  ] },
};

let subscribed = false;
const PLANS = [
  { id: "free", name: "Free", price_inr: 0, price_usd: 0, questions: 100, documents: 10, seats: 2, channels: false, academy: false, blurb: "Try it with your own documents." },
  { id: "starter", name: "Starter", price_inr: 999, price_usd: 15, questions: 1000, documents: 100, seats: 5, channels: false, academy: false, blurb: "One small team asking questions every day." },
  { id: "team", name: "Team", price_inr: 2999, price_usd: 39, questions: 5000, documents: null, seats: 20, channels: true, academy: false, blurb: "Answers in Slack, WhatsApp and on your website." },
  { id: "business", name: "Business", price_inr: null, price_usd: null, questions: 20000, documents: null, seats: null, channels: true, academy: true, blurb: "Several sites, onboarding with Academy, priority support." },
];

export function demoProduct(path: string, method: string, body: Record<string, unknown> | null): Response | null {
  if (path.endsWith("/api/feedback")) return json({ ok: true });
  if (path.endsWith("/api/conversations") && method === "GET") {
    return json([...convs.values()].sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      .map((c) => ({ id: c.id, title: c.title, updated_at: c.updated_at, messages: c.messages.length })));
  }
  const conv = /\/api\/conversations\/([^/]+)$/.exec(path);
  if (conv) {
    const c = convs.get(conv[1]);
    if (method === "DELETE") { convs.delete(conv[1]); return json({ ok: true }); }
    return c ? json(c) : json({ detail: "Conversation not found" }, 404);
  }
  if (path.endsWith("/api/insights")) return json(insights);
  if (path.endsWith("/api/insights/digest") && method === "GET") return json({
    subject: "Acme Corp: 38 questions this week, 3 gaps", subscribed, email: "you@acme.com", email_ready: true,
    text: "Your team asked 38 questions this week (+4 vs last week).\nAnswered from your documents: 76%.\n\nQuestions your documents couldn't answer:\n  • What is the refund policy? (asked 23×)\n\nSuggested next step: write a short answer for “What is the refund policy?”…",
  });
  if (path.endsWith("/api/insights/digest/subscribe")) { subscribed = !!body?.on; return json({ ok: true, subscribed }); }
  if (path.endsWith("/api/insights/digest/send")) return json({ sent: true });
  if (path.endsWith("/api/gaps/answer")) return json({ ok: true, file_name: "team-answers.md", entries: 1 });
  if (path.endsWith("/api/import-url")) return json({ file_name: "acme-com-faq.html", chunks: 4, title: "FAQ" });
  if (path.endsWith("/api/billing") && method === "GET") return json({
    enforced: true, plan: PLANS[1], status: "active", renews_at: new Date(Date.now() + 18 * 86400000).toISOString(),
    cancel_at_period_end: false, usage: { questions: 612, documents: 3, seats: 3 }, plans: PLANS,
    checkout_ready: false, can_manage: true,
  });
  if (path.endsWith("/api/billing/checkout")) return json({ detail: "Demo: online payment isn't connected here." }, 503);
  return null;
}
