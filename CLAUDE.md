# RAGaaS — Claude Code Context

Local-first, multi-tenant RAG-as-a-Service. FastAPI backend + React/Vite frontend + Firebase emulators.

## Project Structure

```
RAGaaS/
├── backend/                   # Python FastAPI
│   ├── main.py                # Routes: /api/health, /api/upload, /api/chat, /api/tenant/status, /api/dev/reset
│   ├── firebase_services.py   # Firebase init, token verify, FirestoreUsageStore, MemoryUsageStore
│   └── config.py              # Env-based config: dev (emulator) vs prod (GCP)
├── frontend/                  # React + Vite
│   ├── src/
│   │   ├── App.tsx            # Shell — auth, chat, upload orchestration
│   │   ├── firebase.ts        # Firebase Auth SDK (emulator or prod via VITE_ vars)
│   │   ├── styles.css         # Apple design system (DESIGN.md tokens)
│   │   └── components/
│   │       ├── Sidebar.tsx    # Tenant select, auth chip, stats, quota bar
│   │       ├── ChatWindow.tsx # Message bubbles, citations, loading dots
│   │       └── UploadBar.tsx  # PDF upload (label-for-input pattern)
│   ├── index.html
│   ├── public/favicon.svg
│   ├── .env.development       # VITE_API_URL=http://127.0.0.1:8000 (auto-loaded by Vite)
│   └── .env.production        # VITE_API_URL=https://your-cloud-run-url (fill before deploy)
├── tests/
│   └── test_backend.py        # Pytest: tenant isolation, quota breaker, missing auth
├── scripts/
│   ├── start_emulators.ps1    # Firebase emulators (auto-sets JDK 21)
│   ├── start_backend.ps1      # FastAPI with .env.dev vars
│   ├── deploy_backend.ps1     # Cloud Run deploy via gcloud
│   └── simulate_quota.py      # 1,005-request quota circuit breaker test
├── docs/
│   ├── PRD.md                 # Product requirements
│   ├── plan.md                # Implementation phases
│   └── DESIGN.md              # Apple design system tokens (getdesign@latest)
├── .env                       # MCP/deploy secrets — gitignored
├── .env.dev                   # Backend dev vars (no secrets) — committed
├── .env.prod.example          # Backend prod template — committed
├── vite.config.ts             # Vite root=frontend, build outDir=dist
├── tsconfig.json
├── requirements.txt
├── firebase.json              # Emulator ports + hosting → dist/
├── firestore.rules
└── .firebaserc
```

## Architecture

```
React (Vite :5173)  →  FastAPI (:8000)  →  Firebase Auth emulator (:9099)
   VITE_API_URL ↑                       →  Firestore emulator (:8080) [quota]
                                        →  local_data/ [PDF uploads + index.json]
```

Production:
```
Firebase Hosting  →  Cloud Run (FastAPI)  →  Firebase Auth (prod)
                                          →  GCP Firestore [quota]
                                          →  Cloud Storage [PDFs]
                                          →  Vertex AI Search [RAG]
```

## Dev vs Prod Environment

| Layer | Dev | Prod |
|---|---|---|
| `RAGAAS_ENV` | `development` | `production` |
| Auth | Firebase emulator :9099 | Firebase Auth (prod) |
| Firestore | emulator :8080 | GCP Firestore |
| Storage | `local_data/` | GCS bucket |
| RAG | keyword mock | Vertex AI Search |
| API URL | `http://127.0.0.1:8000` | Cloud Run URL |
| CORS | `localhost/*` regex | prod domain only |

**Backend** reads vars from shell environment (load `.env.dev` or `.env.prod`).
**Frontend** reads `VITE_*` vars from `frontend/.env.development` or `frontend/.env.production` — Vite auto-selects by `NODE_ENV`.

## Running Locally

Three terminals required:
```powershell
# T1
.\scripts\start_emulators.ps1

# T2
.\scripts\start_backend.ps1

# T3
npm run dev
```

## Test Tenants

| Email | Token | Tenant ID |
|---|---|---|
| `demo@ragaas.local` | `mock-tenant-token-abc` | `tenant-demo` |
| `tenant-a@ragaas.local` | `tenant-a-token` | `tenant-a` |
| `tenant-b@ragaas.local` | `tenant-b-token` | `tenant-b` |

Password: `local-ragaas-password`

## Quota Circuit Breaker

Hard limit: **1,000 queries/tenant/day** in `FirestoreUsageStore` and `MemoryUsageStore`. Returns HTTP 429 on breach. Reset via `POST /api/dev/reset`.

## Upload Constraints

- PDF only, max 50 MB
- Stored under `local_data/uploads/{tenant_id}/{filename}`
- Tenant isolation at storage path AND index query level

## Slash Commands

| Command | Purpose |
|---|---|
| `/dev` | Start full local stack (all 3 services) |
| `/start-emulators` | Firebase emulators only |
| `/run-tests` | pytest backend tests |
| `/test-quota` | Circuit breaker simulation |
| `/verify-layout` | Playwright layout check on :5173 |
| `/deploy-backend` | Deploy to Cloud Run |
| `/health-check` | Connectivity check: backend, emulators, GCP ADC, frontend |
| `/reset-quota` | Reset tenant quotas via `POST /api/dev/reset` |
| `/api-smoke` | Full API smoke test — all endpoints |
| `/seed-dev` | Inject synthetic docs into `local_data/index.json` |

## MCP Servers

| Name | Package | Use |
|---|---|---|
| `github` | `@modelcontextprotocol/server-github` | Repo operations |
| `firebase` | `firebase-tools experimental:mcp` | Firestore, Auth, Hosting |
| `playwright` | `@playwright/mcp` | Browser automation / layout tests |
| `cloudrun` | `@google-cloud/cloud-run-mcp` | GCP Cloud Run deploy |
| `filesystem` | `@modelcontextprotocol/server-filesystem` | File ops scoped to project root |
| `memory` | `@modelcontextprotocol/server-memory` | Knowledge graph across tool calls |
| `fetch` | `@modelcontextprotocol/server-fetch` | HTTP testing |

Credentials in `.env` (gitignored). Run `firebase login:ci` → `FIREBASE_TOKEN`.

## Production GCP

- Project: `genaiacademy-496218`
- Region: `us-central1`
- Cloud Run: `ragaas-backend`
- ADC: `C:\Users\Saksham Tripathi\AppData\Roaming\gcloud\application_default_credentials.json`
