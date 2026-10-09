"""Academy system of record.

Dev/tests → MemoryAcademyStore
Prod      → SupabaseAcademyStore (PostgREST + Storage over httpx, service_role key)

Schema: supabase/migrations/0001_academy_schema.sql + 0002_academy_m1_m2.sql.
RLS is on with no policies, so the service_role key used here is the only way
in — it must never leave the backend. Every method is tenant-scoped: callers
pass the tenant, and every query filters on it.
"""
from __future__ import annotations

import copy
import logging
import os
import threading
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Any, Protocol

import httpx

log = logging.getLogger("ragaas.academy")

# sensitivity / clearance levels (match the SQL check constraints)
PUBLIC, INTERNAL, RESTRICTED = 0, 1, 2
PENDING_PREFIX = "email:"   # learners imported before they sign up


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
    name: str | None = None

    def entitlement(self) -> Entitlement:
        return Entitlement(self.clearance, self.department, self.role)

    @property
    def pending(self) -> bool:
        return self.uid.startswith(PENDING_PREFIX)


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
    version: int = 1
    content_hash: str | None = None


@dataclass
class Path:
    id: str
    tenant_id: str
    title: str
    rules: dict[str, Any] = field(default_factory=dict)   # target dept / role / clearance / module_count
    pass_mark: float = 0.8
    status: str = "generating"                              # generating|failed|draft|published|stale
    error: str | None = None
    created_at: str = ""
    updated_at: str = ""


@dataclass
class Module:
    id: str
    tenant_id: str
    path_id: str
    position: int
    title: str
    lesson_md: str = ""
    source_doc_ids: list[str] = field(default_factory=list)
    status: str = "draft"


@dataclass
class Item:
    id: str
    tenant_id: str
    module_id: str
    type: str                     # mcq | true_false | short_answer | scenario
    stem: str
    options: list[str] | None = None
    answer: Any = None            # mcq: option index · true_false: bool · free text: None
    explanation: str | None = None
    source_doc_ids: list[str] = field(default_factory=list)
    difficulty: int = 2
    status: str = "draft"
    rubric: str | None = None     # short_answer / scenario: points a correct answer must cover


@dataclass
class Assignment:
    tenant_id: str
    learner_uid: str
    path_id: str
    status: str = "assigned"      # assigned | in_progress | passed | certified
    score: float | None = None
    started_at: str | None = None
    completed_at: str | None = None
    assigned_at: str | None = None
    due_at: str | None = None
    certified_at: str | None = None
    certified_by: str | None = None


@dataclass
class KnowledgeGap:
    """A question the knowledge base couldn't answer: tells admins what to document."""
    tenant_id: str
    learner_uid: str
    question: str
    created_at: str = ""


@dataclass
class Attempt:
    tenant_id: str
    learner_uid: str
    item_id: str
    module_id: str
    response: Any
    score: float
    feedback: str | None = None
    graded_by_model: str | None = None


@dataclass
class ModuleProgress:
    tenant_id: str
    learner_uid: str
    module_id: str
    path_id: str
    best_score: float = 0.0
    last_score: float = 0.0
    passed: bool = False
    attempts: int = 0
    completed_at: str | None = None
    updated_at: str = ""


@dataclass
class ReviewEntry:
    tenant_id: str
    learner_uid: str
    module_id: str
    due_at: str
    interval_days: int = 1


