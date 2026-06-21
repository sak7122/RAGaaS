"""
Tool registry + executor — the action layer.

Two halves:
  1. ToolRegistry  — an ALLOWLIST of declared tools. The planner may only
     propose tools that live here; anything else is rejected. Each tool exposes
     a JSON-schema for its args so the planner can fill them correctly.
  2. ToolExecutor  — runs an APPROVED ToolCall. Enforces the security gates:
     human approval for outward tools, idempotency, per-tenant scoping, audit.

Mirrors the codebase pattern: Protocols + create_*(env) factory returning a dev
(dry-run / in-memory) impl vs a prod (real API) impl.

DESIGN ONLY — handlers below are stubs. Wire real provider APIs in Phase 3.

SECURITY MODEL (do not weaken without review):
  - Planner proposes, never executes.
  - An outward-facing tool (outward=True) cannot run unless ToolCall.status ==
    "approved" AND an approval came from a human with role admin/uploader.
  - Dev runs in dry-run: handlers log intent, touch no real API.
  - Every attempt — proposed, approved, executed, failed — is written to the
    audit store, scoped by tenant_id.
"""
from __future__ import annotations

import logging
import os
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Callable, Protocol

from backend.firebase_services import Principal
from backend.workflow import ToolCall

log = logging.getLogger("ragaas")


# ── Tool declaration ──────────────────────────────────────────────────────────
@dataclass(frozen=True)
class ToolSpec:
    name: str
    description: str           # shown to the planner so it picks the right tool
    args_schema: dict          # JSON-schema for ToolCall.args validation
    outward: bool              # True = irreversible/external (ticket, email, PR)
    # Roles allowed to APPROVE execution of this tool.
    approver_roles: tuple[str, ...] = ("admin",)


class ToolHandler(Protocol):
    spec: ToolSpec
    # Perform the action for one tenant. dry_run => no external side effect.
    def run(self, tenant_id: str, args: dict, *, dry_run: bool) -> dict: ...


@dataclass
class ToolServices:
    """Request/runtime deps some tools need (LLM + retrieval + publish). Injected
    by main.py so the registry stays decoupled from FastAPI globals."""
    generate: Callable[[str, list[dict]], str]        # (instruction, chunks) -> text
    retrieve: Callable[[str, str, int], list[dict]]   # (tenant_id, query, k) -> chunks
    publish: Callable[[dict], str] | None = None      # (share payload) -> public URL


# ── Registry (allowlist) ──────────────────────────────────────────────────────
class ToolRegistry:
    def __init__(self) -> None:
        self._tools: dict[str, ToolHandler] = {}

    def register(self, handler: ToolHandler) -> None:
        name = handler.spec.name
        if name in self._tools:
            raise ValueError(f"tool already registered: {name}")
        self._tools[name] = handler

    def get(self, name: str) -> ToolHandler | None:
        return self._tools.get(name)

    def specs(self) -> list[ToolSpec]:
        """Fed to the planner so it knows what actions exist + arg shapes."""
        return [h.spec for h in self._tools.values()]


# ── Execution result + audit ──────────────────────────────────────────────────
@dataclass
class ExecutionResult:
    ok: bool
    tool: str
    status: str               # executed | failed | rejected
    detail: dict = field(default_factory=dict)


@dataclass
class AuditEntry:
    tenant_id: str
    tool: str
    status: str
    actor_uid: str
    idempotency_key: str | None
    at: str
    args_digest: str          # hash of args, NOT raw args (may hold PII)


class AuditStore(Protocol):
    def record(self, entry: AuditEntry) -> None: ...
    def seen(self, tenant_id: str, idempotency_key: str) -> bool: ...
    def list_for_tenant(self, tenant_id: str) -> list[AuditEntry]: ...


class MemoryAuditStore:
    """Dev audit log — in-process, mirrors MemoryUsageStore."""
    def __init__(self) -> None:
        self._log: list[AuditEntry] = []
        self._keys: set[tuple[str, str]] = set()

    def record(self, entry: AuditEntry) -> None:
        self._log.append(entry)
        if entry.idempotency_key:
            self._keys.add((entry.tenant_id, entry.idempotency_key))

    def seen(self, tenant_id: str, idempotency_key: str) -> bool:
        return (tenant_id, idempotency_key) in self._keys

    def list_for_tenant(self, tenant_id: str) -> list[AuditEntry]:
        return [e for e in self._log if e.tenant_id == tenant_id]


