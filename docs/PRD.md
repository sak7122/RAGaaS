roduct Requirement Document (PRD): RAG-as-a-Service (RAGaaS)
1. Executive Summary & Monetization Strategy
The goal of this product is to provide a multi-tenant, zero-baseline, serverless Retrieval-Augmented Generation (RAG) platform tailored for small to mid-sized businesses (e.g., law firms, property management, medical clinics).

Monetization Architecture (Maximizing the $1,000 Credit)
To optimize profitability and extract maximum value from the cloud infrastructure, the platform uses a hybrid pricing strategy:

The "Zero-Baseline" Infrastructure: By relying exclusively on serverless resources, your foundational operational cost is $0.00 when no users are making queries.

Arbitrage Pricing Model: Customers are charged a flat onboarding fee ($300–$500) plus a monthly subscription retainer ($100–$250/month). The subscription includes a generous quota of document processing and queries.

Usage Decoupling: You bill clients based on value metrics (e.g., per document uploaded or per user seat), while your true underlying cloud cost is driven by compute time (Cloud Run CPU/sec) and storage size (Firestore/Cloud Storage gigabytes). The delta between their flat fee and your serverless micro-costs represents your profit margin.

2. System Architecture & Infrastructure (Serverless Stack)
To ensure high margins, all components must scale down to zero when idle. No persistent virtual machines or always-on database instances are permitted.

[Client App / Frontend] 
       │
       ▼
[Firebase Hosting] (Static Web Assets)
       │
       ▼
[Cloud Run API Gateway] (Node.js/Python Express App)
       │
       ├───► [Vertex AI / Grounded Generation API] (LLM & Embeddings)
       ├───► [Firestore] (User Data, Multi-Tenant Metadata, Chat History)
       └───► [Cloud Storage Bucket] (Raw Client PDFs & Document Ingestion)
Components
Frontend Hosting: Firebase Hosting. Fully managed static hosting for the web app UI and client dashboard. Costs pennies per gigabyte.

API & Core Logic: Cloud Run. Houses the backend application. Configured with min-instances = 0. It spins up instantly on an incoming HTTP request and terminates when traffic ceases.

Database & Metadata: Firestore. Manages client organization profiles, user authentication mappings, system prompt configurations, and chat log metadata.

Document Storage: Google Cloud Storage (Standard Tier). Holds raw client documents (PDFs, docx, txt) organized in isolated folders by tenant ID.

RAG Engine: Vertex AI Search and the Grounded Generation API. This handles vector embeddings, chunking, document indexing, and provides the actual API endpoint for grounding Gemini model outputs strictly to the uploaded data sources.

3. Financial Guardrails & Budget Requirements
Cloud billing pipelines can introduce processing lags. The system must implement rigid operational limits to protect promotional capital.

Cloud Billing Configurations
Granular Budget Notifications: Set strict alerting thresholds in the Google Cloud Billing console at 25%, 50%, 75%, and 90% of the target promotional allocation.

Telemetry Logging: Configure an automated daily billing export directly into BigQuery. This permits precise, queryable line-item analysis of every fractional cent consumed by tenant operations.

Regional Selection: Deploy all serverless assets exclusively within low-tier resource regions (such as us-central1 or us-east1) to minimize core compute and storage base rates.

Application-Level Cost Caps (Hard Limits)
Because cloud billing alerts can experience a up to 24-hour notification lag, the software application must enforce its own real-time barriers:

Tenant Quotas: Track the volume of queries and total megabytes uploaded per client inside Firestore.

Circuit Breaker: If a client exceeds their tier allocation (e.g., more than 1,000 queries in a billing cycle), the backend API must immediately reject incoming requests with an HTTP 429 Too Many Requests error before invoking the downstream Grounded Generation API. This halts runaway loops or malicious utilization before it impacts your credit pool.

4. Functional Requirements
4.1 Tenant Onboarding & Admin Module
Multi-Tenancy Isolation: The system must treat every business client as an isolated tenant. No cross-pollination of data is allowed.

Document Ingestion Engine: Provide a simple drag-and-drop dashboard for administrators to upload PDFs. The backend must route files to the specific tenant's Cloud Storage bucket and trigger the Vertex AI Search indexing process.

System Prompt Configuration: Allow the administrator to define the "Persona" or rules for the AI (e.g., "You are a legal assistant for Smith & Associates. Only answer questions using the attached files. If the answer is not present, state that you cannot find it.").

