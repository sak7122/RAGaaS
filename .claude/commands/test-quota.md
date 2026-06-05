---
description: Simulate 1,005 requests to verify the quota circuit breaker fires HTTP 429 at 1,000
---

Run the quota circuit breaker simulation against the local FastAPI backend.
Requires the backend running on http://127.0.0.1:8000.

```powershell
python scripts\simulate_quota.py
```

What it does:
- Sends 1,005 POST requests to `/api/chat` with mock tenant token
- Expects HTTP 200 for the first 1,000 requests
- Expects HTTP 429 for requests 1,001+
- Prints a pass/fail summary

Reset the backend quota counter first if needed:
```powershell
Invoke-RestMethod -Method POST http://127.0.0.1:8000/api/dev/reset
```
