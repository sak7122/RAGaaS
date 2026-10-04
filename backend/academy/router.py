"""Academy HTTP routes.

M0: KB upload, learner profiles, entitlement-scoped ask.
M1: document versioning + deletion with stale marking, learner list / CSV import
    (pending learners matched by email on first sign-in).
M2: learning-path generation (topics → lessons → quiz items) with review,
    editing and publishing.

No `from __future__ import annotations` here: FastAPI must resolve the local
AuthDep alias at definition time, and string annotations would hide it.
"""
import csv
import hashlib
import io
import logging
import re
from datetime import datetime, timedelta, timezone
from pathlib import PurePath
from typing import Annotated, Any, Callable, Literal

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from pydantic import BaseModel, Field

from backend.academy.course import CourseGenerator
from backend.academy.search import KnowledgeSearch, doc_permitted
from backend.academy.store import (
    ADMIN_ENTITLEMENT, PENDING_PREFIX, AcademyStore, Entitlement, Item, KbDocument,
    Learner, Module, Path, new_id,
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
    type: Literal["mcq", "true_false"]
    options: list[str] | None = None
    answer: int | bool
    explanation: str | None = Field(default=None, max_length=1000)


# ── Helpers ───────────────────────────────────────────────────────────────────
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
                      seniority=lr.seniority, clearance=lr.clearance, pending=lr.pending)


def _item_out(i: Item) -> ItemOut:
    return ItemOut(id=i.id, module_id=i.module_id, type=i.type, stem=i.stem, options=i.options,
                   answer=i.answer, explanation=i.explanation, source_doc_ids=i.source_doc_ids,
                   status=i.status)


def validate_item_edit(body: ItemEdit) -> tuple[list[str] | None, int | bool]:
    if body.type == "mcq":
        opts = [o.strip() for o in (body.options or [])]
        if len(opts) != 4 or any(not o or len(o) > 300 for o in opts) or len({o.lower() for o in opts}) != 4:
            raise HTTPException(status_code=422, detail="Multiple-choice needs 4 different, non-empty options")
        if isinstance(body.answer, bool) or not 0 <= int(body.answer) <= 3:
            raise HTTPException(status_code=422, detail="Answer must be the index (0-3) of the correct option")
        return opts, int(body.answer)
    if not isinstance(body.answer, bool):
        raise HTTPException(status_code=422, detail="True/false answer must be true or false")
    return None, body.answer


def parse_learners_csv(text: str) -> tuple[list[dict], list[dict]]:
    """CSV columns (header row required): email, department, role, clearance, seniority.
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
        rows.append({"email": email, "department": dept, "role": role,
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
) -> APIRouter:
    router = APIRouter(prefix="/api/academy", tags=["academy"])
    AuthDep = Annotated[Principal, Depends(auth)]
    generator = CourseGenerator(search)

    def entitlement_for(principal: Principal) -> Entitlement:
        if principal.role == "admin":
            return ADMIN_ENTITLEMENT
        learner = store.get_learner(principal.tenant_id, principal.uid)
        if learner is None and principal.email:
            # Imported by CSV before they signed up → claim the row on first sight.
            pending = store.get_learner_by_email(principal.tenant_id, principal.email)
            if pending and pending.pending:
                store.rekey_learner(principal.tenant_id, pending.uid, principal.uid)
                store.audit(principal.tenant_id, principal.uid, "learner.claimed")
                pending.uid = principal.uid
                learner = pending
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
                "clearance": ent.clearance, "department": ent.department, "role": ent.role}

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
                           "questions_per_module": body.questions_per_module})
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
                                        explanation=di.explanation, source_doc_ids=di.source_doc_ids))
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
        for m in modules:
            m.status = "published"; store.update_module(m)
        for i in store.list_items(tenant_id, [m.id for m in modules]):
            if i.status != "stale":
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
        it.options, it.answer = validate_item_edit(body)
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

    return router
