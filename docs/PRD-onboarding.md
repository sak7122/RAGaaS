# PRD: RAGaaS Academy — Knowledge-Base-Driven Employee Onboarding

| | |
|---|---|
| **Status** | Draft v0.1 |
| **Date** | 2026-10-01 |
| **Owner** | Saksham Tripathi |
| **Builds on** | [PRD.md](PRD.md) (RAGaaS core), [roadmap.md](roadmap.md) |
| **Target launch** | Pilot with first client ~6 weeks after kickoff |

---

## 1. Summary

RAGaaS Academy turns a company's own documents (SOPs, policies, product docs, playbooks) into a **personalised onboarding and training program**: role-specific learning paths, lessons grounded in the company's knowledge base, tests auto-generated from that knowledge base, and a manager dashboard showing who is ready and where knowledge gaps are.

The knowledge base is stored in **Supabase (Postgres + pgvector + Storage)**. The existing RAGaaS backend (FastAPI on Cloud Run, Firebase Auth, Gemini on Vertex AI) provides retrieval, generation and grading.

**One-line pitch:** *"Upload your handbook, get a role-based onboarding course with tests in a day — every answer cites your own documents, and nobody sees content they aren't cleared for."*

## 2. Problem

- New hires spend their first weeks searching wikis and asking colleagues; managers repeat the same explanations.
- Existing LMS tools (TalentLMS, Docebo, Trainual) need someone to **author** courses by hand, and the content goes stale as soon as the source documents change.
- Generic AI chatbots answer from the open internet, hallucinate, and ignore who is allowed to see what. That's unacceptable for HR, legal, finance or client data.

## 3. Target customers & personas

**Initial market:** SMBs and mid-market companies with 20–500 employees and regular hiring: agencies, IT services, clinics, property management, BPOs, sales teams. Same ICP as RAGaaS core, sold as an add-on or on its own.

| Persona | Needs |
|---|---|
| **Admin / L&D owner** (HR or ops lead) | Upload docs, define roles, publish a path in under an hour, see completion and scores |
| **Learner** (new hire) | A clear "what to learn today" list, short lessons, an assistant to ask questions, instant feedback on tests |
| **Manager** | Team readiness, weak topics per person, sign-off on certification |
| **Content owner** (SME) | Notice when their doc change made a lesson or question stale; approve regenerated content |

## 4. Goals and non-goals

**Goals (v1)**
1. Admin goes from an empty account to a published learning path in **under 60 minutes**, with no prompt engineering.
2. Every lesson, assistant answer and test question **cites its source chunk**. Nothing ungrounded is shown as fact.
3. **Access-scoped retrieval:** a learner only ever retrieves chunks their role, department and clearance permit, enforced in the database, not only in the UI.
4. Learning paths adapt to role, department and seniority, and to test results (weak topics come back).
5. Cost per active learner stays **under $0.10/month** at pilot scale (§10).

**Non-goals (v1)**
- SCORM/xAPI export, video hosting, live classroom scheduling.
- HRIS sync (Workday, BambooHR). v2 candidate; v1 uses CSV invite and SSO.
- Mobile apps (responsive web only).
- Fine-tuning models on customer data.

## 5. What "network-safe" means here

"Network-safe results" is defined as five guarantees, all of which are acceptance criteria:

1. **Tenant isolation:** company A's data can never be retrieved for company B. Every table has `tenant_id` plus Postgres Row-Level Security (RLS); vector search is a SQL function that filters by tenant *inside* the query.
2. **Need-to-know access:** each document carries access tags (department, role, sensitivity level). Retrieval filters on the learner's entitlements **before** ranking, so restricted text never reaches the LLM prompt.
3. **Grounded only:** answers and questions come only from retrieved chunks. Below a relevance threshold the system says "not covered in your company's docs" and logs it as a knowledge gap. The existing `insights.py` gap detection is reused.
4. **No model training on customer data:** Gemini runs through **Vertex AI on the paid tier**, which doesn't train on prompts. The free AI Studio API is never used for customer data.
5. **Auditability:** every retrieval and generation is logged (who, which chunks, which model) in `audit_log`. Optional per-tenant IP allowlist and SSO-only login.