class AcademyStore(Protocol):
    # tenants / files / audit
    def ensure_tenant(self, tenant_id: str, name: str) -> None: ...
    def upload_file(self, path: str, content: bytes, mime: str) -> None: ...
    def delete_file(self, path: str) -> None: ...
    def audit(self, tenant_id: str, actor: str, action: str, model: str | None = None) -> None: ...
    def ping(self) -> bool: ...
    # documents
    def add_document(self, doc: KbDocument) -> None: ...
    def update_document(self, doc: KbDocument) -> None: ...
    def get_document(self, tenant_id: str, doc_id: str) -> KbDocument | None: ...
    def find_document_by_title(self, tenant_id: str, title: str) -> KbDocument | None: ...
    def list_documents(self, tenant_id: str) -> list[KbDocument]: ...
    def delete_document(self, tenant_id: str, doc_id: str) -> KbDocument | None: ...
    def mark_stale_for_doc(self, tenant_id: str, doc_id: str) -> int: ...
    # learners
    def get_learner(self, tenant_id: str, uid: str) -> Learner | None: ...
    def get_learner_by_email(self, tenant_id: str, email: str) -> Learner | None: ...
    def upsert_learner(self, learner: Learner) -> None: ...
    def rekey_learner(self, tenant_id: str, old_uid: str, new_uid: str) -> None: ...
    def list_learners(self, tenant_id: str) -> list[Learner]: ...
    def delete_learner(self, tenant_id: str, uid: str) -> bool: ...
    # paths / modules / items
    def create_path(self, path: Path) -> None: ...
    def update_path(self, path: Path) -> None: ...
    def get_path(self, tenant_id: str, path_id: str) -> Path | None: ...
    def list_paths(self, tenant_id: str) -> list[Path]: ...
    def delete_path(self, tenant_id: str, path_id: str) -> bool: ...
    def add_module(self, module: Module) -> None: ...
    def update_module(self, module: Module) -> None: ...
    def get_module(self, tenant_id: str, module_id: str) -> Module | None: ...
    def list_modules(self, tenant_id: str, path_id: str) -> list[Module]: ...
    def add_item(self, item: Item) -> None: ...
    def update_item(self, item: Item) -> None: ...
    def get_item(self, tenant_id: str, item_id: str) -> Item | None: ...
    def delete_item(self, tenant_id: str, item_id: str) -> bool: ...
    def list_items(self, tenant_id: str, module_ids: list[str]) -> list[Item]: ...
    # learner progress (M3)
    def get_assignment(self, tenant_id: str, uid: str, path_id: str) -> Assignment | None: ...
    def list_assignments(self, tenant_id: str, uid: str | None = None) -> list[Assignment]: ...
    def upsert_assignment(self, a: Assignment) -> None: ...
    def add_attempts(self, attempts: list[Attempt]) -> None: ...
    def list_attempt_scores(self, tenant_id: str) -> list[tuple[str, float]]: ...
    def get_progress(self, tenant_id: str, uid: str, module_id: str) -> ModuleProgress | None: ...
    def list_progress(self, tenant_id: str, uid: str | None = None) -> list[ModuleProgress]: ...
    def upsert_progress(self, p: ModuleProgress) -> None: ...
    def get_review(self, tenant_id: str, uid: str, module_id: str) -> ReviewEntry | None: ...
    def list_reviews(self, tenant_id: str, uid: str) -> list[ReviewEntry]: ...
    def upsert_review(self, r: ReviewEntry) -> None: ...
    def delete_review(self, tenant_id: str, uid: str, module_id: str) -> None: ...
    # dashboards (M4)
    def add_gap(self, gap: KnowledgeGap) -> None: ...
    def list_gaps(self, tenant_id: str, limit: int = 500) -> list[KnowledgeGap]: ...


def new_id() -> str:
    return str(uuid.uuid4())


