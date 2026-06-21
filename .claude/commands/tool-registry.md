---
description: Inspect the action-layer tool registry and verify the approval/dry-run/idempotency gates
---

Audit the tool registry + executor (backend/tools.py) — the action layer. Verify the security gates hold before any real provider creds get wired.

**Checks:**

1. **List registered tools** — every tool in `create_tool_registry()` and its `ToolSpec`:
   - `name`, `outward` flag, `approver_roles`, `args_schema`.
   Confirm each outward tool (ticket/email/PR/doc) has `outward=True`.

2. **Allowlist enforced** — a `ToolCall` naming a tool NOT in the registry returns `rejected` with reason `"tool not in registry"`. No arbitrary tool can run.

3. **Approval gate** — for an `outward=True` tool:
   - `status="proposed"` → `rejected` (`"approval required"`).
   - `status="approved"` + `principal.role` NOT in `approver_roles` → `rejected`.
   - `status="approved"` + authorized role → `executed`.

4. **Dry-run default** — outside `RAGAAS_ENV=production` + `RAGAAS_TOOLS_LIVE=1`, `ToolExecutor.dry_run` is True. Handlers return `{"dry_run": true, ...}` and touch no external API. Confirm no live call path is reachable in dev.

5. **Idempotency** — replaying an executed `ToolCall` with the same `idempotency_key` is a no-op (`"idempotent replay"`), not a second side effect.

6. **Audit completeness** — every attempt (executed/failed/rejected) writes an `AuditEntry` scoped by `tenant_id`, storing `args_digest` (hash) NOT raw args.

Run the relevant slice of `tests/` if executor tests exist; otherwise inspect backend/tools.py directly. Report PASS/FAIL per gate. Any gate that can be bypassed is a release blocker — outward actions are irreversible.
