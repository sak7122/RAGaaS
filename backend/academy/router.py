"""Academy HTTP routes.

M0: KB upload, learner profiles, entitlement-scoped ask.
M1: document versioning + deletion with stale marking, learner list / CSV import
    (pending learners matched by email on first sign-in).
M2: learning-path generation (topics → lessons → quiz items) with review,
    editing and publishing.
M3: learner app — today's plan, lessons, graded tests (exact + rubric-graded
    free text), progress, spaced review.
M4: admin dashboard (funnel, learner progress, hardest questions, knowledge
    gaps, stale queue), path settings with due windows, sign-off, certificates.

No `from __future__ import annotations` here: FastAPI must resolve the local
AuthDep alias at definition time, and string annotations would hide it.
"""
import csv
import hashlib
import statistics
import io
import logging
import math
import re
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from pathlib import PurePath
from typing import Annotated, Any, Callable, Literal

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, Response, UploadFile
from pydantic import BaseModel, Field

from backend.academy.certificate import certificate_id, render_certificate
from backend.academy.course import CourseGenerator
from backend.academy.search import KnowledgeSearch, doc_permitted
from backend.academy.grading import FREE_TEXT, FreeTextGrader, create_free_text_grader, grade_item
from backend.academy.store import (
    ADMIN_ENTITLEMENT, PENDING_PREFIX, PUBLIC, RESTRICTED, AcademyStore, Assignment, Attempt,
    Entitlement, Item, KbDocument, KnowledgeGap, Learner, Module, ModuleProgress, Path, ReviewEntry,
    new_id,
)
from backend.firebase_services import Principal

log = logging.getLogger("ragaas.academy")

MIME_BY_EXT = {
    ".pdf": "application/pdf",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".txt": "text/plain",
    ".md": "text/plain",   # Vertex AI Search has no markdown type; plain text indexes fine
}
CLEARANCE_WORDS = {"public": 0, "internal": 1, "restricted": 2, "0": 0, "1": 1, "2": 2}
MAX_CSV_ROWS = 2000
GENERATION_TIMEOUT = timedelta(minutes=10)
PLAN_MINUTES = 30          # "today's plan" budget (PRD §8: 2-3 modules, ~30 min)
PLAN_MAX_NEW = 3
REVIEW_STEPS = (1, 3, 7)   # spaced-review intervals in days (PRD §6.2)
HARDEST_MIN_ATTEMPTS = 3   # a question needs this many answers before it's ranked
HARDEST_LIMIT = 8
GAPS_LIMIT = 15
_TAG_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,39}$")
_NAME_RE = re.compile(r"[^A-Za-z0-9._-]+")
_EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]{2,}$")


# ── Models ────────────────────────────────────────────────────────────────────
class AcademyDocOut(BaseModel):
    id: str
    title: str
    sensitivity: int
    dept_tags: list[str]
    role_tags: list[str]
    updated_at: str
    version: int = 1
    stale_marked: int = 0
    unchanged: bool = False


class LearnerIn(BaseModel):
    email: str = Field(min_length=3, max_length=254)
    name: str | None = Field(default=None, max_length=120)
    role: str | None = Field(default=None, max_length=40)
    department: str | None = Field(default=None, max_length=40)
    seniority: int = Field(default=1, ge=1, le=5)
    clearance: int = Field(default=1, ge=0, le=2)


class LearnerOut(BaseModel):
    uid: str
    email: str
    role: str | None
    department: str | None
    seniority: int
    clearance: int
    pending: bool
    name: str | None = None


class AskIn(BaseModel):
    question: str = Field(min_length=1, max_length=2000)


class CitationOut(BaseModel):
    doc_id: str
    title: str
    excerpt: str
    page: str | None = None


class AskOut(BaseModel):
    answer: str
    grounded: bool
    citations: list[CitationOut]


class PathIn(BaseModel):
    title: str = Field(min_length=2, max_length=120)
    department: str | None = Field(default=None, max_length=40)
    role: str | None = Field(default=None, max_length=40)
    clearance: int = Field(default=1, ge=0, le=2)
    module_count: int = Field(default=4, ge=1, le=8)
    questions_per_module: int = Field(default=4, ge=2, le=8)
    due_days: int | None = Field(default=None, ge=1, le=365)


class PathSettingsIn(BaseModel):
    title: str | None = Field(default=None, min_length=2, max_length=120)
    pass_mark: float | None = Field(default=None, ge=0.5, le=1.0)
    due_days: int | None = Field(default=None, ge=1, le=365)   # send null to remove the deadline


class ItemOut(BaseModel):
    id: str
    module_id: str
    type: str
    stem: str
    options: list[str] | None
    answer: Any
    explanation: str | None
    source_doc_ids: list[str]
    status: str
    rubric: str | None = None


class ModuleOut(BaseModel):
    id: str
    position: int
    title: str
    lesson_md: str
    source_doc_ids: list[str]
    status: str
    items: list[ItemOut]


class PathOut(BaseModel):
    id: str
    title: str
    rules: dict[str, Any]
    pass_mark: float
    status: str
    error: str | None
    created_at: str
    updated_at: str
    module_count: int = 0
    modules: list[ModuleOut] | None = None


class ModuleEdit(BaseModel):
    title: str | None = Field(default=None, min_length=2, max_length=160)
    lesson_md: str | None = Field(default=None, max_length=20000)


class ItemEdit(BaseModel):
    stem: str = Field(min_length=3, max_length=500)
    type: Literal["mcq", "true_false", "short_answer", "scenario"]
    options: list[str] | None = None
    answer: int | bool | None = None
    explanation: str | None = Field(default=None, max_length=1000)
    rubric: str | None = Field(default=None, max_length=1000)


# ── Learner app models (M3) — never carry answers, rubrics or explanations ───
class SourceOut(BaseModel):
    doc_id: str
    title: str


class LearnItemOut(BaseModel):
    id: str
    type: str
    stem: str
    options: list[str] | None


class ProgressOut(BaseModel):
    best_score: float
    last_score: float
    passed: bool
    attempts: int
    completed_at: str | None


class LearnModuleSummary(BaseModel):
    id: str
    position: int
    title: str
    est_minutes: int
    item_count: int
    passed: bool
    best_score: float | None
    review_due_at: str | None


class LearnPathOut(BaseModel):
    id: str
    title: str
    pass_mark: float
    status: Literal["assigned", "in_progress", "passed", "certified"]
    score: float | None
    modules_total: int
    modules_passed: int
    modules: list[LearnModuleSummary]
    due_at: str | None = None
    overdue: bool = False
    certified_at: str | None = None


class LearnModuleOut(BaseModel):
    id: str
    path_id: str
    path_title: str
    position: int
    title: str
    lesson_md: str
    est_minutes: int
    pass_mark: float
    sources: list[SourceOut]
    items: list[LearnItemOut]
    progress: ProgressOut | None
    review_due_at: str | None


class PlanEntry(BaseModel):
    kind: Literal["review", "next"]
    path_id: str
    path_title: str
    module_id: str
    module_title: str
    est_minutes: int


