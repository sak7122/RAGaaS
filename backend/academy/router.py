"""Academy HTTP routes (M0: KB upload, learner profiles, entitlement-scoped ask).

No `from __future__ import annotations` here: FastAPI must resolve the local
AuthDep alias at definition time, and string annotations would hide it.
"""
import logging
import re
from pathlib import PurePath
from typing import Annotated, Callable

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel, Field

from backend.academy.search import KnowledgeSearch
from backend.academy.store import (
    ADMIN_ENTITLEMENT, AcademyStore, Entitlement, KbDocument, Learner, new_doc_id,
)
from backend.firebase_services import Principal

log = logging.getLogger("ragaas.academy")

MIME_BY_EXT = {
    ".pdf": "application/pdf",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".txt": "text/plain",
    ".md": "text/plain",   # Vertex AI Search has no markdown type; plain text indexes fine
}
_TAG_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,39}$")
_NAME_RE = re.compile(r"[^A-Za-z0-9._-]+")


# ── Models ────────────────────────────────────────────────────────────────────
class AcademyDocOut(BaseModel):
    id: str
    title: str
    sensitivity: int
    dept_tags: list[str]
    role_tags: list[str]
    updated_at: str


class LearnerIn(BaseModel):
    email: str = Field(min_length=3, max_length=254)
    role: str | None = Field(default=None, max_length=40)
    department: str | None = Field(default=None, max_length=40)
    seniority: int = Field(default=1, ge=1, le=5)
    clearance: int = Field(default=1, ge=0, le=2)


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

    def entitlement_for(principal: Principal) -> Entitlement:
        if principal.role == "admin":
            return ADMIN_ENTITLEMENT
        learner = store.get_learner(principal.tenant_id, principal.uid)
        # No profile yet → public content only, until an admin sets clearance.
        return learner.entitlement() if learner else Entitlement()

    def require_enabled(tenant_id: str) -> None:
        if not search.enabled_for(tenant_id):
            raise HTTPException(status_code=404, detail="Academy is not enabled for this workspace")

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

        doc_id = new_doc_id()
        doc = KbDocument(
            id=doc_id, tenant_id=tenant_id, title=name,
            storage_path=f"{tenant_id}/{doc_id}/{name}", sensitivity=sensitivity,
            dept_tags=parse_tags(dept_tags), role_tags=parse_tags(role_tags),
            owner_email=principal.email,
        )

        store.ensure_tenant(tenant_id, tenant_id)
        store.upload_file(doc.storage_path, content, mime)
        try:
            search.import_document(doc, content, mime)
        except ValueError as exc:
            raise HTTPException(status_code=413, detail=str(exc)) from exc
        store.add_document(doc)
        store.audit(tenant_id, principal.uid, f"kb.upload:{doc.id}")
        log.info("academy upload tenant=%s doc=%s sens=%d", tenant_id, doc.id, sensitivity)
        return AcademyDocOut(id=doc.id, title=doc.title, sensitivity=doc.sensitivity,
                             dept_tags=doc.dept_tags, role_tags=doc.role_tags,
                             updated_at=doc.updated_at)

    @router.get("/documents", response_model=list[AcademyDocOut])
    def list_docs(principal: AuthDep) -> list[AcademyDocOut]:
        require_role(principal, "admin", "uploader")
        return [AcademyDocOut(id=d.id, title=d.title, sensitivity=d.sensitivity,
                              dept_tags=d.dept_tags, role_tags=d.role_tags,
                              updated_at=str(d.updated_at))
                for d in store.list_documents(principal.tenant_id)]

    @router.put("/learners/{uid}")
    def upsert_learner(uid: str, body: LearnerIn, principal: AuthDep) -> dict:
        require_role(principal, "admin")
        store.ensure_tenant(principal.tenant_id, principal.tenant_id)
        store.upsert_learner(Learner(
            uid=uid, tenant_id=principal.tenant_id, email=body.email,
            role=_clean_tag(body.role), department=_clean_tag(body.department),
            seniority=body.seniority, clearance=body.clearance,
        ))
        store.audit(principal.tenant_id, principal.uid, f"learner.upsert:{uid}")
        return {"ok": True, "uid": uid}

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

    return router
