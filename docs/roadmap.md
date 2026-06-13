# RAGaaS — Cloud Go-Live Plan & Roadmap

Status: infra (Terraform), CI/CD pipelines, demo hosting, multi-tenant backend all built.
Gap: retrieval + generation are still a mock. Plan below takes it to a real, sellable product.

---

## Phase 0 — Cloud go-live (now)

Goal: real backend on Cloud Run + frontend on Firebase Hosting, prod auth, prod Firestore.
Everything needed already exists in the repo. This phase is **operational**, not new code.

### 0.1 One-time bootstrap (local, project owner)
```powershell
.\scripts\bootstrap_tf_state.ps1            # create gs://ragaas-prod-tfstate
gcloud auth application-default login
cd infra/terraform
terraform init
terraform apply                            # creates SA, WIF, buckets, Firestore, Cloud Run, budget
terraform output github_secrets_summary    # copy values
```

### 0.2 Set GitHub Secrets (once)
From `terraform output` + Firebase console:

| Secret | Source |
|---|---|
| GCP_PROJECT_ID | snappy-mapper-498223-b2 |
| FIREBASE_PROJECT_ID | snappy-mapper-498223-b2 |
| GCP_SERVICE_ACCOUNT | tf output deployer_sa_email |
| GCP_WORKLOAD_IDENTITY_PROVIDER | tf output wif_provider |
| GCS_BUCKET | ragaas-prod-pdfs |
| CORS_ORIGIN_REGEX | https://snappy-mapper-498223-b2\.web\.app |
| VITE_API_URL | tf output cloud_run_url |
| VITE_FIREBASE_API_KEY / AUTH_DOMAIN / APP_ID | Firebase web app config |

### 0.3 Deploy
- Backend + frontend: Actions → **Pipeline** → Run workflow (manual deploy stage).
- Verify: `/api/health` returns 200; frontend loads; sign in with a real Firebase account.

### 0.4 Budget guard
- Add `billing_account` to terraform.tfvars → `terraform apply` → email alerts at 50/90/100%.

**Exit criteria:** live URL, real auth, Firestore quota working, $5 budget alert armed.
**Caveat:** chat still returns the mock answer until Phase 1.

---

## Phase 1 — Real RAG (the actual product)  ⭐ highest value

Without this it's a UI demo. Cheapest path that fits current stack: **Firestore vector search + Gemini**.

### 1.1 Embeddings on ingest
- On upload: chunk → embed each chunk (Vertex `text-embedding-005`) → store vector in Firestore.
- Cache: never re-embed an unchanged chunk (hash the text).

### 1.2 Vector retrieval
- Firestore `find_nearest` (KNN) over tenant's chunk collection — tenant-scoped query.
- Fallback: pgvector on Cloud SQL if Firestore vector limits hit.

### 1.3 Hybrid scoring
- Blend dense cosine + existing keyword/BM25 score. Single biggest quality lever.

### 1.4 Gemini generation
- Retrieved top-k chunks → grounded prompt → Gemini Flash answer with inline citations.
- Citation plumbing already exists in the frontend.

**Effort:** ~M. **Exit:** chat answers from real document content with real citations.

---

## Phase 2 — Trust & UX (makes it premium)

- **Grounding guard**: refuse ("not in your documents") when top score < threshold. Anti-hallucination = the Vectara pitch.
- **Streaming**: SSE token-by-token. UI already animates; streaming = ChatGPT feel.
- **Prompt-injection fencing**: sanitize PDF text, system-prompt isolation.
- **Model fallback**: Gemini Flash default, Pro for hard queries; per-request token cap.

**Effort:** ~S–M. **Exit:** trustworthy, fast, safe answers.

---

## Phase 3 — Sellable surface (turns demo into a product)

- **Tenant API keys**: programmatic access, not just UI. Every competitor is API-first → unlocks B2B.
- **Google Drive connector**: auto-sync docs (Ragie's #1 differentiator; you're already on GCP).
- **Usage dashboard**: queries / tokens / cost per tenant. You have quota data — visualize it. Justifies pricing tiers.
- **Answer feedback**: thumbs up/down stored per answer → "we improve over time" story.

**Effort:** ~M each. **Exit:** self-serve product with a billing story.

---

## Phase 4 — Production hardening

- **Observability**: per-query trace (chunks, scores, latency, tokens, cost) → Cloud Logging/Trace.
- **Eval harness**: golden Q→A set run on every deploy; block on retrieval regression.
- **Answer caching**: cache frequent Q→A; cache embeddings always. Direct cost saver.
- **Backups/DR**: Firestore export schedule; GCS versioning (already on).
- **SLOs + alerts**: latency / error-rate alerts via Cloud Monitoring.

**Effort:** ~M. **Exit:** observable, regression-safe, cost-controlled.

---

## Sequencing

```
Phase 0  (go-live, ops)        →  this week
Phase 1  (real RAG)            →  next — without it there is no product
Phase 2  (trust & UX)          →  before first paying user
Phase 3  (sellable surface)    →  for B2B / self-serve
Phase 4  (hardening)           →  continuous, start once traffic is real
```

## Cost posture
- Cloud Run min-instances=0 → $0 idle.
- Firestore vector + Gemini Flash → near-free at demo load; pennies per real query.
- Budget alert at $5/mo armed in Phase 0.