## 6. Scope: features

### 6.1 Knowledge base (Supabase)
- Ingest PDF, DOCX, Markdown, plain text, FAQ pairs, and URLs (v1.1).
- Chunk, embed, and store in `kb_chunks` (pgvector), keeping the original files in Supabase Storage at `kb/{tenant_id}/{doc_id}`.
- Per-document metadata: owner, department tags, role tags, sensitivity (`public` / `internal` / `restricted`), version, `updated_at`.
- **Change detection:** re-uploading a doc diffs its chunks. Lessons and questions citing changed chunks are flagged `stale` and queued for regeneration and owner approval.

### 6.2 Training engine
- **Topic map:** the LLM clusters the KB into topics and subtopics. The admin can rename, merge or delete them.
- **Learning paths:** an ordered list of modules per *role profile* (e.g. "Sales SDR", "Support L1", "All staff: compliance").
- **Module contents:** short lesson (grounded summary with citations), key facts, 3–10 test items, optional scenario.
- **Item types:**
  - multiple choice (with distractors generated from *other* KB facts so they're plausible)
  - true/false
  - short answer (LLM-graded against a rubric derived from cited chunks)
  - scenario/role-play ("A customer asks for a refund after 45 days — respond"), graded against the policy chunk
- **Placement test** (optional): skips modules the learner already knows.
- **Adaptive review:** wrong answers schedule the topic for spaced repetition at +1, +3 and +7 days.
- **Certification:** pass mark per path; manager sign-off; certificate PDF (reuses `fpdf2`, already a dependency).
- **Ask-the-KB assistant** inside every lesson: the existing `/api/chat`, scoped to the learner's entitlements.

### 6.3 Personalisation
Learner profile: role, department, seniority, location, start date, and placement score. These drive:
1. which paths are assigned (rules, e.g. `department=Sales AND seniority<=2 → "SDR Onboarding"`)
2. which chunks are retrievable (entitlements)
3. lesson depth (a junior gets more context, a senior a summary)
4. the order and spacing of review

### 6.4 Admin setup, built to be easy
A 4-step wizard:
1. **Company:** name, logo, brand colour, SSO domain.
2. **Upload:** drag in docs; tags are suggested automatically from folder names and content.
3. **Roles:** pick from templates (Sales, Support, Engineering, Ops, All-staff) or define custom ones; map them to doc tags.
4. **Generate and review:** the system drafts paths, and the admin approves, edits or regenerates each module, then publishes.

Settings live in one `tenant_config` JSON per tenant, which can be exported and imported for repeat setups. **Deployment modes:**
- **Hosted** (default): shared RAGaaS Supabase project, RLS isolation.
- **Bring-your-own Supabase** (premium): the customer pastes their Supabase URL and service key; we run migrations into their project. Their data stays in their account, which answers procurement and data-residency concerns.

### 6.5 Dashboards
- **Manager:** per-learner progress, scores, time-to-ready, weak topics, overdue modules.
- **Admin:** completion funnel, hardest questions (candidates for rewriting), **knowledge gaps** (questions the KB couldn't answer, which tell them what docs to write), stale content queue.

## 7. Architecture

```
Browser (React/Vite, Firebase Hosting)
   │  Firebase Auth ID token
   ▼
Cloud Run: FastAPI (existing backend, max-instances=1, scale-to-zero)
   ├─► Firebase Auth ............ verify token (no SA key needed)
   ├─► Supabase Postgres ........ KB, pgvector, training data, results (service_role, server-side only)
   ├─► Supabase Storage ......... original documents
   ├─► Vertex AI Gemini ......... lesson/question generation, grading, chat
   ├─► Vertex AI embeddings ..... text-embedding-005 (768-d)
   └─► Firestore ................ quota counters, members (existing; may migrate to Supabase later)
```

**Code fit:** the backend already defines a Protocol interface per service (`StorageBackend`, `IndexBackend`, `Embedder`, `Generator`, `*Store`). Supabase arrives as new implementations (`backend/supabase_stores.py`) behind `RAGAAS_KB_BACKEND=supabase`, and training is a new router (`backend/academy/`). The existing chat, insights and quota code is reused unchanged.

### 7.1 Supabase schema (v1)

| Table | Key columns | Notes |
|---|---|---|
| `tenants` | id, name, config jsonb, mode (`hosted`/`byo`) | |
| `kb_documents` | id, tenant_id, title, storage_path, version, sensitivity, dept_tags[], role_tags[], owner, updated_at | |
| `kb_chunks` | id, tenant_id, doc_id, page, idx, text, embedding vector(768), sensitivity, dept_tags[], role_tags[] | HNSW cosine index; tags copied from the document for filtering |
| `learners` | uid, tenant_id, email, role, department, seniority, location, start_date, clearance | `uid` = Firebase UID |
| `paths` / `modules` / `lessons` | tenant_id, ordering, status (`draft`/`published`/`stale`), source_chunk_ids[] | |
| `items` | tenant_id, module_id, type, stem, options jsonb, answer jsonb, rubric, source_chunk_ids[], difficulty | |
| `assignments` | tenant_id, learner_uid, path_id, due_at, status | |
| `attempts` | tenant_id, learner_uid, item_id, response, score, feedback, graded_by_model, created_at | |
| `review_queue` | tenant_id, learner_uid, topic_id, due_at, interval | spaced repetition |
| `audit_log` | tenant_id, actor, action, chunk_ids[], model, created_at | |

**RPC `match_chunks(p_tenant, p_query, k, p_learner)`:** joins `learners` to get entitlements and filters by `tenant_id`, `sensitivity <= clearance`, and tag overlap, *then* orders by vector distance. The backend never filters in Python. RLS is enabled on all tables with no anon policies; only the backend's `service_role` key reads or writes.

## 8. Key flows

1. **Onboard company:** wizard → upload → ingestion job (chunk, embed, tag) → topic map → draft paths → admin review → publish → CSV/email invites (existing invite + mailer).
2. **Learner day 1:** login → profile confirm → optional placement test → today's plan (2–3 modules, about 30 minutes).
3. **Take test:** item served → answer → instant grade with explanation citing the source → wrong answers go into the review queue.
4. **Doc updated:** re-upload → chunk diff → dependent items marked `stale` → regenerated → owner approves → learners who passed affected items get a short refresher.

## 9. Success metrics

| Metric | Pilot target |
|---|---|
| Admin time to first published path | ≤ 60 min |
| Learner time-to-ready vs. client baseline | −30% |
| Assistant answers with ≥1 valid citation | ≥ 98% |
| Cross-tenant / over-clearance retrievals in pen test | **0** |
| Generated items accepted by admin without edit | ≥ 70% |
| Pilot client converts to paid | Yes |

## 10. Cost model (GCP + Supabase)

> Prices are **list prices as known at time of writing (2026-10); verify on the official pricing pages before quoting a customer.** The billing account is in INR; the USD figures below convert at roughly ₹88 = $1.

### 10.1 Services and free tiers

| Service | Used for | Free tier / allowance | Paid rate beyond |
|---|---|---|---|
| **Cloud Run** | FastAPI backend | 180k vCPU-s, 360k GiB-s, 2M requests per month | ~$0.000024/vCPU-s, ~$0.0000025/GiB-s, $0.40/M requests |
| **Firebase Hosting** | Frontend | 10 GB storage, 360 MB/day transfer | ~$0.15/GB transfer |
| **Firebase Auth** | Login, SSO | 50k MAU | per-MAU above that |
| **Firestore** | Quota counters, members | 1 GiB, 50k reads + 20k writes per day | ~$0.03/100k reads |
| **Vertex AI: Gemini 2.5 Flash-Lite** | Chat, grading | none | ~$0.10/M input tokens, ~$0.40/M output |
| **Vertex AI: Gemini 2.5 Flash** | Course and item generation (quality) | none | ~$0.30/M input, ~$2.50/M output |
| **Vertex AI: text-embedding-005** | Embeddings | none | ~$0.025/M characters |
| **Secret Manager** | SMTP and Supabase keys | 6 versions, 10k accesses | negligible |
| **Cloud Functions + Pub/Sub** | Billing kill switch | within free tier | negligible |
| **Artifact Registry** | Docker images | 0.5 GB | $0.10/GB-month (cleanup policy keeps it near 0.5 GB) |
| **Supabase Free** | KB, pgvector, training data, files | 500 MB DB, 1 GB storage, 5 GB egress, 50k MAU; **pauses after 7 days idle**; no backups | — |
| **Supabase Pro** | Production | 8 GB DB, 100 GB storage, 250 GB egress, daily backups, no pausing | **$25/month** (includes $10 compute credit = Micro instance) |

**Free tier capacity:** at 768-dimension float vectors (about 3 KB) plus text and index overhead (about 6–8 KB per chunk), 500 MB holds roughly **50–70k chunks**. That's about 3–5 companies with 500 docs each, enough for a pilot.

### 10.2 Unit economics: one company, 100 learners, 500 docs (~10k pages)

| Item | Assumption | Cost |
|---|---|---|
| Ingestion embeddings (one-time) | 5M characters | ~$0.13 |
| Course generation (one-time) | ~50 modules × 20k in / 4k out tokens on Flash | ~$0.80 |
| Learner usage (monthly) | 100 learners × 60 interactions × (4k in + 0.5k out) on Flash-Lite | ~$3.60 |
| Content refresh (monthly) | 10% churn, regenerated on Flash | ~$0.20 |
| Cloud Run (monthly) | ~6k requests × ~3 s | $0 (inside free tier) |
| Firestore, Auth, Hosting | | $0 |
| **Variable cost per company** | | **~$4/month (~₹350)** + ~$1 one-time |

### 10.3 Scenarios (monthly)

| Scenario | Companies × learners | GCP variable | Supabase | **Total** |
|---|---|---|---|---|
| Pilot | 1 × 50 | ~$2 | Free ($0) | **~$2 (₹175)** |
| Early | 5 × 100 | ~$20 | Pro $25 | **~$45 (₹4,000)** |
| Growth | 25 × 200 | ~$180 + Cloud Run ~$20 | Pro $25 + Small compute ~$15 | **~$240 (₹21,000)** |

### 10.4 Credits and the kill switch

- **Credit scope (confirmed 2026-10-01):** the ₹94,550 "Trial credit for GenAI App Builder" (valid until **2027-05-15**) applies **only to Vertex AI Search (Discovery Engine) SKUs**: search queries, the Enterprise tier, the LLM add-on / Answer API (generated answers), and index storage. It does **not** cover Gemini API or Vertex Gemini calls, embeddings, Cloud Run, Firestore or Storage.
- **Resulting design (deployed via `infra/terraform/modules/academy`):** one Vertex AI Search data store + Enterprise engine with the LLM add-on **per tenant** (`academy-kb-{tenant}` / `academy-{tenant}`, pilot created). Retrieval and assistant answers run on the credit. Supabase stays the system of record (docs, tags, learners, items, attempts); its URL/key live in Secret Manager (`academy-supabase-url`, `academy-supabase-service-key`).
  - At roughly $4–8 per 1k queries (Enterprise + LLM add-on), the credit (~$1,070) covers about **130k–260k assistant queries** before expiry.
  - After 2027-05-15, or once the credit is used up, switch retrieval to Supabase pgvector through the `IndexBackend` interface.
- **Not covered, so it hits the card:** quiz/lesson generation and grading through Gemini (about $1–4 per company per month).
- **Guardrail, by decision:** the ₹100/month net budget stays as it is. If uncovered Gemini spend exceeds it, the kill switch **unlinks billing for the whole project** (including lld-tutor and ReconBob) until it's re-enabled by hand. That's the accepted hard cap for the pilot.

### 10.5 Suggested pricing (to validate)

| Plan | Price | Includes |
|---|---|---|
| Setup | $500–1,500 one-time | Wizard done-for-you, first path reviewed |
| Starter | $199/month | Up to 50 learners, 1 path, hosted |
| Team | $499/month | Up to 200 learners, unlimited paths, SSO, manager dashboard |
| Enterprise | from $1,500/month | BYO Supabase, IP allowlist, audit export, SLA |

At the "Early" scenario (5 Team clients ≈ $2,500/month revenue against ≈ $45 cost), gross margin is above 95%. The real costs are support and content review, not infrastructure.

## 11. Security & compliance requirements

- `service_role` key only on Cloud Run, via Secret Manager; never sent to the browser.
- RLS on every Supabase table, plus a CI test asserting that the anon key reads 0 rows from every table.
- Prompt-injection guard: retrieved chunks are wrapped as quoted data, and the system prompt forbids following instructions inside them. Tests include adversarial docs.
- PII: optional redaction pass at ingestion for `restricted` docs (emails, phone numbers, government IDs).
- Data deletion: `DELETE /api/tenant` cascades through Supabase (rows + storage) and is logged.
- Pen-test checklist before the first paid client: cross-tenant retrieval, over-clearance retrieval, IDOR on attempts and results, token replay.

## 12. Milestones

| # | Milestone | Scope | Est. |
|---|---|---|---|
| M0 | Foundations | Supabase project + migration, `supabase_stores.py` (KB + storage), `match_chunks` with entitlements, raise budget | 1 wk |
| M1 | KB admin | Upload with tags, sensitivity, change detection, admin doc list | 1 wk |
| M2 | Generation | Topic map, paths, modules, lessons, MCQ/TF items with citations, review UI | 1.5 wk |
| M3 | Learner app | Today's plan, lessons, tests, grading, short answer + scenario, review queue | 1.5 wk |
| M4 | Dashboards + cert | Manager/admin dashboards, certificate PDF, gap report | 1 wk |
| M5 | Pilot hardening | Pen-test checklist, keep-alive or Supabase Pro, onboarding of client #1 | 0.5 wk |

## 13. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Kill switch trips on uncovered Gemini spend | Whole project offline until manual re-enable | Accepted as hard cap (§10.4); route answers through Vertex AI Search (credit); alert emails at 50% |
| Supabase Free pauses after 7 days idle | Pilot down on Monday morning | Health check pings Supabase via UptimeRobot every 5 min; move to Pro at first payment |
| Bad generated questions | Trust loss | Admin approval gate; "report question" button; citation required on every item |
| Entitlement bug leaks restricted content | Critical | Filtering in SQL (not Python), RLS, automated cross-clearance tests in CI |
| Gemini cost spikes from abuse | Budget | Existing 1,000 queries/tenant/day circuit breaker, plus a per-learner daily cap |
| Credit scope narrower than hoped | Higher COGS | Model already priced without credit (§10.2); still under $5/company/month |

## 14. Open questions

1. ~~**Q1:** Credit scope~~ **Resolved:** Vertex AI Search SKUs only (§10.4).
2. **Q2:** Move Firestore quota/members into Supabase too (one database), or keep them as they are?
3. **Q3:** Is Firebase Auth enough for clients that need SAML SSO (Identity Platform tier), or is Supabase Auth preferred?
4. **Q4:** Is BYO-Supabase needed for the first client, or can it wait until Enterprise?
5. **Q5:** Language support: English only for v1, or Hindi as well?
