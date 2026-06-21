---
description: Smoke test the /api/solve workflow endpoint — schema shape, grounding, tenant scoping
---

Smoke test the agentic workflow endpoint `/api/solve` (the WorkflowSolution contract in backend/workflow.py). Backend on :8000. Use PowerShell `Invoke-RestMethod`.

**Test order:**

1. **Solve with no documents → empty steps + open_questions**
```powershell
Invoke-RestMethod -Method POST http://127.0.0.1:8000/api/solve -Headers @{ Authorization = "Bearer tenant-a-token" } -Body '{"problem":"onboard a new backend engineer"}' -ContentType "application/json"
```
Expect: `steps = []`, `open_questions` non-empty, `confidence = 0`, `tenant_id = "tenant-a"`

2. **Missing auth → 401**
```powershell
try { Invoke-RestMethod -Method POST http://127.0.0.1:8000/api/solve -Body '{"problem":"x"}' -ContentType "application/json" } catch { $_.Exception.Response.StatusCode }
```
Expect: `401`

3. **Schema validity** — response has keys: `problem, steps, open_questions, confidence, tenant_id, queries_used, query_limit`. Each step (when present) has `n, action, rationale, sources`. Any `suggested_tool_call` has `requires_approval = true` and `status = "proposed"`.

4. **Tenant scoping** — upload a doc to tenant-a (`/api/upload`), solve the same problem for tenant-b, confirm tenant-b's `sources` never reference tenant-a's file.

5. **Quota shared with chat** — `/api/solve` calls `enforce_quota`; confirm `queries_used` increments and 429 fires at the 1,000 limit (same breaker as `/api/chat`).

Report each as PASS/FAIL with actual vs expected. Flag any step whose `action` has empty `sources` AND no matching `open_questions` entry — that's an ungrounded (hallucinated) step, the key failure mode.