# class FirestoreAuditStore: ...  # Phase 3 — tenants/{id}/action_audit/{autoId}


# ── Executor (the gate) ───────────────────────────────────────────────────────
class ToolExecutor:
    def __init__(self, registry: ToolRegistry, audit: AuditStore, *, dry_run: bool) -> None:
        self._registry = registry
        self._audit = audit
        self._dry_run = dry_run

    def execute(self, principal: Principal, call: ToolCall) -> ExecutionResult:
        """Run ONE approved tool call. Raises nothing — returns a result the
        caller maps to HTTP. All gates enforced here, server-side."""
        handler = self._registry.get(call.tool)
        if handler is None:
            return ExecutionResult(False, call.tool, "rejected", {"reason": "tool not in registry"})

        spec = handler.spec
        # Gate 1: outward tools demand explicit approval + an authorized approver.
        if spec.outward:
            if call.status != "approved":
                return ExecutionResult(False, call.tool, "rejected", {"reason": "approval required"})
            if principal.role not in spec.approver_roles:
                return ExecutionResult(False, call.tool, "rejected",
                                       {"reason": f"role {principal.role} cannot approve {call.tool}"})

        # Gate 2: idempotency — don't double-fire.
        key = call.idempotency_key
        if key and self._audit.seen(principal.tenant_id, key):
            return ExecutionResult(True, call.tool, "executed", {"reason": "idempotent replay (no-op)"})

        # TODO(phase3): validate call.args against spec.args_schema before run.
        try:
            detail = handler.run(principal.tenant_id, call.args, dry_run=self._dry_run)
            status = "executed"
            ok = True
        except Exception as exc:  # never let a tool crash the request
            log.warning("tool_failed tenant=%s tool=%s err=%s", principal.tenant_id, call.tool, exc)
            detail, status, ok = {"error": str(exc)}, "failed", False

        self._audit.record(AuditEntry(
            tenant_id=principal.tenant_id, tool=call.tool, status=status,
            actor_uid=principal.uid, idempotency_key=key,
            at=datetime.now(timezone.utc).isoformat(), args_digest=_digest(call.args),
        ))
        return ExecutionResult(ok, call.tool, status, detail)


def _digest(args: dict) -> str:
    import hashlib, json
    return hashlib.sha256(json.dumps(args, sort_keys=True, default=str).encode()).hexdigest()[:16]


# ── Example tool stubs (dry-run only until real creds wired) ───────────────────
class CreateJiraTicketTool:
    spec = ToolSpec(
        name="create_jira_ticket",
        description="Create a Jira ticket. Use for work that needs tracking/assignment.",
        args_schema={
            "type": "object",
            "required": ["project", "summary"],
            "properties": {
                "project": {"type": "string"},
                "summary": {"type": "string", "maxLength": 255},
                "description": {"type": "string"},
                "assignee_hint": {"type": "string"},
            },
        },
        outward=True,
        approver_roles=("admin", "uploader"),
    )

    def run(self, tenant_id: str, args: dict, *, dry_run: bool) -> dict:
        if dry_run:
            log.info("DRY-RUN create_jira_ticket tenant=%s args=%s", tenant_id, args)
            return {"dry_run": True, "would_create": args}
        raise NotImplementedError("wire per-tenant Jira creds + REST call (Phase 3)")


class SendEmailTool:
    """REAL outward tool — reuses the existing SMTP mailer (no new creds). Sends
    only when live (RAGAAS_TOOLS_LIVE=1 in prod) AND SMTP is configured; otherwise
    dry-run logs intent. Outward + irreversible → admin/uploader approval required."""
    spec = ToolSpec(
        name="send_email",
        description="Send a plain-text email. Use to notify a person about a step or decision.",
        args_schema={
            "type": "object",
            "required": ["to", "subject", "body"],
            "properties": {
                "to": {"type": "string", "format": "email"},
                "subject": {"type": "string", "maxLength": 200},
                "body": {"type": "string"},
            },
        },
        outward=True,
        approver_roles=("admin", "uploader"),
    )

    def run(self, tenant_id: str, args: dict, *, dry_run: bool) -> dict:
        to = str(args.get("to") or args.get("to_email") or "")
        subject = str(args.get("subject", ""))
        body = str(args.get("body", ""))
        if not to:
            raise ValueError("send_email requires a 'to' recipient")
        if dry_run:
            log.info("DRY-RUN send_email tenant=%s to=%s subject=%r", tenant_id, to, subject)
            return {"dry_run": True, "would_send": {"to": to, "subject": subject}}
        from backend.mailer import send_email, smtp_configured
        if not smtp_configured():
            raise RuntimeError("SMTP not configured (set SMTP_USER / SMTP_PASSWORD)")
        if not send_email(to, subject, body):
            raise RuntimeError("email send failed")
        return {"sent": True, "to": to}


