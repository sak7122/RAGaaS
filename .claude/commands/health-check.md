---
description: Check connectivity for all RAGaaS services — backend, Firebase emulators, GCP ADC, React frontend
---

Test connectivity for every layer of the stack. Run each check and report PASS/FAIL with port or error detail.

**1. FastAPI Backend (:8000)**
```powershell
Invoke-RestMethod http://127.0.0.1:8000/api/health
```
Expected: `{"ok":true,"mode":"local",...}`

**2. Firebase Auth Emulator (:9099)**
```powershell
Invoke-RestMethod http://127.0.0.1:9099 -ErrorAction SilentlyContinue
```

**3. Firestore Emulator (:8080)**
```powershell
Invoke-RestMethod http://127.0.0.1:8080 -ErrorAction SilentlyContinue
```

**4. Firebase Emulator UI (:4000)**
```powershell
Invoke-RestMethod http://127.0.0.1:4000 -ErrorAction SilentlyContinue
```

**5. React Frontend (:5173)**
```powershell
Invoke-RestMethod http://127.0.0.1:5173 -ErrorAction SilentlyContinue
```

**6. GCP ADC credentials**
```powershell
$f = "C:\Users\Saksham Tripathi\AppData\Roaming\gcloud\application_default_credentials.json"
if (Test-Path $f) { "ADC OK — $(((Get-Item $f).LastWriteTime))") } else { "ADC MISSING" }
```

**7. firebase-tools CLI**
```powershell
firebase --version
```

**8. gcloud CLI**
```powershell
gcloud --version
```

Print a summary table: service → status → note. If any service is down, print the exact start command to fix it.
