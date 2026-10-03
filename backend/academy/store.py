"""Academy system of record.

Dev/tests → MemoryAcademyStore
Prod      → SupabaseAcademyStore (PostgREST + Storage over httpx, service_role key)

Schema: supabase/migrations/0001_academy_schema.sql. RLS is on with no
policies, so the service_role key used here is the only way in — it must
never leave the backend.
"""
from __future__ import annotations

import logging
import os
import threading
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Protocol

import httpx

log = logging.getLogger("ragaas.academy")

# sensitivity / clearance levels (match the SQL check constraints)
PUBLIC, INTERNAL, RESTRICTED = 0, 1, 2


@dataclass(frozen=True)
class Entitlement:
    """What a learner may retrieve. Empty department/role = matches only
    untagged (tenant-wide) content. `unrestricted` skips tag checks (admins)."""
    clearance: int = PUBLIC
    department: str | None = None
    role: str | None = None
    unrestricted: bool = False


ADMIN_ENTITLEMENT = Entitlement(clearance=RESTRICTED, unrestricted=True)


@dataclass
class Learner:
    uid: str
    tenant_id: str
    email: str
    role: str | None = None
    department: str | None = None
    seniority: int = 1
    clearance: int = INTERNAL

    def entitlement(self) -> Entitlement:
        return Entitlement(self.clearance, self.department, self.role)


@dataclass
class KbDocument:
    id: str
    tenant_id: str
    title: str
    storage_path: str
    sensitivity: int = INTERNAL
    dept_tags: list[str] = field(default_factory=list)
    role_tags: list[str] = field(default_factory=list)
    owner_email: str | None = None
    updated_at: str = ""


class AcademyStore(Protocol):
    def ensure_tenant(self, tenant_id: str, name: str) -> None: ...
    def upload_file(self, path: str, content: bytes, mime: str) -> None: ...
    def add_document(self, doc: KbDocument) -> None: ...
    def list_documents(self, tenant_id: str) -> list[KbDocument]: ...
    def get_learner(self, tenant_id: str, uid: str) -> Learner | None: ...
    def upsert_learner(self, learner: Learner) -> None: ...
    def audit(self, tenant_id: str, actor: str, action: str, model: str | None = None) -> None: ...
    def ping(self) -> bool: ...


def new_doc_id() -> str:
    return str(uuid.uuid4())


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# ── Memory (dev / tests) ──────────────────────────────────────────────────────
class MemoryAcademyStore:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.tenants: dict[str, str] = {}
        self.files: dict[str, bytes] = {}
        self.docs: dict[str, KbDocument] = {}
        self.learners: dict[tuple[str, str], Learner] = {}
        self.audit_log: list[dict] = []

    def ensure_tenant(self, tenant_id: str, name: str) -> None:
        with self._lock:
            self.tenants.setdefault(tenant_id, name)

    def upload_file(self, path: str, content: bytes, mime: str) -> None:
        with self._lock:
            self.files[path] = content

    def add_document(self, doc: KbDocument) -> None:
        with self._lock:
            doc.updated_at = doc.updated_at or _now()
            self.docs[doc.id] = doc

    def list_documents(self, tenant_id: str) -> list[KbDocument]:
        with self._lock:
            return [d for d in self.docs.values() if d.tenant_id == tenant_id]

    def get_learner(self, tenant_id: str, uid: str) -> Learner | None:
        with self._lock:
            return self.learners.get((tenant_id, uid))

    def upsert_learner(self, learner: Learner) -> None:
        with self._lock:
            self.learners[(learner.tenant_id, learner.uid)] = learner

    def audit(self, tenant_id: str, actor: str, action: str, model: str | None = None) -> None:
        with self._lock:
            self.audit_log.append({"tenant_id": tenant_id, "actor": actor,
                                   "action": action, "model": model, "created_at": _now()})

    def ping(self) -> bool:
        return True

    def reset(self) -> None:
        with self._lock:
            self.tenants.clear(); self.files.clear(); self.docs.clear()
            self.learners.clear(); self.audit_log.clear()


