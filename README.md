# RAGaaS

Local-first RAG-as-a-Service sandbox.

## Run

```powershell
firebase emulators:start
```

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
$env:FIREBASE_PROJECT_ID = "ragaas-local"
$env:FIREBASE_AUTH_EMULATOR_HOST = "127.0.0.1:9099"
$env:FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080"
uvicorn main:app --reload --host 127.0.0.1 --port 8000
```

```powershell
npm install
npm run dev
```

Frontend: `http://127.0.0.1:5173`  
Backend: `http://127.0.0.1:8000`

## Local Auth

Frontend signs into the Firebase Auth emulator using local email/password accounts:

- `demo@ragaas.local` -> `tenant-demo`
- `tenant-a@ragaas.local` -> `tenant-a`
- `tenant-b@ragaas.local` -> `tenant-b`

Legacy backend test tokens still work:

- `mock-tenant-token-abc` -> `tenant-demo`
- `tenant-a-token` -> `tenant-a`
- `tenant-b-token` -> `tenant-b`

## Implemented

- FastAPI local backend.
- Firebase Auth emulator ID token verification.
- Firestore emulator quota counters.
- Tenant isolation.
- PDF upload with 50 MB cap.
- Local PDF text extraction and mock RAG citations.
- 1,000-query circuit breaker with HTTP 429.
- React dashboard/chat UI.
- Firebase emulator config for Auth, Firestore, Hosting.
- Backend tests for auth, quota, tenant isolation.