class PlanOut(BaseModel):
    preview: bool          # admins see every path; nothing they submit is recorded
    clearance: int
    department: str | None
    role: str | None
    paths: list[LearnPathOut]
    today: list[PlanEntry]
    today_minutes: int
    reviews_due: int


class AnswerIn(BaseModel):
    item_id: str
    response: bool | int | Annotated[str, Field(max_length=4000)]


class SubmitIn(BaseModel):
    answers: list[AnswerIn] = Field(default_factory=list, max_length=50)


class ItemResultOut(BaseModel):
    item_id: str
    type: str
    correct: bool
    score: float
    feedback: str
    explanation: str | None
    correct_answer: bool | int | None
    model_answer: str | None
    sources: list[SourceOut]


class SubmitOut(BaseModel):
    module_id: str
    score: float
    passed: bool
    pass_mark: float
    preview: bool
    review_due_at: str | None
    results: list[ItemResultOut]
    path: LearnPathOut


# ── Dashboard & certification models (M4) ───────────────────────────────────
class DashTotals(BaseModel):
    learners: int
    not_signed_in: int
    assignments: int
    in_progress: int
    completed: int
    awaiting_signoff: int
    certified: int
    overdue: int


class DashPath(BaseModel):
    id: str
    title: str
    status: str
    pass_mark: float
    due_days: int | None
    lessons: int
    eligible: int
    started: int
    passed: int          # includes certified
    certified: int
    overdue: int
    avg_score: float | None
    median_days_to_ready: float | None


class DashLearnerPath(BaseModel):
    path_id: str
    title: str
    status: Literal["assigned", "in_progress", "passed", "certified"]
    score: float | None
    modules_passed: int
    modules_total: int
    assigned_at: str | None
    due_at: str | None
    overdue: bool
    completed_at: str | None
    certified_at: str | None
    weak_modules: list[str]          # lessons attempted but not yet passed


class DashLearner(BaseModel):
    uid: str
    email: str
    name: str | None
    department: str | None
    role: str | None
    pending: bool
    last_active: str | None
    paths: list[DashLearnerPath]


class DashItem(BaseModel):
    item_id: str
    stem: str
    type: str
    module_title: str
    path_id: str
    path_title: str
    attempts: int
    avg_score: float


class DashGap(BaseModel):
    question: str
    count: int
    last_asked: str


class DashStale(BaseModel):
    path_id: str
    title: str
    status: str
    stale_lessons: int
    stale_questions: int


class DashboardOut(BaseModel):
    totals: DashTotals
    paths: list[DashPath]
    learners: list[DashLearner]
    hardest: list[DashItem]
    gaps: list[DashGap]
    stale: list[DashStale]


class CertifyOut(BaseModel):
    ok: bool
    certified_at: str
    certificate_id: str


# ── Helpers ───────────────────────────────────────────────────────────────────
def _parse_ts(value: str) -> datetime:
    return datetime.fromisoformat(str(value).replace("Z", "+00:00"))


def parse_tags(raw: str) -> list[str]:
    tags = sorted({t.strip().lower() for t in raw.split(",") if t.strip()})
    if len(tags) > 20 or any(not _TAG_RE.match(t) for t in tags):
        raise HTTPException(status_code=422, detail="Tags must be 1-40 chars [a-z0-9_-], max 20")
    return tags


def _clean_tag(value: str | None) -> str | None:
    if value is None or not value.strip():
        return None
    tag = value.strip().lower()
    if not _TAG_RE.match(tag):
        raise HTTPException(status_code=422, detail=f"Invalid tag '{value}'")
    return tag


def _doc_out(d: KbDocument, **extra: Any) -> AcademyDocOut:
    return AcademyDocOut(id=d.id, title=d.title, sensitivity=d.sensitivity, dept_tags=d.dept_tags,
                         role_tags=d.role_tags, updated_at=str(d.updated_at), version=d.version, **extra)


def _learner_out(lr: Learner) -> LearnerOut:
    return LearnerOut(uid=lr.uid, email=lr.email, role=lr.role, department=lr.department,
                      seniority=lr.seniority, clearance=lr.clearance, pending=lr.pending, name=lr.name)


def _item_out(i: Item) -> ItemOut:
    return ItemOut(id=i.id, module_id=i.module_id, type=i.type, stem=i.stem, options=i.options,
                   answer=i.answer, explanation=i.explanation, source_doc_ids=i.source_doc_ids,
                   status=i.status, rubric=i.rubric)


def validate_item_edit(body: ItemEdit) -> tuple[list[str] | None, int | bool | None, str | None]:
    if body.type in FREE_TEXT:
        rubric = (body.rubric or "").strip()
        if len(rubric) < 3:
            raise HTTPException(status_code=422, detail="Free-text questions need a rubric: the points a correct answer covers")
        return None, None, rubric
    if body.answer is None:
        raise HTTPException(status_code=422, detail="Choose the correct answer")
    if body.type == "mcq":
        opts = [o.strip() for o in (body.options or [])]
        if len(opts) != 4 or any(not o or len(o) > 300 for o in opts) or len({o.lower() for o in opts}) != 4:
            raise HTTPException(status_code=422, detail="Multiple-choice needs 4 different, non-empty options")
        if isinstance(body.answer, bool) or not 0 <= int(body.answer) <= 3:
            raise HTTPException(status_code=422, detail="Answer must be the index (0-3) of the correct option")
        return opts, int(body.answer), None
    if not isinstance(body.answer, bool):
        raise HTTPException(status_code=422, detail="True/false answer must be true or false")
    return None, body.answer, None


def parse_learners_csv(text: str) -> tuple[list[dict], list[dict]]:
    """CSV columns (header row required): email, name, department, role, clearance, seniority.
    Only email is required. Returns (rows, errors)."""
    reader = csv.DictReader(io.StringIO(text.lstrip("﻿")))
    if not reader.fieldnames or "email" not in [f.strip().lower() for f in reader.fieldnames]:
        raise HTTPException(status_code=422, detail="CSV needs a header row with an 'email' column")
    rows, errors = [], []
    for n, raw in enumerate(reader, start=2):
        if n - 1 > MAX_CSV_ROWS:
            errors.append({"line": n, "message": f"Stopped after {MAX_CSV_ROWS} rows"})
            break
        r = {str(k).strip().lower(): (v or "").strip() for k, v in raw.items() if k}
        email = r.get("email", "").lower()
        if not email:
            continue
        if not _EMAIL_RE.match(email):
            errors.append({"line": n, "message": f"'{email}' is not an email address"}); continue
        clearance = CLEARANCE_WORDS.get(r.get("clearance", "internal").lower() or "internal")
        if clearance is None:
            errors.append({"line": n, "message": "clearance must be public, internal or restricted"}); continue
        try:
            seniority = int(r.get("seniority") or 1)
            assert 1 <= seniority <= 5
        except (ValueError, AssertionError):
            errors.append({"line": n, "message": "seniority must be 1-5"}); continue
        try:
            dept, role = _clean_tag(r.get("department")), _clean_tag(r.get("role"))
        except HTTPException as exc:
            errors.append({"line": n, "message": str(exc.detail)}); continue
        name = r.get("name", "")
        if len(name) > 120:
            errors.append({"line": n, "message": "name must be at most 120 characters"}); continue
        rows.append({"email": email, "name": name or None, "department": dept, "role": role,
                     "clearance": clearance, "seniority": seniority})
    return rows, errors