new_doc_id = new_id


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ── Memory (dev / tests) ──────────────────────────────────────────────────────
class MemoryAcademyStore:
    def __init__(self) -> None:
        self._lock = threading.RLock()
        self.reset()

    def reset(self) -> None:
        with self._lock:
            self.tenants: dict[str, str] = {}
            self.files: dict[str, bytes] = {}
            self.docs: dict[str, KbDocument] = {}
            self.learners: dict[tuple[str, str], Learner] = {}
            self.paths: dict[str, Path] = {}
            self.modules: dict[str, Module] = {}
            self.items: dict[str, Item] = {}
            self.audit_log: list[dict] = []
            self.assignments: dict[tuple[str, str, str], Assignment] = {}   # (tenant, uid, path)
            self.attempts: list[Attempt] = []
            self.progress: dict[tuple[str, str, str], ModuleProgress] = {}  # (tenant, uid, module)
            self.reviews: dict[tuple[str, str, str], ReviewEntry] = {}      # (tenant, uid, module)
            self.gaps: list[KnowledgeGap] = []

    # tenants / files / audit
    def ensure_tenant(self, tenant_id: str, name: str) -> None:
        with self._lock:
            self.tenants.setdefault(tenant_id, name)

    def upload_file(self, path: str, content: bytes, mime: str) -> None:
        with self._lock:
            self.files[path] = content

    def delete_file(self, path: str) -> None:
        with self._lock:
            self.files.pop(path, None)

    def audit(self, tenant_id: str, actor: str, action: str, model: str | None = None) -> None:
        with self._lock:
            self.audit_log.append({"tenant_id": tenant_id, "actor": actor,
                                   "action": action, "model": model, "created_at": now_iso()})

    def ping(self) -> bool:
        return True

    # documents
    def add_document(self, doc: KbDocument) -> None:
        with self._lock:
            doc.updated_at = doc.updated_at or now_iso()
            self.docs[doc.id] = copy.deepcopy(doc)

    def update_document(self, doc: KbDocument) -> None:
        with self._lock:
            doc.updated_at = now_iso()
            self.docs[doc.id] = copy.deepcopy(doc)

    def get_document(self, tenant_id: str, doc_id: str) -> KbDocument | None:
        with self._lock:
            d = self.docs.get(doc_id)
            return copy.deepcopy(d) if d and d.tenant_id == tenant_id else None

    def find_document_by_title(self, tenant_id: str, title: str) -> KbDocument | None:
        with self._lock:
            for d in self.docs.values():
                if d.tenant_id == tenant_id and d.title == title:
                    return copy.deepcopy(d)
            return None

    def list_documents(self, tenant_id: str) -> list[KbDocument]:
        with self._lock:
            return [copy.deepcopy(d) for d in self.docs.values() if d.tenant_id == tenant_id]

    def delete_document(self, tenant_id: str, doc_id: str) -> KbDocument | None:
        with self._lock:
            d = self.docs.get(doc_id)
            if not d or d.tenant_id != tenant_id:
                return None
            return self.docs.pop(doc_id)

    def mark_stale_for_doc(self, tenant_id: str, doc_id: str) -> int:
        with self._lock:
            n, path_ids = 0, set()
            for m in self.modules.values():
                if m.tenant_id == tenant_id and doc_id in m.source_doc_ids:
                    m.status = "stale"; n += 1; path_ids.add(m.path_id)
            for it in self.items.values():
                if it.tenant_id == tenant_id and doc_id in it.source_doc_ids:
                    it.status = "stale"; n += 1
                    mod = self.modules.get(it.module_id)
                    if mod:
                        path_ids.add(mod.path_id)
            for pid in path_ids:
                p = self.paths.get(pid)
                if p and p.status in ("draft", "published"):
                    p.status = "stale"
            return n

    # learners
    def get_learner(self, tenant_id: str, uid: str) -> Learner | None:
        with self._lock:
            lr = self.learners.get((tenant_id, uid))
            return copy.deepcopy(lr) if lr else None

    def get_learner_by_email(self, tenant_id: str, email: str) -> Learner | None:
        with self._lock:
            for (t, _), lr in self.learners.items():
                if t == tenant_id and lr.email.lower() == email.lower():
                    return copy.deepcopy(lr)
            return None

    def upsert_learner(self, learner: Learner) -> None:
        with self._lock:
            for key, lr in list(self.learners.items()):   # unique (tenant, email)
                if key[0] == learner.tenant_id and lr.email.lower() == learner.email.lower() \
                        and lr.uid != learner.uid:
                    del self.learners[key]
            self.learners[(learner.tenant_id, learner.uid)] = copy.deepcopy(learner)

    def rekey_learner(self, tenant_id: str, old_uid: str, new_uid: str) -> None:
        with self._lock:
            lr = self.learners.pop((tenant_id, old_uid), None)
            if lr:
                lr.uid = new_uid
                self.learners[(tenant_id, new_uid)] = lr

    def list_learners(self, tenant_id: str) -> list[Learner]:
        with self._lock:
            return [copy.deepcopy(lr) for (t, _), lr in self.learners.items() if t == tenant_id]

    def delete_learner(self, tenant_id: str, uid: str) -> bool:
        with self._lock:
            for table in (self.assignments, self.progress, self.reviews):
                for key in [k for k in table if k[:2] == (tenant_id, uid)]:
                    del table[key]
            self.attempts = [a for a in self.attempts
                             if (a.tenant_id, a.learner_uid) != (tenant_id, uid)]
            return self.learners.pop((tenant_id, uid), None) is not None

    # paths / modules / items
    def create_path(self, path: Path) -> None:
        with self._lock:
            path.created_at = path.updated_at = now_iso()
            self.paths[path.id] = copy.deepcopy(path)

    def update_path(self, path: Path) -> None:
        with self._lock:
            path.updated_at = now_iso()
            self.paths[path.id] = copy.deepcopy(path)

    def get_path(self, tenant_id: str, path_id: str) -> Path | None:
        with self._lock:
            p = self.paths.get(path_id)
            return copy.deepcopy(p) if p and p.tenant_id == tenant_id else None

    def list_paths(self, tenant_id: str) -> list[Path]:
        with self._lock:
            return sorted((copy.deepcopy(p) for p in self.paths.values() if p.tenant_id == tenant_id),
                          key=lambda p: p.created_at, reverse=True)

    def delete_path(self, tenant_id: str, path_id: str) -> bool:
        with self._lock:
            p = self.paths.get(path_id)
            if not p or p.tenant_id != tenant_id:
                return False
            del self.paths[path_id]
            mods = [m.id for m in self.modules.values() if m.path_id == path_id]
            for mid in mods:
                del self.modules[mid]
            for iid in [i.id for i in self.items.values() if i.module_id in mods]:
                del self.items[iid]
            for key in [k for k in self.assignments if k[2] == path_id]:
                del self.assignments[key]
            for table in (self.progress, self.reviews):
                for key in [k for k in table if k[2] in mods]:
                    del table[key]
            self.attempts = [a for a in self.attempts if a.module_id not in mods]
            return True

    def add_module(self, module: Module) -> None:
        with self._lock:
            self.modules[module.id] = copy.deepcopy(module)

    update_module = add_module

    def get_module(self, tenant_id: str, module_id: str) -> Module | None:
        with self._lock:
            m = self.modules.get(module_id)
            return copy.deepcopy(m) if m and m.tenant_id == tenant_id else None

    def list_modules(self, tenant_id: str, path_id: str) -> list[Module]:
        with self._lock:
            return sorted((copy.deepcopy(m) for m in self.modules.values()
                           if m.tenant_id == tenant_id and m.path_id == path_id),
                          key=lambda m: m.position)

    def add_item(self, item: Item) -> None:
        with self._lock:
            self.items[item.id] = copy.deepcopy(item)

    update_item = add_item

    def get_item(self, tenant_id: str, item_id: str) -> Item | None:
        with self._lock:
            it = self.items.get(item_id)
            return copy.deepcopy(it) if it and it.tenant_id == tenant_id else None

    def delete_item(self, tenant_id: str, item_id: str) -> bool:
        with self._lock:
            it = self.items.get(item_id)
            if not it or it.tenant_id != tenant_id:
                return False
            del self.items[item_id]
            self.attempts = [a for a in self.attempts if a.item_id != item_id]
            return True

    def list_items(self, tenant_id: str, module_ids: list[str]) -> list[Item]:
        with self._lock:
            return [copy.deepcopy(i) for i in self.items.values()
                    if i.tenant_id == tenant_id and i.module_id in module_ids]

    # learner progress (M3)
    def get_assignment(self, tenant_id: str, uid: str, path_id: str) -> Assignment | None:
        with self._lock:
            a = self.assignments.get((tenant_id, uid, path_id))
            return copy.deepcopy(a) if a else None

    def list_assignments(self, tenant_id: str, uid: str | None = None) -> list[Assignment]:
        with self._lock:
            return [copy.deepcopy(a) for k, a in self.assignments.items()
                    if k[0] == tenant_id and (uid is None or k[1] == uid)]

    def upsert_assignment(self, a: Assignment) -> None:
        with self._lock:
            self.assignments[(a.tenant_id, a.learner_uid, a.path_id)] = copy.deepcopy(a)

    def add_attempts(self, attempts: list[Attempt]) -> None:
        with self._lock:
            self.attempts.extend(copy.deepcopy(a) for a in attempts)

    def list_attempt_scores(self, tenant_id: str) -> list[tuple[str, float]]:
        with self._lock:
            return [(a.item_id, a.score) for a in self.attempts if a.tenant_id == tenant_id]

    def get_progress(self, tenant_id: str, uid: str, module_id: str) -> ModuleProgress | None:
        with self._lock:
            p = self.progress.get((tenant_id, uid, module_id))
            return copy.deepcopy(p) if p else None

    def list_progress(self, tenant_id: str, uid: str | None = None) -> list[ModuleProgress]:
        with self._lock:
            return [copy.deepcopy(p) for k, p in self.progress.items()
                    if k[0] == tenant_id and (uid is None or k[1] == uid)]

    def upsert_progress(self, p: ModuleProgress) -> None:
        with self._lock:
            p.updated_at = now_iso()
            self.progress[(p.tenant_id, p.learner_uid, p.module_id)] = copy.deepcopy(p)

    def get_review(self, tenant_id: str, uid: str, module_id: str) -> ReviewEntry | None:
        with self._lock:
            r = self.reviews.get((tenant_id, uid, module_id))
            return copy.deepcopy(r) if r else None

    def list_reviews(self, tenant_id: str, uid: str) -> list[ReviewEntry]:
        with self._lock:
            return [copy.deepcopy(r) for k, r in self.reviews.items() if k[:2] == (tenant_id, uid)]

    def upsert_review(self, r: ReviewEntry) -> None:
        with self._lock:
            self.reviews[(r.tenant_id, r.learner_uid, r.module_id)] = copy.deepcopy(r)

    def delete_review(self, tenant_id: str, uid: str, module_id: str) -> None:
        with self._lock:
            self.reviews.pop((tenant_id, uid, module_id), None)

    # dashboards (M4)
    def add_gap(self, gap: KnowledgeGap) -> None:
        with self._lock:
            gap.created_at = gap.created_at or now_iso()
            self.gaps.append(copy.deepcopy(gap))

    def list_gaps(self, tenant_id: str, limit: int = 500) -> list[KnowledgeGap]:
        with self._lock:
            rows = [copy.deepcopy(g) for g in self.gaps if g.tenant_id == tenant_id]
            return sorted(rows, key=lambda g: g.created_at, reverse=True)[:limit]


