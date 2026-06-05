---
description: Start full local dev stack (Firebase emulators + FastAPI backend + React frontend)
---

Start the RAGaaS local development stack in 3 separate terminals:

**Terminal 1 — Firebase Emulators** (Auth :9099, Firestore :8080, UI :4000):
```powershell
.\scripts\start_emulators.ps1
```

**Terminal 2 — FastAPI Backend** (:8000):
```powershell
.\scripts\start_backend.ps1
```
Or manually with dev env vars:
```powershell
$env:RAGAAS_ENV="development"; $env:FIREBASE_PROJECT_ID="ragaas-local"; $env:FIREBASE_AUTH_EMULATOR_HOST="127.0.0.1:9099"; $env:FIRESTORE_EMULATOR_HOST="127.0.0.1:8080"
.\.venv\Scripts\uvicorn.exe main:app --reload --host 127.0.0.1 --port 8000
```

**Terminal 3 — React Frontend** (:5173):
```powershell
npm run dev
```
Vite reads `frontend/.env.development` automatically — sets `VITE_API_URL=http://127.0.0.1:8000`.

Open http://127.0.0.1:5173 after all 3 are up.