4.2 End-User Chat Interface
Secure Web Widget: A clean chat screen accessible via unique authentication tokens or embeddable as an iframe on client portals.

Strict RAG Execution: The user query must execute against the Grounded Generation API, applying the specific tenant's index filter.

Citations Requirement: Every output generated by the AI must display source file names and specific section/page citations verifying exactly where the information was extracted.

5. Non-Functional & Security Requirements
Security & Compliance: Data must be encrypted at rest and in transit. This isolation is crucial since professional services (legal, medical) will be uploading proprietary documents.

Cold Start Optimization: Cloud Run container entrypoints must be highly optimized (e.g., lightweight base images, deferred imports) to minimize latency during scaling events from zero instances.

Scalability: The architecture must natively handle sudden spikes in usage across separate clients without manual infrastructure modifications.

---

6. Pre-Revenue Gate: Features Required Before First Paid Customer

These four capabilities are the minimum a small business buyer will require before signing. They are not nice-to-haves — a missing item in any of these four columns will kill a deal.

6.1 Team Invite & Role Management

Problem: Every tenant currently has one user. Real companies have teams. A 50-person company needs their ops manager, 3 HR staff, and a legal reviewer to all have access — with different permissions.

Requirements:
- Tenant admin can invite members by email (Firebase Auth invite flow).
- Three roles: Admin (full access: invite, upload, delete, query), Uploader (upload + query, no delete/invite), Viewer (query only).
- Invited users receive email with magic link; first login sets password.
- Tenant admin sees member list with role badges and a remove button.
- Role is stored in Firestore per tenant: `tenants/{tenantId}/members/{uid}` with `{role, email, invitedAt, joinedAt}`.
- All backend endpoints enforce role: upload checks Uploader+, delete checks Admin, chat checks any role.

6.2 Citation-Grounded Answers

Problem: Gemini will hallucinate. A company storing legal contracts or HR policies cannot trust answers that aren't traceable to a source. One wrong answer loses the customer.

Requirements:
- Every chat response must display source citations: filename, page number, chunk excerpt.
- Backend: `/api/chat` returns `{answer: str, citations: [{file, page, chunk_index, excerpt}]}` not just `answer`.
- Frontend: citations render as collapsed cards below the answer bubble. Click to expand shows the exact excerpt.
- If no relevant chunks found (confidence below threshold), response must say "I could not find this in your documents" — never fabricate.
- Confidence threshold: discard retrieved chunks with relevance score < 0.4 (Vertex AI Search returns scores; keyword mock uses match count).

6.3 Multi-File Batch Upload

Problem: A company onboarding means uploading 20–50 documents at once — employee handbook, SOP deck, compliance PDFs. Uploading one file at a time is a deal-killer for the onboarding experience.

Requirements:
- Upload UI accepts multiple files in one file-picker selection (HTML `multiple` attribute).
- Uploads run in parallel (max 3 concurrent XHR) with individual per-file progress bars.
- Each file shows its own status: queued → uploading X% → processing → done / failed.
- Failed files show error inline (file too large, not PDF, server error) without blocking the rest.
- No change to backend upload endpoint — parallel calls from frontend are sufficient.
- Max 10 files per batch, 50MB per file (existing limit).

6.4 Data Privacy & Residency Statement

Problem: Any small business in legal, HR, or finance will ask their legal/IT reviewer "where does our data go?" before signing. Without a written answer, the deal stalls indefinitely.

Requirements:
- A Privacy & Data Residency page (route `/privacy`) in the frontend, static content.
- Must state: data region (us-central1), encryption standard (AES-256 at rest, TLS 1.2+ in transit), retention policy (documents deleted on tenant request within 24 hours), third-party processors (Google Cloud, Vertex AI — with links to Google's DPA), and no training on customer data (Vertex AI enterprise agreement).
- A one-paragraph "Data Security Summary" on the sign-up/login page linking to the full policy.
- Backend: add `DELETE /api/tenant` endpoint — hard-deletes all tenant data (GCS files + Firestore records + index entries) within one API call. This is the GDPR/contractual "right to erasure" lever.

---

7. Post-Revenue Roadmap (Do Not Build Now)

These items come after first paying customers confirm demand:

- Slack / Teams bot integration
- Google Drive folder sync (auto-ingest on new file)
- SOC 2 Type II audit
- Custom branding / white-label
- Per-user analytics dashboard for tenant admins
- Webhook callbacks on upload completion