# ── Supabase (prod) ───────────────────────────────────────────────────────────
def _row(obj: Any, *drop: str) -> dict:
    d = asdict(obj)
    for k in drop:
        d.pop(k, None)
    return d


class SupabaseAcademyStore:
    BUCKET = "kb"
    DOC_COLS = ("id,tenant_id,title,storage_path,sensitivity,dept_tags,role_tags,"
                "owner_email,updated_at,version,content_hash")
    LEARNER_COLS = "uid,tenant_id,email,role,department,seniority,clearance,name"
    PATH_COLS = "id,tenant_id,title,rules,pass_mark,status,error,created_at,updated_at"
    MODULE_COLS = "id,tenant_id,path_id,position,title,lesson_md,source_doc_ids,status"
    ITEM_COLS = ("id,tenant_id,module_id,type,stem,options,answer,explanation,"
                 "source_doc_ids,difficulty,status,rubric")
    ASSIGN_COLS = ("tenant_id,learner_uid,path_id,status,score,started_at,completed_at,"
                   "assigned_at,due_at,certified_at,certified_by")
    GAP_COLS = "tenant_id,learner_uid,question,created_at"
    PROGRESS_COLS = ("tenant_id,learner_uid,module_id,path_id,best_score,last_score,passed,"
                     "attempts,completed_at,updated_at")
    REVIEW_COLS = "tenant_id,learner_uid,module_id,due_at,interval_days"
    _UPSERT = {"Prefer": "resolution=merge-duplicates"}

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

    def _get(self, table: str, cols: str, **filters: str) -> list[dict]:
        return self._rest("GET", table, params={"select": cols, **filters}).json()

    # tenants / files / audit
    def ensure_tenant(self, tenant_id: str, name: str) -> None:
        self._rest("POST", "tenants", json={"id": tenant_id, "name": name},
                   headers={"Prefer": "resolution=ignore-duplicates"})

    def upload_file(self, path: str, content: bytes, mime: str) -> None:
        r = self._client.post(f"/storage/v1/object/{self.BUCKET}/{path}", content=content,
                              headers={"Content-Type": mime, "x-upsert": "true"})
        if r.status_code >= 400:
            log.error("supabase storage upload -> %d", r.status_code)
            r.raise_for_status()

    def delete_file(self, path: str) -> None:
        r = self._client.request("DELETE", f"/storage/v1/object/{self.BUCKET}",
                                 json={"prefixes": [path]})
        if r.status_code >= 400:
            log.warning("supabase storage delete -> %d", r.status_code)

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

    # documents
    def add_document(self, doc: KbDocument) -> None:
        self._rest("POST", "kb_documents", json=_row(doc, "updated_at"))

    def update_document(self, doc: KbDocument) -> None:
        body = _row(doc, "id", "tenant_id", "updated_at")
        body["updated_at"] = now_iso()
        self._rest("PATCH", "kb_documents", params={"id": f"eq.{doc.id}", "tenant_id": f"eq.{doc.tenant_id}"},
                   json=body)

    def get_document(self, tenant_id: str, doc_id: str) -> KbDocument | None:
        rows = self._get("kb_documents", self.DOC_COLS, id=f"eq.{doc_id}", tenant_id=f"eq.{tenant_id}")
        return KbDocument(**rows[0]) if rows else None

    def find_document_by_title(self, tenant_id: str, title: str) -> KbDocument | None:
        rows = self._get("kb_documents", self.DOC_COLS, title=f"eq.{title}", tenant_id=f"eq.{tenant_id}")
        return KbDocument(**rows[0]) if rows else None

    def list_documents(self, tenant_id: str) -> list[KbDocument]:
        rows = self._get("kb_documents", self.DOC_COLS, tenant_id=f"eq.{tenant_id}", order="updated_at.desc")
        return [KbDocument(**row) for row in rows]

    def delete_document(self, tenant_id: str, doc_id: str) -> KbDocument | None:
        r = self._rest("DELETE", "kb_documents", params={"id": f"eq.{doc_id}", "tenant_id": f"eq.{tenant_id}",
                                                         "select": self.DOC_COLS},
                       headers={"Prefer": "return=representation"})
        rows = r.json()
        return KbDocument(**rows[0]) if rows else None

    def mark_stale_for_doc(self, tenant_id: str, doc_id: str) -> int:
        hdr = {"Prefer": "return=representation"}
        f = {"tenant_id": f"eq.{tenant_id}", "source_doc_ids": f"cs.{{{doc_id}}}"}
        mods = self._rest("PATCH", "modules", params={**f, "select": "id,path_id"},
                          json={"status": "stale"}, headers=hdr).json()
        items = self._rest("PATCH", "items", params={**f, "select": "id,module_id"},
                           json={"status": "stale"}, headers=hdr).json()
        path_ids = {m["path_id"] for m in mods}
        mod_ids = {i["module_id"] for i in items} - {m["id"] for m in mods}
        if mod_ids:
            extra = self._get("modules", "path_id", id=f"in.({','.join(mod_ids)})", tenant_id=f"eq.{tenant_id}")
            path_ids |= {m["path_id"] for m in extra}
        if path_ids:
            self._rest("PATCH", "paths", params={"id": f"in.({','.join(path_ids)})", "tenant_id": f"eq.{tenant_id}",
                                                 "status": "in.(draft,published)"},
                       json={"status": "stale", "updated_at": now_iso()})
        return len(mods) + len(items)

    # learners
    def get_learner(self, tenant_id: str, uid: str) -> Learner | None:
        rows = self._get("learners", self.LEARNER_COLS, uid=f"eq.{uid}", tenant_id=f"eq.{tenant_id}")
        return Learner(**rows[0]) if rows else None

    def get_learner_by_email(self, tenant_id: str, email: str) -> Learner | None:
        rows = self._get("learners", self.LEARNER_COLS, email=f"ilike.{email}", tenant_id=f"eq.{tenant_id}")
        return Learner(**rows[0]) if rows else None

    def upsert_learner(self, learner: Learner) -> None:
        existing = self.get_learner_by_email(learner.tenant_id, learner.email)
        if existing and existing.uid != learner.uid:
            self.delete_learner(learner.tenant_id, existing.uid)
        self._rest("POST", "learners", json=_row(learner),
                   headers={"Prefer": "resolution=merge-duplicates"})

    def rekey_learner(self, tenant_id: str, old_uid: str, new_uid: str) -> None:
        self._rest("PATCH", "learners", params={"uid": f"eq.{old_uid}", "tenant_id": f"eq.{tenant_id}"},
                   json={"uid": new_uid})

    def list_learners(self, tenant_id: str) -> list[Learner]:
        rows = self._get("learners", self.LEARNER_COLS, tenant_id=f"eq.{tenant_id}", order="email.asc")
        return [Learner(**row) for row in rows]

    def delete_learner(self, tenant_id: str, uid: str) -> bool:
        r = self._rest("DELETE", "learners", params={"uid": f"eq.{uid}", "tenant_id": f"eq.{tenant_id}",
                                                     "select": "uid"},
                       headers={"Prefer": "return=representation"})
        return bool(r.json())

    # paths / modules / items
    def create_path(self, path: Path) -> None:
        self._rest("POST", "paths", json=_row(path, "created_at", "updated_at"))

    def update_path(self, path: Path) -> None:
        body = _row(path, "id", "tenant_id", "created_at")
        body["updated_at"] = now_iso()
        self._rest("PATCH", "paths", params={"id": f"eq.{path.id}", "tenant_id": f"eq.{path.tenant_id}"}, json=body)

    def get_path(self, tenant_id: str, path_id: str) -> Path | None:
        rows = self._get("paths", self.PATH_COLS, id=f"eq.{path_id}", tenant_id=f"eq.{tenant_id}")
        return Path(**rows[0]) if rows else None

    def list_paths(self, tenant_id: str) -> list[Path]:
        rows = self._get("paths", self.PATH_COLS, tenant_id=f"eq.{tenant_id}", order="created_at.desc")
        return [Path(**row) for row in rows]

    def delete_path(self, tenant_id: str, path_id: str) -> bool:   # modules/items cascade
        r = self._rest("DELETE", "paths", params={"id": f"eq.{path_id}", "tenant_id": f"eq.{tenant_id}",
                                                  "select": "id"},
                       headers={"Prefer": "return=representation"})
        return bool(r.json())

    def add_module(self, module: Module) -> None:
        self._rest("POST", "modules", json=_row(module))

    def update_module(self, module: Module) -> None:
        self._rest("PATCH", "modules", params={"id": f"eq.{module.id}", "tenant_id": f"eq.{module.tenant_id}"},
                   json=_row(module, "id", "tenant_id", "path_id"))

    def get_module(self, tenant_id: str, module_id: str) -> Module | None:
        rows = self._get("modules", self.MODULE_COLS, id=f"eq.{module_id}", tenant_id=f"eq.{tenant_id}")
        return Module(**rows[0]) if rows else None

    def list_modules(self, tenant_id: str, path_id: str) -> list[Module]:
        rows = self._get("modules", self.MODULE_COLS, path_id=f"eq.{path_id}", tenant_id=f"eq.{tenant_id}",
                         order="position.asc")
        return [Module(**row) for row in rows]

    def add_item(self, item: Item) -> None:
        self._rest("POST", "items", json=_row(item))

    def update_item(self, item: Item) -> None:
        self._rest("PATCH", "items", params={"id": f"eq.{item.id}", "tenant_id": f"eq.{item.tenant_id}"},
                   json=_row(item, "id", "tenant_id", "module_id"))

    def get_item(self, tenant_id: str, item_id: str) -> Item | None:
        rows = self._get("items", self.ITEM_COLS, id=f"eq.{item_id}", tenant_id=f"eq.{tenant_id}")
        return Item(**rows[0]) if rows else None

    def delete_item(self, tenant_id: str, item_id: str) -> bool:
        r = self._rest("DELETE", "items", params={"id": f"eq.{item_id}", "tenant_id": f"eq.{tenant_id}",
                                                  "select": "id"},
                       headers={"Prefer": "return=representation"})
        return bool(r.json())

    def list_items(self, tenant_id: str, module_ids: list[str]) -> list[Item]:
        if not module_ids:
            return []
        rows = self._get("items", self.ITEM_COLS, module_id=f"in.({','.join(module_ids)})",
                         tenant_id=f"eq.{tenant_id}")
        return [Item(**row) for row in rows]

    # learner progress (M3) — numeric columns arrive as JSON numbers or strings
    @staticmethod
    def _assignment(row: dict) -> Assignment:
        score = row.get("score")
        return Assignment(**{**row, "score": None if score is None else float(score)})

    @staticmethod
    def _progress(row: dict) -> ModuleProgress:
        return ModuleProgress(**{**row, "best_score": float(row["best_score"]),
                                 "last_score": float(row["last_score"])})

    def get_assignment(self, tenant_id: str, uid: str, path_id: str) -> Assignment | None:
        rows = self._get("assignments", self.ASSIGN_COLS, tenant_id=f"eq.{tenant_id}",
                         learner_uid=f"eq.{uid}", path_id=f"eq.{path_id}")
        return self._assignment(rows[0]) if rows else None

    def list_assignments(self, tenant_id: str, uid: str | None = None) -> list[Assignment]:
        filters = {"tenant_id": f"eq.{tenant_id}"} | ({"learner_uid": f"eq.{uid}"} if uid else {})
        return [self._assignment(r) for r in self._get("assignments", self.ASSIGN_COLS, **filters)]

    def upsert_assignment(self, a: Assignment) -> None:
        self._rest("POST", "assignments", params={"on_conflict": "learner_uid,path_id"},
                   json=_row(a), headers=self._UPSERT)

    def add_attempts(self, attempts: list[Attempt]) -> None:
        if attempts:
            self._rest("POST", "attempts", json=[_row(a) for a in attempts])

    def list_attempt_scores(self, tenant_id: str) -> list[tuple[str, float]]:
        rows = self._get("attempts", "item_id,score", tenant_id=f"eq.{tenant_id}",
                         order="created_at.desc", limit="5000")
        return [(r["item_id"], float(r["score"])) for r in rows]

    def get_progress(self, tenant_id: str, uid: str, module_id: str) -> ModuleProgress | None:
        rows = self._get("module_progress", self.PROGRESS_COLS, tenant_id=f"eq.{tenant_id}",
                         learner_uid=f"eq.{uid}", module_id=f"eq.{module_id}")
        return self._progress(rows[0]) if rows else None

    def list_progress(self, tenant_id: str, uid: str | None = None) -> list[ModuleProgress]:
        filters = {"tenant_id": f"eq.{tenant_id}"} | ({"learner_uid": f"eq.{uid}"} if uid else {})
        return [self._progress(r) for r in self._get("module_progress", self.PROGRESS_COLS, **filters)]

    def upsert_progress(self, p: ModuleProgress) -> None:
        body = _row(p)
        body["updated_at"] = now_iso()
        self._rest("POST", "module_progress", params={"on_conflict": "learner_uid,module_id"},
                   json=body, headers=self._UPSERT)

    def get_review(self, tenant_id: str, uid: str, module_id: str) -> ReviewEntry | None:
        rows = self._get("review_queue", self.REVIEW_COLS, tenant_id=f"eq.{tenant_id}",
                         learner_uid=f"eq.{uid}", module_id=f"eq.{module_id}")
        return ReviewEntry(**rows[0]) if rows else None

    def list_reviews(self, tenant_id: str, uid: str) -> list[ReviewEntry]:
        rows = self._get("review_queue", self.REVIEW_COLS, tenant_id=f"eq.{tenant_id}",
                         learner_uid=f"eq.{uid}", order="due_at.asc")
        return [ReviewEntry(**r) for r in rows]

    def upsert_review(self, r: ReviewEntry) -> None:
        self._rest("POST", "review_queue", params={"on_conflict": "learner_uid,module_id"},
                   json=_row(r), headers=self._UPSERT)

    def delete_review(self, tenant_id: str, uid: str, module_id: str) -> None:
        self._rest("DELETE", "review_queue", params={"tenant_id": f"eq.{tenant_id}",
                                                     "learner_uid": f"eq.{uid}",
                                                     "module_id": f"eq.{module_id}"})

    # dashboards (M4)
    def add_gap(self, gap: KnowledgeGap) -> None:
        try:
            self._rest("POST", "kb_gaps", json=_row(gap, "created_at"))
        except Exception as exc:  # gap logging must never break an answer
            log.warning("gap write failed: %s", exc)

    def list_gaps(self, tenant_id: str, limit: int = 500) -> list[KnowledgeGap]:
        rows = self._get("kb_gaps", self.GAP_COLS, tenant_id=f"eq.{tenant_id}",
                         order="created_at.desc", limit=str(limit))
        return [KnowledgeGap(**r) for r in rows]


def create_academy_store() -> AcademyStore:
    url, key = os.getenv("SUPABASE_URL", ""), os.getenv("SUPABASE_SERVICE_KEY", "")
    if url and key and os.getenv("RAGAAS_USE_MEMORY_STORE") != "1":
        log.info("academy store: supabase")
        return SupabaseAcademyStore(url, key)
    log.info("academy store: memory")
    return MemoryAcademyStore()
