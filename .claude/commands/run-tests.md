---
description: Run the backend test suite (auth, quota, tenant isolation)
---

Run pytest — no emulators needed (uses in-memory store):

```powershell
python -m pytest tests/ -v
```

`RAGAAS_USE_MEMORY_STORE=1` is set inside `tests/test_backend.py` automatically.

Tests:
- `test_chat_is_tenant_scoped` — tenant A cannot read tenant B's docs
- `test_quota_breaker_blocks_after_limit` — HTTP 429 after 1,000 queries
- `test_missing_auth_is_rejected` — HTTP 401 with no bearer token