def create_academy_router(
    *,
    store: AcademyStore,
    search: KnowledgeSearch,
    auth: Callable[..., Principal],
    require_role: Callable[..., None],
    enforce_quota: Callable[[str], int],
    max_upload_bytes: int,
    grader: FreeTextGrader | None = None,
    tenant_name: Callable[[str], str] | None = None,
) -> APIRouter:
    router = APIRouter(prefix="/api/academy", tags=["academy"])
    AuthDep = Annotated[Principal, Depends(auth)]
    generator = CourseGenerator(search)
    free_text_grader = grader or create_free_text_grader()
    company_name = tenant_name or (lambda t: t)

    def learner_for(principal: Principal) -> Learner | None:
        learner = store.get_learner(principal.tenant_id, principal.uid)
        if learner is None and principal.email:
            # Imported by CSV before they signed up → claim the row on first sight.
            pending = store.get_learner_by_email(principal.tenant_id, principal.email)
            if pending and pending.pending:
                store.rekey_learner(principal.tenant_id, pending.uid, principal.uid)
                store.audit(principal.tenant_id, principal.uid, "learner.claimed")
                pending.uid = principal.uid
                learner = pending
        return learner

    def entitlement_for(principal: Principal) -> Entitlement:
        if principal.role == "admin":
            return ADMIN_ENTITLEMENT
        learner = learner_for(principal)
        # No profile yet → public content only, until an admin sets clearance.
        return learner.entitlement() if learner else Entitlement()

    def require_enabled(tenant_id: str) -> None:
        if not search.enabled_for(tenant_id):
            raise HTTPException(status_code=404, detail="Academy is not enabled for this workspace")

    def path_out(p: Path, with_modules: bool = False) -> PathOut:
        if p.status == "generating":
            started = datetime.fromisoformat(str(p.updated_at).replace("Z", "+00:00")) if p.updated_at else None
            if started and datetime.now(timezone.utc) - started > GENERATION_TIMEOUT:
                p.status, p.error = "failed", "Generation did not finish. Delete and try again."
                store.update_path(p)
        modules = store.list_modules(p.tenant_id, p.id)
        mods_out = None
        if with_modules:
            items = store.list_items(p.tenant_id, [m.id for m in modules])
            mods_out = [ModuleOut(id=m.id, position=m.position, title=m.title, lesson_md=m.lesson_md,
                                  source_doc_ids=m.source_doc_ids, status=m.status,
                                  items=[_item_out(i) for i in items if i.module_id == m.id])
                        for m in modules]
        return PathOut(id=p.id, title=p.title, rules=p.rules, pass_mark=p.pass_mark, status=p.status,
                       error=p.error, created_at=str(p.created_at), updated_at=str(p.updated_at),
                       module_count=len(modules), modules=mods_out)

    def owned_path(tenant_id: str, path_id: str) -> Path:
        p = store.get_path(tenant_id, path_id)
        if not p:
            raise HTTPException(status_code=404, detail="Path not found")
        return p

    def mark_path_edited(tenant_id: str, path_id: str) -> None:
        p = store.get_path(tenant_id, path_id)
        if p and p.status == "published":
            p.status = "draft"      # edits to live content go back through review
            store.update_path(p)

    # ── Documents (M0 + M1) ───────────────────────────────────────────────────
    @router.post("/documents", response_model=AcademyDocOut, status_code=201)
    async def upload(
        principal: AuthDep,
        file: UploadFile = File(...),
        sensitivity: int = Form(1, ge=0, le=2),
        dept_tags: str = Form(""),
        role_tags: str = Form(""),
    ) -> AcademyDocOut:
        require_role(principal, "admin", "uploader")
        tenant_id = principal.tenant_id
        require_enabled(tenant_id)

        name = _NAME_RE.sub("_", PurePath(file.filename or "").name).strip("._")
        mime = MIME_BY_EXT.get(PurePath(name).suffix.lower())
        if not name or not mime:
            raise HTTPException(status_code=415, detail=f"Supported types: {', '.join(MIME_BY_EXT)}")
        content = await file.read()
        if not content:
            raise HTTPException(status_code=400, detail="Empty file")
        if len(content) > max_upload_bytes:
            raise HTTPException(status_code=413, detail="Upload exceeds size limit")

        digest = hashlib.sha256(content).hexdigest()
        depts, roles = parse_tags(dept_tags), parse_tags(role_tags)
        existing = store.find_document_by_title(tenant_id, name)

        if existing and existing.content_hash == digest and existing.sensitivity == sensitivity \
                and existing.dept_tags == depts and existing.role_tags == roles:
            return _doc_out(existing, unchanged=True)

        store.ensure_tenant(tenant_id, tenant_id)
        if existing:   # new version of the same document
            doc = existing
            doc.version += 1
            old_path = doc.storage_path
            doc.storage_path = f"{tenant_id}/{doc.id}/v{doc.version}-{name}"
            doc.sensitivity, doc.dept_tags, doc.role_tags = sensitivity, depts, roles
            doc.content_hash, doc.owner_email = digest, principal.email
        else:
            doc_id = new_id()
            doc = KbDocument(id=doc_id, tenant_id=tenant_id, title=name,
                             storage_path=f"{tenant_id}/{doc_id}/v1-{name}", sensitivity=sensitivity,
                             dept_tags=depts, role_tags=roles, owner_email=principal.email,
                             content_hash=digest)

        store.upload_file(doc.storage_path, content, mime)
        try:
            search.import_document(doc, content, mime)
        except ValueError as exc:
            store.delete_file(doc.storage_path)
            raise HTTPException(status_code=413, detail=str(exc)) from exc

        stale = 0
        if existing:
            store.update_document(doc)
            store.delete_file(old_path)
            stale = store.mark_stale_for_doc(tenant_id, doc.id)
            store.audit(tenant_id, principal.uid, f"kb.version:{doc.id}:v{doc.version}")
        else:
            store.add_document(doc)
            store.audit(tenant_id, principal.uid, f"kb.upload:{doc.id}")
        log.info("academy upload tenant=%s doc=%s v=%d stale=%d", tenant_id, doc.id, doc.version, stale)
        saved = store.get_document(tenant_id, doc.id) or doc
        return _doc_out(saved, stale_marked=stale)

    @router.get("/documents", response_model=list[AcademyDocOut])
    def list_docs(principal: AuthDep) -> list[AcademyDocOut]:
        require_role(principal, "admin", "uploader")
        return [_doc_out(d) for d in store.list_documents(principal.tenant_id)]

    @router.delete("/documents/{doc_id}")
    def delete_doc(doc_id: str, principal: AuthDep) -> dict:
        require_role(principal, "admin")
        tenant_id = principal.tenant_id
        doc = store.get_document(tenant_id, doc_id)
        if not doc:
            raise HTTPException(status_code=404, detail="Document not found")
        search.delete_document(doc)            # stop retrieval first
        store.delete_document(tenant_id, doc_id)
        store.delete_file(doc.storage_path)
        stale = store.mark_stale_for_doc(tenant_id, doc_id)
        store.audit(tenant_id, principal.uid, f"kb.delete:{doc_id}")
        return {"ok": True, "id": doc_id, "stale_marked": stale}

    # ── Learners (M0 + M1) ────────────────────────────────────────────────────
    @router.get("/learners", response_model=list[LearnerOut])
    def list_learners(principal: AuthDep) -> list[LearnerOut]:
        require_role(principal, "admin")
        return [_learner_out(lr) for lr in store.list_learners(principal.tenant_id)]

    @router.put("/learners/{uid}")
    def upsert_learner(uid: str, body: LearnerIn, principal: AuthDep) -> dict:
        require_role(principal, "admin")
        if not _EMAIL_RE.match(body.email.strip()):
            raise HTTPException(status_code=422, detail="Enter a valid email address")
        store.ensure_tenant(principal.tenant_id, principal.tenant_id)
        store.upsert_learner(Learner(
            uid=uid, tenant_id=principal.tenant_id, email=body.email.strip().lower(),
            role=_clean_tag(body.role), department=_clean_tag(body.department),
            seniority=body.seniority, clearance=body.clearance,
            name=(body.name or "").strip() or None,
        ))
        store.audit(principal.tenant_id, principal.uid, f"learner.upsert:{uid}")
        return {"ok": True, "uid": uid}

    @router.post("/learners/import")
    async def import_learners(request: Request, principal: AuthDep) -> dict:
        """Body: raw CSV text (Content-Type: text/csv), header row required."""
        require_role(principal, "admin")
        tenant_id = principal.tenant_id
        raw = await request.body()
        if len(raw) > 1_000_000:
            raise HTTPException(status_code=413, detail="CSV is larger than 1 MB")
        try:
            csv_text = raw.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise HTTPException(status_code=422, detail="Save the CSV as UTF-8 and try again") from exc
        rows, errors = parse_learners_csv(csv_text)
        store.ensure_tenant(tenant_id, tenant_id)
        created = updated = 0
        for r in rows:
            existing = store.get_learner_by_email(tenant_id, r["email"])
            uid = existing.uid if existing else f"{PENDING_PREFIX}{r['email']}"
            store.upsert_learner(Learner(uid=uid, tenant_id=tenant_id, **r))
            updated += bool(existing); created += not existing
        store.audit(tenant_id, principal.uid, f"learner.import:{created}+{updated}")
        return {"created": created, "updated": updated, "errors": errors}

    @router.delete("/learners/{uid}")
    def delete_learner(uid: str, principal: AuthDep) -> dict:
        require_role(principal, "admin")
        if not store.delete_learner(principal.tenant_id, uid):
            raise HTTPException(status_code=404, detail="Learner not found")
        store.audit(principal.tenant_id, principal.uid, f"learner.delete:{uid}")
        return {"ok": True}

    @router.get("/me")
    def me(principal: AuthDep) -> dict:
        ent = entitlement_for(principal)
        return {"uid": principal.uid, "tenant_id": principal.tenant_id,
                "enabled": search.enabled_for(principal.tenant_id),
                "is_admin": principal.role == "admin",
                "clearance": ent.clearance, "department": ent.department, "role": ent.role}

    def is_knowledge_gap(tenant_id: str, question: str, ent: Entitlement) -> bool:
        """Unanswered for this learner AND for full access: a doc the learner isn't
        cleared for is an access question, not missing documentation."""
        if ent.unrestricted:
            return True
        try:
            return not search.answer(tenant_id, question, ADMIN_ENTITLEMENT).grounded
        except Exception:
            return False

    @router.post("/ask", response_model=AskOut)
    def ask(body: AskIn, principal: AuthDep) -> AskOut:
        tenant_id = principal.tenant_id
        require_enabled(tenant_id)
        enforce_quota(tenant_id)
        ent = entitlement_for(principal)
        try:
            result = search.answer(tenant_id, body.question, ent)
        except Exception as exc:
            log.error("academy ask failed tenant=%s: %s", tenant_id, exc)
            raise HTTPException(status_code=502, detail="Knowledge search unavailable") from exc
        store.audit(tenant_id, principal.uid, "kb.ask", model="vertex-ai-search-answer")
        if not result.grounded and is_knowledge_gap(tenant_id, body.question, ent):
            store.add_gap(KnowledgeGap(tenant_id, principal.uid, body.question.strip()[:500]))
        return AskOut(answer=result.answer, grounded=result.grounded,
                      citations=[CitationOut(**c.__dict__) for c in result.citations])

    # ── Learning paths (M2) ───────────────────────────────────────────────────
    @router.post("/paths", response_model=PathOut, status_code=201)
    def create_path(body: PathIn, principal: AuthDep) -> PathOut:
        """Generates synchronously (~1 min): Cloud Run throttles CPU after a
        response, so a background task would stall."""
        require_role(principal, "admin")
        tenant_id = principal.tenant_id
        require_enabled(tenant_id)
        enforce_quota(tenant_id)
        audience = Entitlement(clearance=body.clearance, department=_clean_tag(body.department),
                               role=_clean_tag(body.role))
        docs = [d for d in store.list_documents(tenant_id) if doc_permitted(d, audience)]
        if not docs:
            raise HTTPException(status_code=422,
                                detail="No documents are visible to this audience yet. Upload or re-tag documents first.")
        store.ensure_tenant(tenant_id, tenant_id)
        path = Path(id=new_id(), tenant_id=tenant_id, title=body.title.strip(), status="generating",
                    rules={"department": audience.department, "role": audience.role,
                           "clearance": audience.clearance, "module_count": body.module_count,
                           "questions_per_module": body.questions_per_module, "due_days": body.due_days})
        store.create_path(path)
        try:
            drafts = generator.build(tenant_id, audience, docs, body.module_count, body.questions_per_module)
            for pos, dm in enumerate(drafts, start=1):
                mod = Module(id=new_id(), tenant_id=tenant_id, path_id=path.id, position=pos,
                             title=dm.title[:160], lesson_md=dm.lesson_md, source_doc_ids=dm.source_doc_ids)
                store.add_module(mod)
                for di in dm.items:
                    store.add_item(Item(id=new_id(), tenant_id=tenant_id, module_id=mod.id, type=di.type,
                                        stem=di.stem, options=di.options, answer=di.answer,
                                        explanation=di.explanation, source_doc_ids=di.source_doc_ids,
                                        rubric=di.rubric))
            path.status = "draft" if drafts else "failed"
            path.error = None if drafts else "The documents didn't support any lessons for this audience."
        except Exception as exc:
            log.error("academy generation failed tenant=%s path=%s: %s", tenant_id, path.id, exc)
            path.status, path.error = "failed", "Generation failed. Try again in a minute."
        store.update_path(path)
        store.audit(tenant_id, principal.uid, f"path.generate:{path.id}:{path.status}",
                    model="vertex-ai-search-answer")
        return path_out(path, with_modules=True)

    @router.get("/paths", response_model=list[PathOut])
    def list_paths(principal: AuthDep) -> list[PathOut]:
        require_role(principal, "admin")
        return [path_out(p) for p in store.list_paths(principal.tenant_id)]

    @router.get("/paths/{path_id}", response_model=PathOut)
    def get_path(path_id: str, principal: AuthDep) -> PathOut:
        require_role(principal, "admin")
        return path_out(owned_path(principal.tenant_id, path_id), with_modules=True)

    @router.delete("/paths/{path_id}")
    def delete_path(path_id: str, principal: AuthDep) -> dict:
        require_role(principal, "admin")
        owned_path(principal.tenant_id, path_id)
        store.delete_path(principal.tenant_id, path_id)
        store.audit(principal.tenant_id, principal.uid, f"path.delete:{path_id}")
        return {"ok": True}

    @router.post("/paths/{path_id}/publish", response_model=PathOut)
    def publish_path(path_id: str, principal: AuthDep) -> PathOut:
        require_role(principal, "admin")
        tenant_id = principal.tenant_id
        p = owned_path(tenant_id, path_id)
        modules = store.list_modules(tenant_id, path_id)
        if p.status not in ("draft", "stale", "published") or not modules:
            raise HTTPException(status_code=409, detail="Only a generated path with lessons can be published")
        stale = [m.title for m in modules if m.status == "stale"]
        if stale:
            raise HTTPException(status_code=409,
                                detail=f"Review stale lessons before publishing: {', '.join(stale[:3])}")
        items = store.list_items(tenant_id, [m.id for m in modules])
        stale_items = sum(i.status == "stale" for i in items)
        if stale_items:   # publishing would silently drop them from learners' tests
            raise HTTPException(status_code=409, detail=f"Review {stale_items} stale question(s) "
                                "before publishing: edit or delete them")
        for m in modules:
            m.status = "published"; store.update_module(m)
        for i in items:
            i.status = "published"; store.update_item(i)
        p.status, p.error = "published", None
        store.update_path(p)
        store.audit(tenant_id, principal.uid, f"path.publish:{path_id}")
        return path_out(p, with_modules=True)

    @router.put("/modules/{module_id}", response_model=ModuleOut)
    def edit_module(module_id: str, body: ModuleEdit, principal: AuthDep) -> ModuleOut:
        require_role(principal, "admin")
        tenant_id = principal.tenant_id
        m = store.get_module(tenant_id, module_id)
        if not m:
            raise HTTPException(status_code=404, detail="Module not found")
        if body.title is not None:
            m.title = body.title.strip()
        if body.lesson_md is not None:
            if not body.lesson_md.strip():
                raise HTTPException(status_code=422, detail="A lesson can't be empty")
            m.lesson_md = body.lesson_md
        m.status = "draft"                 # an edit is a review: clears stale
        store.update_module(m)
        mark_path_edited(tenant_id, m.path_id)
        items = store.list_items(tenant_id, [m.id])
        return ModuleOut(id=m.id, position=m.position, title=m.title, lesson_md=m.lesson_md,
                         source_doc_ids=m.source_doc_ids, status=m.status, items=[_item_out(i) for i in items])

    @router.put("/items/{item_id}", response_model=ItemOut)
    def edit_item(item_id: str, body: ItemEdit, principal: AuthDep) -> ItemOut:
        require_role(principal, "admin")
        tenant_id = principal.tenant_id
        it = store.get_item(tenant_id, item_id)
        if not it:
            raise HTTPException(status_code=404, detail="Question not found")
        it.options, it.answer, it.rubric = validate_item_edit(body)
        it.type, it.stem = body.type, body.stem.strip()
        it.explanation = (body.explanation or "").strip() or None
        it.status = "draft"
        store.update_item(it)
        mod = store.get_module(tenant_id, it.module_id)
        if mod:
            mark_path_edited(tenant_id, mod.path_id)
        return _item_out(it)

    @router.delete("/items/{item_id}")
    def delete_item(item_id: str, principal: AuthDep) -> dict:
        require_role(principal, "admin")
        tenant_id = principal.tenant_id
        it = store.get_item(tenant_id, item_id)
        if not it:
            raise HTTPException(status_code=404, detail="Question not found")
        store.delete_item(tenant_id, item_id)
        mod = store.get_module(tenant_id, it.module_id)
        if mod:
            mark_path_edited(tenant_id, mod.path_id)
        return {"ok": True}

    # ── Learner app (M3) ──────────────────────────────────────────────────────
    # A learner sees a path when its audience rules match their profile, and only
    # its published lessons whose source documents they may read. Lessons an admin
    # is editing (draft) or that went stale stay hidden until republished.
    ModuleSet = list[tuple[Module, list[Item]]]

    def path_assigned(p: Path, ent: Entitlement) -> bool:
        if p.status in ("generating", "failed"):
            return False
        if ent.unrestricted:
            return True
        r = p.rules or {}
        return ((not r.get("department") or r["department"] == ent.department)
                and (not r.get("role") or r["role"] == ent.role)
                and int(r.get("clearance", RESTRICTED)) <= ent.clearance)

    def published_content(mods: list[Module], items: list[Item]) -> ModuleSet:
        return [(m, [i for i in items if i.module_id == m.id and i.status == "published"])
                for m in mods if m.status == "published"]

    def visible_to(content: ModuleSet, ent: Entitlement, docs: dict[str, KbDocument]) -> ModuleSet:
        return [(m, items) for m, items in content
                if all(d in docs and doc_permitted(docs[d], ent) for d in m.source_doc_ids)]

    def learnable_modules(p: Path, ent: Entitlement, docs: dict[str, KbDocument]) -> ModuleSet:
        mods = [m for m in store.list_modules(p.tenant_id, p.id) if m.status == "published"]
        return visible_to(published_content(mods, store.list_items(p.tenant_id, [m.id for m in mods])), ent, docs)

    def est_minutes(m: Module, items: list[Item]) -> int:
        return max(2, math.ceil(len(m.lesson_md.split()) / 200) + len(items))

    def sources_out(doc_ids: list[str], docs: dict[str, KbDocument], ent: Entitlement) -> list[SourceOut]:
        return [SourceOut(doc_id=d, title=docs[d].title) for d in doc_ids
                if d in docs and doc_permitted(docs[d], ent)]

    def learn_context(principal: Principal) -> tuple[Entitlement, bool, dict[str, KbDocument]]:
        """(entitlement, preview, tenant docs by id). Admins preview everything unrecorded."""
        require_enabled(principal.tenant_id)
        docs = {d.id: d for d in store.list_documents(principal.tenant_id)}
        if principal.role == "admin":
            return ADMIN_ENTITLEMENT, True, docs
        learner = learner_for(principal)
        return (learner.entitlement() if learner else Entitlement()), False, docs

    def progress_maps(principal: Principal, preview: bool
                      ) -> tuple[dict[str, ModuleProgress], dict[str, ReviewEntry]]:
        if preview:
            return {}, {}
        t, uid = principal.tenant_id, principal.uid
        return ({pr.module_id: pr for pr in store.list_progress(t, uid)},
                {r.module_id: r for r in store.list_reviews(t, uid)})

    def summarize(p: Path, mods: ModuleSet, progress: dict[str, ModuleProgress],
                  reviews: dict[str, ReviewEntry], assignment: Assignment | None = None) -> LearnPathOut:
        summaries = []
        for m, items in mods:
            pr, rv = progress.get(m.id), reviews.get(m.id)
            summaries.append(LearnModuleSummary(
                id=m.id, position=m.position, title=m.title, est_minutes=est_minutes(m, items),
                item_count=len(items), passed=bool(pr and pr.passed),
                best_score=pr.best_score if pr else None, review_due_at=rv.due_at if rv else None))
        attempted = [progress[m.id] for m, _ in mods if m.id in progress]
        passed = sum(s.passed for s in summaries)
        status = "passed" if summaries and passed == len(summaries) else \
            "in_progress" if attempted else "assigned"
        if assignment and assignment.status == "certified":
            status = "certified"
        score = round(sum(pr.best_score for pr in attempted) / len(mods), 3) \
            if mods and len(attempted) == len(mods) else None
        due_at = assignment.due_at if assignment else None
        overdue = bool(due_at and status in ("assigned", "in_progress")
                       and _parse_ts(due_at) < datetime.now(timezone.utc))
        return LearnPathOut(id=p.id, title=p.title, pass_mark=float(p.pass_mark), status=status,
                            score=score, modules_total=len(summaries), modules_passed=passed,
                            modules=summaries, due_at=due_at, overdue=overdue,
                            certified_at=assignment.certified_at if assignment else None)

    def visible_paths(tenant_id: str, ent: Entitlement, docs: dict[str, KbDocument]
                      ) -> list[tuple[Path, ModuleSet]]:
        out = []
        for p in sorted(store.list_paths(tenant_id), key=lambda p: str(p.created_at)):
            if path_assigned(p, ent):
                mods = learnable_modules(p, ent, docs)
                if mods:
                    out.append((p, mods))
        return out

    def find_module(tenant_id: str, module_id: str, ent: Entitlement, docs: dict[str, KbDocument]
                    ) -> tuple[Path, Module, list[Item], ModuleSet]:
        m = store.get_module(tenant_id, module_id)
        p = store.get_path(tenant_id, m.path_id) if m else None
        if p and path_assigned(p, ent):
            mods = learnable_modules(p, ent, docs)
            for mod, items in mods:
                if mod.id == module_id:
                    return p, mod, items, mods
        raise HTTPException(status_code=404, detail="Lesson not found")

    def ensure_learner_row(principal: Principal) -> None:
        """Attempts and progress reference learners(uid). A learner with no profile
        gets a public-clearance row, exactly what they could already see."""
        t, uid = principal.tenant_id, principal.uid
        if store.get_learner(t, uid):
            return
        email = (principal.email or "").strip().lower()
        if not email or store.get_learner_by_email(t, email):
            email = f"{uid}@users.invalid"
        store.ensure_tenant(t, t)
        store.upsert_learner(Learner(uid=uid, tenant_id=t, email=email, clearance=PUBLIC))
        store.audit(t, uid, "learner.self_registered")

    def assignments_for(principal: Principal, paths: list[Path], now: datetime) -> dict[str, Assignment]:
        """A path is assigned the first time it applies to a learner who opens Academy;
        that is when its due window starts."""
        t, uid = principal.tenant_id, principal.uid
        existing = {a.path_id: a for a in store.list_assignments(t, uid)} if paths else {}
        missing = [p for p in paths if p.id not in existing]
        if missing:
            ensure_learner_row(principal)
            for p in missing:
                days = (p.rules or {}).get("due_days")
                a = Assignment(t, uid, p.id, assigned_at=now.isoformat(),
                               due_at=(now + timedelta(days=int(days))).isoformat() if days else None)
                store.upsert_assignment(a)
                existing[p.id] = a
        return existing

    @router.get("/learn/plan", response_model=PlanOut)
    def learn_plan(principal: AuthDep) -> PlanOut:
        ent, preview, docs = learn_context(principal)
        progress, reviews = progress_maps(principal, preview)
        paths = visible_paths(principal.tenant_id, ent, docs)
        now = datetime.now(timezone.utc)
        assignments = {} if preview else assignments_for(principal, [p for p, _ in paths], now)
        due, upcoming = [], []
        for p, mods in paths:
            for m, items in mods:
                entry = PlanEntry(kind="review", path_id=p.id, path_title=p.title, module_id=m.id,
                                  module_title=m.title, est_minutes=est_minutes(m, items))
                rv, pr = reviews.get(m.id), progress.get(m.id)
                if rv and _parse_ts(rv.due_at) <= now:
                    due.append(entry)
                elif not (pr and pr.passed):
                    upcoming.append(entry.model_copy(update={"kind": "next"}))
        today, minutes = list(due), sum(e.est_minutes for e in due)
        for e in upcoming[:PLAN_MAX_NEW]:
            if today and minutes + e.est_minutes > PLAN_MINUTES:
                break
            today.append(e)
            minutes += e.est_minutes
        return PlanOut(preview=preview, clearance=ent.clearance, department=ent.department, role=ent.role,
                       paths=[summarize(p, mods, progress, reviews, assignments.get(p.id)) for p, mods in paths],
                       today=today, today_minutes=minutes, reviews_due=len(due))

    @router.get("/learn/paths/{path_id}", response_model=LearnPathOut)
    def learn_path(path_id: str, principal: AuthDep) -> LearnPathOut:
        ent, preview, docs = learn_context(principal)
        p = store.get_path(principal.tenant_id, path_id)
        mods = learnable_modules(p, ent, docs) if p and path_assigned(p, ent) else []
        if not p or not mods:
            raise HTTPException(status_code=404, detail="Path not found")
        progress, reviews = progress_maps(principal, preview)
        assignment = None if preview else store.get_assignment(principal.tenant_id, principal.uid, p.id)
        return summarize(p, mods, progress, reviews, assignment)

    @router.get("/learn/modules/{module_id}", response_model=LearnModuleOut)
    def learn_module(module_id: str, principal: AuthDep) -> LearnModuleOut:
        ent, preview, docs = learn_context(principal)
        p, m, items, _ = find_module(principal.tenant_id, module_id, ent, docs)
        progress, reviews = progress_maps(principal, preview)
        pr, rv = progress.get(m.id), reviews.get(m.id)
        return LearnModuleOut(
            id=m.id, path_id=p.id, path_title=p.title, position=m.position, title=m.title,
            lesson_md=m.lesson_md, est_minutes=est_minutes(m, items), pass_mark=float(p.pass_mark),
            sources=sources_out(m.source_doc_ids, docs, ent),
            items=[LearnItemOut(id=i.id, type=i.type, stem=i.stem, options=i.options) for i in items],
            progress=ProgressOut(best_score=pr.best_score, last_score=pr.last_score, passed=pr.passed,
                                 attempts=pr.attempts, completed_at=pr.completed_at) if pr else None,
            review_due_at=rv.due_at if rv else None)

    @router.post("/learn/modules/{module_id}/submit", response_model=SubmitOut)
    def submit_module(module_id: str, body: SubmitIn, principal: AuthDep) -> SubmitOut:
        ent, preview, docs = learn_context(principal)
        t, uid = principal.tenant_id, principal.uid
        p, m, items, mods = find_module(t, module_id, ent, docs)
        by_id = {i.id: i for i in items}
        answers: dict[str, Any] = {}
        for a in body.answers:
            if a.item_id not in by_id:
                raise HTTPException(status_code=422, detail="That question isn't part of this lesson")
            if a.item_id in answers:
                raise HTTPException(status_code=422, detail="Answer each question once per submission")
            answers[a.item_id] = a.response
        if items and not answers:
            raise HTTPException(status_code=422, detail="Answer at least one question")
        if any(by_id[i].type in FREE_TEXT for i in answers):
            enforce_quota(t)
        try:
            grades = [(it, grade_item(it, answers.get(it.id), free_text_grader)) for it in items]
        except Exception as exc:
            log.error("academy grading failed tenant=%s module=%s: %s", t, module_id, exc)
            raise HTTPException(status_code=502, detail="Grading is unavailable right now. "
                                "Nothing was saved; try again in a minute.") from exc
        score = round(sum(g.score for _, g in grades) / len(grades), 3) if grades else 1.0
        passed = score >= float(p.pass_mark)

        progress, reviews = progress_maps(principal, preview)
        if not preview:
            now = datetime.now(timezone.utc)
            now_s = now.isoformat()
            ensure_learner_row(principal)
            store.add_attempts([Attempt(t, uid, it.id, m.id, answers[it.id], g.score, g.feedback, g.model)
                                for it, g in grades if it.id in answers])
            prev = progress.get(m.id)
            progress[m.id] = ModuleProgress(
                t, uid, m.id, p.id, best_score=max(score, prev.best_score if prev else 0.0),
                last_score=score, passed=passed or bool(prev and prev.passed),
                attempts=(prev.attempts if prev else 0) + 1,
                completed_at=(prev.completed_at if prev and prev.completed_at else (now_s if passed else None)))
            store.upsert_progress(progress[m.id])

            # Spaced review: any miss → back in a day; clean passes of a due review
            # step through +3 and +7 days, then the module leaves the queue.
            rv = reviews.get(m.id)
            if any(not g.correct for _, g in grades):
                rv = ReviewEntry(t, uid, m.id, (now + timedelta(days=REVIEW_STEPS[0])).isoformat(),
                                 REVIEW_STEPS[0])
                store.upsert_review(rv)
            elif rv and _parse_ts(rv.due_at) <= now:
                step = next((s for s in REVIEW_STEPS if s > rv.interval_days), None)
                if step:
                    rv = ReviewEntry(t, uid, m.id, (now + timedelta(days=step)).isoformat(), step)
                    store.upsert_review(rv)
                else:
                    store.delete_review(t, uid, m.id)
                    rv = None
            if rv:
                reviews[m.id] = rv
            else:
                reviews.pop(m.id, None)

            prev_a = store.get_assignment(t, uid, p.id) or Assignment(t, uid, p.id, assigned_at=now_s)
            base = summarize(p, mods, progress, reviews)
            done = base.status == "passed"
            assignment = replace(
                prev_a, score=base.score,
                status="certified" if prev_a.status == "certified" else ("passed" if done else "in_progress"),
                started_at=prev_a.started_at or now_s,
                completed_at=prev_a.completed_at or (now_s if done else None))
            store.upsert_assignment(assignment)
            summary = summarize(p, mods, progress, reviews, assignment)
            store.audit(t, uid, f"learn.submit:{m.id}:{score}")
        else:
            summary = summarize(p, mods, progress, reviews)

        rv = reviews.get(m.id)
        return SubmitOut(
            module_id=m.id, score=score, passed=passed, pass_mark=float(p.pass_mark), preview=preview,
            review_due_at=rv.due_at if rv else None, path=summary,
            results=[ItemResultOut(
                item_id=it.id, type=it.type, correct=g.correct, score=g.score, feedback=g.feedback,
                explanation=it.explanation,
                correct_answer=None if it.type in FREE_TEXT else it.answer,
                model_answer=it.rubric if it.type in FREE_TEXT else None,
                sources=sources_out(it.source_doc_ids, docs, ent)) for it, g in grades])

    # ── Path settings, sign-off, certificates, dashboard (M4) ─────────────────
    @router.patch("/paths/{path_id}", response_model=PathOut)
    def update_path_settings(path_id: str, body: PathSettingsIn, principal: AuthDep) -> PathOut:
        require_role(principal, "admin")
        t = principal.tenant_id
        p = owned_path(t, path_id)
        sent = body.model_fields_set
        if "title" in sent and body.title is not None:
            p.title = body.title.strip()
        if "pass_mark" in sent and body.pass_mark is not None:
            p.pass_mark = round(body.pass_mark, 3)
        if "due_days" in sent:
            p.rules = {**(p.rules or {}), "due_days": body.due_days}
            for a in store.list_assignments(t):      # open assignments follow the new window
                if a.path_id == p.id and a.status in ("assigned", "in_progress") and a.assigned_at:
                    a.due_at = ((_parse_ts(a.assigned_at) + timedelta(days=body.due_days)).isoformat()
                                if body.due_days else None)
                    store.upsert_assignment(a)
        store.update_path(p)
        store.audit(t, principal.uid, f"path.settings:{path_id}")
        return path_out(p)

    @router.post("/paths/{path_id}/learners/{uid}/certify", response_model=CertifyOut)
    def certify(path_id: str, uid: str, principal: AuthDep) -> CertifyOut:
        """Manager sign-off: a learner who passed every lesson becomes certified."""
        require_role(principal, "admin")
        t = principal.tenant_id
        owned_path(t, path_id)
        a = store.get_assignment(t, uid, path_id)
        if not a or a.status not in ("passed", "certified"):
            raise HTTPException(status_code=409, detail="Only a learner who has passed every lesson can be signed off")
        if a.status != "certified":
            a.status, a.certified_at = "certified", datetime.now(timezone.utc).isoformat()
            a.certified_by = principal.email or principal.uid
            store.upsert_assignment(a)
            store.audit(t, principal.uid, f"path.certify:{path_id}:{uid}")
        return CertifyOut(ok=True, certified_at=str(a.certified_at),
                          certificate_id=certificate_id(t, uid, path_id, str(a.certified_at)))

    def certificate_response(t: str, uid: str, path_id: str) -> Response:
        p = store.get_path(t, path_id)
        a = store.get_assignment(t, uid, path_id)
        if not p or not a or a.status != "certified" or not a.certified_at:
            raise HTTPException(status_code=404, detail="Certificate not found")
        lr = store.get_learner(t, uid)
        pdf = render_certificate(
            company=company_name(t), learner=(lr.name or lr.email) if lr else uid, path_title=p.title,
            score=a.score, completed_at=a.completed_at, certified_at=str(a.certified_at),
            certified_by=a.certified_by, cert_id=certificate_id(t, uid, path_id, str(a.certified_at)))
        slug = re.sub(r"[^A-Za-z0-9]+", "-", p.title).strip("-")[:60] or "path"
        return Response(pdf, media_type="application/pdf", headers={
            "Content-Disposition": f'attachment; filename="{slug}-certificate.pdf"', "Cache-Control": "no-store"})

    @router.get("/learn/paths/{path_id}/certificate")
    def my_certificate(path_id: str, principal: AuthDep) -> Response:
        require_enabled(principal.tenant_id)
        return certificate_response(principal.tenant_id, principal.uid, path_id)

    @router.get("/paths/{path_id}/learners/{uid}/certificate")
    def learner_certificate(path_id: str, uid: str, principal: AuthDep) -> Response:
        require_role(principal, "admin")
        return certificate_response(principal.tenant_id, uid, path_id)

    @router.get("/dashboard", response_model=DashboardOut)
    def dashboard(principal: AuthDep) -> DashboardOut:
        require_role(principal, "admin")
        t = principal.tenant_id
        docs = {d.id: d for d in store.list_documents(t)}
        progress_by: dict[str, dict[str, ModuleProgress]] = {}
        for pr in store.list_progress(t):
            progress_by.setdefault(pr.learner_uid, {})[pr.module_id] = pr
        assignment_by = {(a.learner_uid, a.path_id): a for a in store.list_assignments(t)}

        # One read per path; learners are then matched in memory.
        content_by_path: dict[str, tuple[Path, ModuleSet]] = {}
        item_index: dict[str, tuple[Item, Module | None, Path]] = {}
        stale: list[DashStale] = []
        for p in sorted(store.list_paths(t), key=lambda p: str(p.created_at)):
            if p.status in ("generating", "failed"):
                continue
            mods = store.list_modules(t, p.id)
            items = store.list_items(t, [m.id for m in mods])
            by_id = {m.id: m for m in mods}
            item_index.update({i.id: (i, by_id.get(i.module_id), p) for i in items})
            stale_l, stale_q = sum(m.status == "stale" for m in mods), sum(i.status == "stale" for i in items)
            if stale_l or stale_q:
                stale.append(DashStale(path_id=p.id, title=p.title, status=p.status,
                                       stale_lessons=stale_l, stale_questions=stale_q))
            content = published_content(mods, items)
            if content:
                content_by_path[p.id] = (p, content)

        funnel = {pid: {"eligible": 0, "started": 0, "passed": 0, "certified": 0, "overdue": 0,
                        "scores": [], "days": []} for pid in content_by_path}
        learners_out: list[DashLearner] = []
        for lr in sorted(store.list_learners(t), key=lambda lr: lr.email):
            ent, prog = lr.entitlement(), progress_by.get(lr.uid, {})
            rows = []
            for pid, (p, content) in content_by_path.items():
                mods = visible_to(content, ent, docs) if path_assigned(p, ent) else []
                if not mods:
                    continue
                a = assignment_by.get((lr.uid, pid))
                sm = summarize(p, mods, prog, {}, a)
                f = funnel[pid]
                f["eligible"] += 1
                f["started"] += sm.status != "assigned"
                f["certified"] += sm.status == "certified"
                f["overdue"] += sm.overdue
                if sm.status in ("passed", "certified"):
                    f["passed"] += 1
                    if sm.score is not None:
                        f["scores"].append(sm.score)
                    start = a and (a.assigned_at or a.started_at)
                    if start and a.completed_at:
                        f["days"].append((_parse_ts(a.completed_at) - _parse_ts(start)).total_seconds() / 86400)
                rows.append(DashLearnerPath(
                    path_id=pid, title=p.title, status=sm.status, score=sm.score,
                    modules_passed=sm.modules_passed, modules_total=sm.modules_total,
                    assigned_at=a.assigned_at if a else None, due_at=sm.due_at, overdue=sm.overdue,
                    completed_at=a.completed_at if a else None, certified_at=sm.certified_at,
                    weak_modules=[m.title for m, _ in mods if m.id in prog and not prog[m.id].passed]))
            last = max((str(pr.updated_at) for pr in prog.values() if pr.updated_at), default=None)
            learners_out.append(DashLearner(
                uid=lr.uid, email=lr.email, name=lr.name, department=lr.department, role=lr.role,
                pending=lr.pending, last_active=last, paths=rows))

        paths_out = [DashPath(
            id=pid, title=p.title, status=p.status, pass_mark=float(p.pass_mark),
            due_days=(p.rules or {}).get("due_days"), lessons=len(content),
            eligible=f["eligible"], started=f["started"], passed=f["passed"], certified=f["certified"],
            overdue=f["overdue"], avg_score=round(statistics.mean(f["scores"]), 3) if f["scores"] else None,
            median_days_to_ready=round(statistics.median(f["days"]), 1) if f["days"] else None)
            for pid, (p, content) in content_by_path.items() for f in [funnel[pid]]]

        agg: dict[str, list[float]] = {}
        for item_id, score in store.list_attempt_scores(t):
            if item_id in item_index:
                agg.setdefault(item_id, []).append(score)
        ranked = sorted(((iid, len(v), sum(v) / len(v)) for iid, v in agg.items()
                         if len(v) >= HARDEST_MIN_ATTEMPTS and sum(v) / len(v) < 1.0),
                        key=lambda x: (x[2], -x[1]))[:HARDEST_LIMIT]
        hardest = [DashItem(item_id=iid, stem=it.stem, type=it.type, module_title=mod.title if mod else "",
                            path_id=p.id, path_title=p.title, attempts=n, avg_score=round(avg, 3))
                   for iid, n, avg in ranked for it, mod, p in [item_index[iid]]]

        groups: dict[str, DashGap] = {}
        for g in store.list_gaps(t):                 # newest first: keep the latest phrasing
            key = " ".join(re.findall(r"[a-z0-9]+", g.question.lower()))
            if key in groups:
                groups[key].count += 1
            elif key:
                groups[key] = DashGap(question=g.question, count=1, last_asked=str(g.created_at))
        gaps = sorted(groups.values(), key=lambda gp: (gp.count, gp.last_asked), reverse=True)[:GAPS_LIMIT]

        totals = DashTotals(
            learners=len(learners_out), not_signed_in=sum(lr.pending for lr in learners_out),
            assignments=sum(f["eligible"] for f in funnel.values()),
            in_progress=sum(f["started"] - f["passed"] for f in funnel.values()),
            completed=sum(f["passed"] for f in funnel.values()),
            awaiting_signoff=sum(f["passed"] - f["certified"] for f in funnel.values()),
            certified=sum(f["certified"] for f in funnel.values()),
            overdue=sum(f["overdue"] for f in funnel.values()))
        return DashboardOut(totals=totals, paths=paths_out, learners=learners_out,
                            hardest=hardest, gaps=gaps, stale=stale)

    return router