# ── Supabase (prod) ───────────────────────────────────────────────────────────
class SupabaseAcademyStore:
    BUCKET = "kb"

    def __init__(self, url: str, service_key: str, timeout: float = 15.0) -> None:
        self._client = httpx.Client(
            base_url=url.rstrip("/"),
            timeout=timeout,
            headers={"apikey": service_key, "Authorization": f"Bearer {service_key}"},
        )

    def _rest(self, method: str, table: str, **kw) -> httpx.Response:
        r = self._client.request(method, f"/rest/v1/{table}", **kw)
        if r.status_code >= 400:
            # Body may echo request data; log status + table only.
            log.error("supabase %s %s -> %d", method, table, r.status_code)
            r.raise_for_status()
        return r

    def ensure_tenant(self, tenant_id: str, name: str) -> None:
        self._rest("POST", "tenants", json={"id": tenant_id, "name": name},
                   headers={"Prefer": "resolution=ignore-duplicates"})

    def upload_file(self, path: str, content: bytes, mime: str) -> None:
        r = self._client.post(f"/storage/v1/object/{self.BUCKET}/{path}", content=content,
                              headers={"Content-Type": mime, "x-upsert": "true"})
        if r.status_code >= 400:
            log.error("supabase storage upload -> %d", r.status_code)
            r.raise_for_status()

    def add_document(self, doc: KbDocument) -> None:
        self._rest("POST", "kb_documents", json={
            "id": doc.id, "tenant_id": doc.tenant_id, "title": doc.title,
            "storage_path": doc.storage_path, "sensitivity": doc.sensitivity,
            "dept_tags": doc.dept_tags, "role_tags": doc.role_tags,
            "owner_email": doc.owner_email,
        })

    def list_documents(self, tenant_id: str) -> list[KbDocument]:
        r = self._rest("GET", "kb_documents", params={
            "tenant_id": f"eq.{tenant_id}",
            "select": "id,tenant_id,title,storage_path,sensitivity,dept_tags,role_tags,owner_email,updated_at",
            "order": "updated_at.desc",
        })
        return [KbDocument(**row) for row in r.json()]

    def get_learner(self, tenant_id: str, uid: str) -> Learner | None:
        r = self._rest("GET", "learners", params={
            "uid": f"eq.{uid}", "tenant_id": f"eq.{tenant_id}",
            "select": "uid,tenant_id,email,role,department,seniority,clearance",
        })
        rows = r.json()
        return Learner(**rows[0]) if rows else None

    def upsert_learner(self, learner: Learner) -> None:
        self._rest("POST", "learners", json={
            "uid": learner.uid, "tenant_id": learner.tenant_id, "email": learner.email,
            "role": learner.role, "department": learner.department,
            "seniority": learner.seniority, "clearance": learner.clearance,
        }, headers={"Prefer": "resolution=merge-duplicates"})

    def audit(self, tenant_id: str, actor: str, action: str, model: str | None = None) -> None:
        try:
            self._rest("POST", "audit_log", json={"tenant_id": tenant_id, "actor": actor,
                                                  "action": action, "model": model})
        except Exception as exc:  # audit must never break the request path
            log.warning("audit write failed: %s", exc)

    def ping(self) -> bool:
        """Cheap query — also keeps a Free-tier project from pausing."""
        try:
            self._rest("GET", "tenants", params={"select": "id", "limit": "1"})
            return True
        except Exception:
            return False


def create_academy_store() -> AcademyStore:
    url, key = os.getenv("SUPABASE_URL", ""), os.getenv("SUPABASE_SERVICE_KEY", "")
    if url and key and os.getenv("RAGAAS_USE_MEMORY_STORE") != "1":
        log.info("academy store: supabase")
        return SupabaseAcademyStore(url, key)
    log.info("academy store: memory")
    return MemoryAcademyStore()