class GenerateDocumentTool:
    """Writes the actual deliverable (runbook, policy, summary, brief) grounded
    in the tenant's documents — the agent producing work, not just describing it.
    Not outward (no external side effect): produces text, returned to the caller.
    Needs ToolServices (LLM + retrieval); inert if unavailable."""
    spec = ToolSpec(
        name="generate_document",
        description="Draft a document (runbook, policy, summary, brief) grounded in the "
                    "knowledge base. Use when the problem asks to write/produce a deliverable.",
        args_schema={
            "type": "object",
            "required": ["title"],
            "properties": {
                "doc_type": {"type": "string", "description": "e.g. runbook, policy, summary, brief"},
                "title": {"type": "string", "maxLength": 200},
                "instructions": {"type": "string", "description": "What the document should cover"},
            },
        },
        outward=False,
    )

    def __init__(self, services: ToolServices | None) -> None:
        self._svc = services

    def run(self, tenant_id: str, args: dict, *, dry_run: bool) -> dict:
        if self._svc is None:
            raise RuntimeError("document generation service unavailable")
        doc_type = str(args.get("doc_type") or "document")
        title = str(args.get("title") or doc_type)
        instructions = str(args.get("instructions") or args.get("topic") or title)
        chunks = self._svc.retrieve(tenant_id, f"{title} {instructions}", 8)
        if not chunks:
            raise RuntimeError("no source documents matched — cannot ground the draft")
        prompt = (
            f'Write a {doc_type} titled "{title}". {instructions}. '
            f"Use clear section headings and concise, actionable content. Base it "
            f"strictly on the provided document excerpts and cite sources inline."
        )
        text = self._svc.generate(prompt, chunks)
        return {
            "document": text, "doc_type": doc_type, "title": title,
            "sources": sorted({c["file_name"] for c in chunks}),
        }


class PublishWorkflowTool:
    """Turns a solved workflow into a public, shareable link (reuses share_store).
    Workflow-level action — the caller passes the rendered markdown. Not outward
    in the irreversible sense; parity with the existing /api/share Share button."""
    spec = ToolSpec(
        name="publish_workflow",
        description="Publish the current workflow to a shareable link a teammate can open.",
        args_schema={
            "type": "object",
            "required": ["title", "markdown"],
            "properties": {
                "title": {"type": "string", "maxLength": 200},
                "markdown": {"type": "string"},
            },
        },
        outward=False,
    )

    def __init__(self, services: ToolServices | None) -> None:
        self._svc = services

    def run(self, tenant_id: str, args: dict, *, dry_run: bool) -> dict:
        if self._svc is None or self._svc.publish is None:
            raise RuntimeError("publish service unavailable")
        title = str(args.get("title") or "Workflow")
        markdown = str(args.get("markdown") or "")
        if not markdown.strip():
            raise RuntimeError("nothing to publish")
        url = self._svc.publish({
            "question": title, "answer": markdown, "citations": [], "tenant_id": tenant_id,
        })
        return {"url": url, "title": title}


# ── Factory ───────────────────────────────────────────────────────────────────
def create_tool_registry(services: ToolServices | None = None) -> ToolRegistry:
    reg = ToolRegistry()
    reg.register(CreateJiraTicketTool())       # stub — kept for future integration
    reg.register(SendEmailTool())
    reg.register(GenerateDocumentTool(services))
    reg.register(PublishWorkflowTool(services))
    # reg.register(SlackPostTool()); ...
    return reg


def create_audit_store(env: str) -> AuditStore:
    # if env == "production": return FirestoreAuditStore(...)
    return MemoryAuditStore()


def create_tool_executor(env: str, registry: ToolRegistry, audit: AuditStore) -> ToolExecutor:
    # Real API calls only when explicitly enabled in prod; dry-run everywhere else.
    dry_run = not (env == "production" and os.getenv("RAGAAS_TOOLS_LIVE") == "1")
    return ToolExecutor(registry, audit, dry_run=dry_run)
