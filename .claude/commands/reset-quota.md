---
description: Reset all tenant query quotas via POST /api/dev/reset (backend must be running on :8000)
---

Reset all tenant query counters back to zero. Useful after quota circuit breaker testing.

```powershell
Invoke-RestMethod -Method POST http://127.0.0.1:8000/api/dev/reset
```

Expected response: `{"ok":true}`

After reset, verify tenant-demo quota is 0:
```powershell
Invoke-RestMethod http://127.0.0.1:8000/api/tenant/status -Headers @{ Authorization = "Bearer mock-tenant-token-abc" }
```

Expected: `queries_used` = 0

If backend is not running, start it first with `/dev`.
