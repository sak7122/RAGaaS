---
description: Smoke test all RAGaaS API endpoints — health, auth, upload, chat, quota, reset
---

Run a full smoke test of all API endpoints. Backend must be running on :8000. Use PowerShell `Invoke-RestMethod`.

**Test order:**

1. **Health check (no auth)**
```powershell
Invoke-RestMethod http://127.0.0.1:8000/api/health
```
Expect: `ok = true`

2. **Missing auth → 401**
```powershell
try { Invoke-RestMethod -Method POST http://127.0.0.1:8000/api/chat -Body '{"message":"test"}' -ContentType "application/json" } catch { $_.Exception.Response.StatusCode }
```
Expect: `401`

3. **Tenant status — tenant-demo**
```powershell
Invoke-RestMethod http://127.0.0.1:8000/api/tenant/status -Headers @{ Authorization = "Bearer mock-tenant-token-abc" }
```
Expect: `tenant_id = "tenant-demo"`, `query_limit = 1000`

4. **Tenant status — tenant-a**
```powershell
Invoke-RestMethod http://127.0.0.1:8000/api/tenant/status -Headers @{ Authorization = "Bearer tenant-a-token" }
```
Expect: `tenant_id = "tenant-a"`

5. **Chat with no documents**
```powershell
Invoke-RestMethod -Method POST http://127.0.0.1:8000/api/chat -Headers @{ Authorization = "Bearer tenant-a-token" } -Body '{"message":"hello world"}' -ContentType "application/json"
```
Expect: `answer` contains "cannot find", `citations = []`

6. **Quota reset**
```powershell
Invoke-RestMethod -Method POST http://127.0.0.1:8000/api/dev/reset
```
Expect: `ok = true`

7. **Invalid token → 403**
```powershell
try { Invoke-RestMethod http://127.0.0.1:8000/api/tenant/status -Headers @{ Authorization = "Bearer bad-token" } } catch { $_.Exception.Response.StatusCode }
```
Expect: `403`

Report each test as PASS/FAIL with actual vs expected. Flag any unexpected status codes.
