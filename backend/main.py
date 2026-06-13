from __future__ import annotations

import io
import json
import logging
import os
import re
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Annotated

from fastapi import Depends, FastAPI, File, Header, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from pypdf import PdfReader

from backend.config import config
from backend.firebase_services import (
    MemberRecord,
    Principal,
    QUERY_LIMIT,
    create_member_store,
    create_usage_store,
    verify_firebase_token,
)
from backend.storage import create_storage_backend
from backend.index_store import create_index_store

# ── Structured logging ────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format='{"time":"%(asctime)s","level":"%(levelname)s","msg":"%(message)s"}',
    datefmt="%Y-%m-%dT%H:%M:%SZ",
)
log = logging.getLogger("ragaas")

# ── Constants ─────────────────────────────────────────────────────────────────
DATA_DIR       = Path("local_data")
UPLOAD_DIR     = DATA_DIR / "uploads"
INDEX_FILE     = DATA_DIR / "index.json"
MAX_UPLOAD_BYTES = 50 * 1024 * 1024
PDF_MAGIC      = b"%PDF"
VALID_ROLES    = {"admin", "uploader", "viewer"}
# Retrieval engine label surfaced in the UI. Set to the real engine once wired.
RAG_ENGINE_LABEL = os.getenv("RAG_ENGINE_LABEL", "Vertex AI Search")

# Dev-only mock tokens — empty dict in production
TOKEN_TENANT_MAP: dict[str, str] = (
    {
        "mock-tenant-token-abc": "tenant-demo",
        "tenant-a-token":        "tenant-a",
        "tenant-b-token":        "tenant-b",
    }
    if config.env == "development" else {}
)

if config.env == "development":
    log.info("dev mode: mock token map active (%d tokens)", len(TOKEN_TENANT_MAP))

# ── App ───────────────────────────────────────────────────────────────────────
app = FastAPI(title="RAGaaS API", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=config.cors_origin_regex,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["*"],
)

usage_store   = create_usage_store()
member_store  = create_member_store()
storage       = create_storage_backend(config.env, UPLOAD_DIR, config.gcs_bucket)
index_store   = create_index_store(config.env, INDEX_FILE)
log.info("startup env=%s emulator=%s", config.env, config.use_emulator)


# ── Models ────────────────────────────────────────────────────────────────────
class ChatRequest(BaseModel):
    message: str = Field(min_length=1, max_length=4000)


class Citation(BaseModel):
    file_name: str
    page: int
    chunk_index: int
    excerpt: str
    score: float = 0.0          # normalized relevance 0..1


class RetrievalTrace(BaseModel):
    engine: str                 # retrieval engine label
    query_terms: list[str]      # terms extracted from the question
    chunks_searched: int        # total chunks scanned for this tenant
    candidates_ranked: int      # chunks with a non-zero score
    top_k: int                  # how many returned
    max_score: float            # best relevance score
    latency_ms: int             # retrieval time


class ChatResponse(BaseModel):
    answer: str
    citations: list[Citation]
    retrieval: RetrievalTrace
    tenant_id: str
    queries_used: int
    query_limit: int


class TenantStatus(BaseModel):
    tenant_id: str
    queries_used: int
    query_limit: int
    documents: int


class DocumentMeta(BaseModel):
    file_name: str
    chunks: int
    uploaded_at: str


class MemberOut(BaseModel):
    uid: str
    email: str
    role: str
    invited_at: str
    joined_at: str | None


class InviteRequest(BaseModel):
    email: str = Field(min_length=3, max_length=254)
    role: str = Field(default="viewer")


class RoleRequest(BaseModel):
    role: str


# ── Auth & role guards ────────────────────────────────────────────────────────
def principal_from_auth(authorization: Annotated[str | None, Header()] = None) -> Principal:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing bearer token")
    token = authorization.removeprefix("Bearer ").strip()
    tenant_id = TOKEN_TENANT_MAP.get(token)
    if tenant_id:
        # Dev mock tokens always get admin so all endpoints are testable
        return Principal(uid=f"dev-{tenant_id}", tenant_id=tenant_id, role="admin")
    return verify_firebase_token(token, member_store)


def require_role(principal: Principal, *roles: str) -> None:
    if principal.role not in roles:
        raise HTTPException(
            status_code=403,
            detail=f"Role '{principal.role}' cannot perform this action. Required: {list(roles)}",
        )


# load_index / save_index kept for test compatibility only (dev local store)
def load_index() -> dict:
    if not INDEX_FILE.exists():
        return {"documents": []}
    return json.loads(INDEX_FILE.read_text(encoding="utf-8"))


def save_index(index: dict) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    INDEX_FILE.write_text(json.dumps(index, indent=2), encoding="utf-8")


# ── PDF helpers ───────────────────────────────────────────────────────────────
def safe_filename(name: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9_.-]+", "_", name).strip("._")
    return cleaned or "upload.pdf"


def assert_safe_path(resolved: Path, base: Path) -> None:
    try:
        resolved.relative_to(base.resolve())
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid filename")


def chunk_text(text: str, chunk_size: int = 512) -> list[str]:
    words = text.split()
    chunks, current, length = [], [], 0
    for word in words:
        if length + len(word) + 1 > chunk_size and current:
            chunks.append(" ".join(current))
            current, length = [], 0
        current.append(word)
        length += len(word) + 1
    if current:
        chunks.append(" ".join(current))
    return chunks or [""]


def extract_chunks(content: bytes) -> list[dict]:
    try:
        reader = PdfReader(io.BytesIO(content))
        result = []
        for page_num, page in enumerate(reader.pages, start=1):
            page_text = (page.extract_text() or "").strip()
            for idx, chunk in enumerate(chunk_text(page_text)):
                result.append({"page": page_num, "chunk_index": idx, "text": chunk})
        return result or [{"page": 1, "chunk_index": 0, "text": ""}]
    except Exception as exc:
        log.warning("PDF parse failed: %s", exc)
        raise HTTPException(
            status_code=400,
            detail="Could not parse PDF — file may be corrupted or encrypted",
        )


def tokenize(text: str) -> set[str]:
    return {w for w in re.findall(r"[a-z0-9]{3,}", text.lower())}


def enforce_quota(tenant_id: str) -> int:
    return usage_store.increment_or_reject(tenant_id)


# ── Routes: health ────────────────────────────────────────────────────────────
@app.get("/api/health")
def health() -> dict:
    return {"ok": True, "env": config.env, "time": datetime.now(timezone.utc).isoformat()}


# ── Routes: tenant status ─────────────────────────────────────────────────────
@app.get("/api/tenant/status", response_model=TenantStatus)
def tenant_status(principal: Annotated[Principal, Depends(principal_from_auth)]) -> TenantStatus:
    tenant_id = principal.tenant_id
    docs = index_store.list_docs(tenant_id)
    return TenantStatus(
        tenant_id=tenant_id,
        queries_used=usage_store.get_count(tenant_id),
        query_limit=QUERY_LIMIT,
        documents=len(docs),
    )


# ── Routes: documents ─────────────────────────────────────────────────────────
@app.get("/api/documents", response_model=list[DocumentMeta])
def list_documents(principal: Annotated[Principal, Depends(principal_from_auth)]) -> list[DocumentMeta]:
    docs = index_store.list_docs(principal.tenant_id)
    return [
        DocumentMeta(
            file_name=d["file_name"],
            chunks=len(d.get("chunks", d.get("pages", []))),
            uploaded_at=d["uploaded_at"],
        )
        for d in docs
    ]


@app.delete("/api/documents/{file_name}")
def delete_document(
    file_name: str,
    principal: Annotated[Principal, Depends(principal_from_auth)],
) -> dict:
    require_role(principal, "admin")
    tenant_id = principal.tenant_id
    safe_name = safe_filename(file_name)
    deleted = index_store.delete_doc(tenant_id, safe_name)
    if not deleted:
        raise HTTPException(status_code=404, detail="Document not found")
    storage.delete(tenant_id, safe_name)
    log.info("deleted document tenant=%s file=%s", tenant_id, safe_name)
    return {"ok": True, "file_name": safe_name}


# ── Routes: upload ────────────────────────────────────────────────────────────
@app.post("/api/upload")
async def upload_document(
    request: Request,
    principal: Annotated[Principal, Depends(principal_from_auth)],
    file: UploadFile = File(...),
) -> dict:
    require_role(principal, "admin", "uploader")
    tenant_id = principal.tenant_id

    content_length = request.headers.get("content-length")
    if content_length and int(content_length) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="Upload exceeds 50 MB limit")

    content = await file.read()
    if len(content) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="Upload exceeds 50 MB limit")
    if content[:4] != PDF_MAGIC:
        raise HTTPException(status_code=400, detail="File is not a valid PDF")
    if not file.filename:
        raise HTTPException(status_code=400, detail="Filename required")

    file_name = safe_filename(file.filename)
    chunks = extract_chunks(content)
    uri = storage.upload(tenant_id, file_name, content)

    index_store.upsert_doc(tenant_id, {
        "tenant_id": tenant_id,
        "file_name": file_name,
        "storage_uri": uri,
        "chunks": chunks,
        "uploaded_at": datetime.now(timezone.utc).isoformat(),
    })
    log.info("upload tenant=%s file=%s chunks=%d uri=%s", tenant_id, file_name, len(chunks), uri)
    return {"tenant_id": tenant_id, "file_name": file_name, "chunks": len(chunks)}


# ── Routes: chat ──────────────────────────────────────────────────────────────
@app.post("/api/chat", response_model=ChatResponse)
def chat(req: ChatRequest, principal: Annotated[Principal, Depends(principal_from_auth)]) -> ChatResponse:
    tenant_id = principal.tenant_id
    queries_used = enforce_quota(tenant_id)
    query_terms = tokenize(req.message)
    docs = index_store.list_docs(tenant_id)

    started = time.perf_counter()
    scored: list[tuple[float, Citation]] = []
    chunks_searched = 0
    denom = max(len(query_terms), 1)

    for doc in docs:
        chunks = doc.get("chunks") or [
            {"page": i + 1, "chunk_index": 0, "text": p}
            for i, p in enumerate(doc.get("pages", []))
        ]
        for chunk in chunks:
            chunks_searched += 1
            overlap = len(query_terms & tokenize(chunk["text"]))
            if overlap:
                # Normalize to 0..1 so the UI can render a relevance bar
                score = round(overlap / denom, 4)
                scored.append((score, Citation(
                    file_name=doc["file_name"],
                    page=chunk.get("page", 1),
                    chunk_index=chunk["chunk_index"],
                    excerpt=chunk["text"][:280].replace("\n", " "),
                    score=score,
                )))

    scored.sort(key=lambda t: t[0], reverse=True)
    top = scored[:3]
    matches = [c for _, c in top]
    latency_ms = max(int((time.perf_counter() - started) * 1000), 1)

    if not matches:
        answer = "I cannot find that answer in your uploaded documents."
    else:
        files = ", ".join(sorted({m.file_name for m in matches}))
        answer = (
            f"Based on your documents ({files}), here is the relevant content. "
            f"[Wire Vertex AI + Gemini to replace this with a real generated answer.]"
        )

    retrieval = RetrievalTrace(
        engine=RAG_ENGINE_LABEL,
        query_terms=sorted(query_terms),
        chunks_searched=chunks_searched,
        candidates_ranked=len(scored),
        top_k=len(matches),
        max_score=top[0][0] if top else 0.0,
        latency_ms=latency_ms,
    )

    log.info(
        "chat tenant=%s terms=%d searched=%d ranked=%d matches=%d latency_ms=%d queries_used=%d",
        tenant_id, len(query_terms), chunks_searched, len(scored), len(matches), latency_ms, queries_used,
    )
    return ChatResponse(
        answer=answer,
        citations=matches,
        retrieval=retrieval,
        tenant_id=tenant_id,
        queries_used=queries_used,
        query_limit=QUERY_LIMIT,
    )


# ── Routes: members ───────────────────────────────────────────────────────────
@app.get("/api/tenant/members", response_model=list[MemberOut])
def list_members(principal: Annotated[Principal, Depends(principal_from_auth)]) -> list[MemberOut]:
    require_role(principal, "admin")
    members = member_store.get_members(principal.tenant_id)
    return [MemberOut(uid=m.uid, email=m.email, role=m.role, invited_at=m.invited_at, joined_at=m.joined_at)
            for m in members]


@app.post("/api/tenant/invite", status_code=201)
def invite_member(
    body: InviteRequest,
    principal: Annotated[Principal, Depends(principal_from_auth)],
) -> dict:
    require_role(principal, "admin")
    if body.role not in VALID_ROLES:
        raise HTTPException(status_code=400, detail=f"Invalid role. Must be one of {list(VALID_ROLES)}")
    tenant_id = principal.tenant_id
    now = datetime.now(timezone.utc).isoformat()
    uid = f"invited-{re.sub(r'[^a-z0-9]', '-', body.email.lower())}"

    # Prevent duplicate email
    existing = member_store.get_members(tenant_id)
    if any(m.email == body.email for m in existing):
        raise HTTPException(status_code=409, detail="Member with this email already exists")

    member = MemberRecord(uid=uid, email=body.email, role=body.role, invited_at=now, joined_at=None)
    member_store.add_member(tenant_id, member)

    # Dev: log invite link instead of sending email
    invite_link = f"http://localhost:5173/?invite={uid}&tenant={tenant_id}"
    log.info("invite tenant=%s email=%s role=%s link=%s", tenant_id, body.email, body.role, invite_link)
    return {"ok": True, "uid": uid, "invite_link": invite_link}


@app.patch("/api/tenant/members/{uid}")
def update_member_role(
    uid: str,
    body: RoleRequest,
    principal: Annotated[Principal, Depends(principal_from_auth)],
) -> dict:
    require_role(principal, "admin")
    if body.role not in VALID_ROLES:
        raise HTTPException(status_code=400, detail=f"Invalid role. Must be one of {list(VALID_ROLES)}")
    tenant_id = principal.tenant_id
    members = member_store.get_members(tenant_id)
    if not any(m.uid == uid for m in members):
        raise HTTPException(status_code=404, detail="Member not found")
    member_store.update_role(tenant_id, uid, body.role)
    log.info("role_change tenant=%s uid=%s role=%s by=%s", tenant_id, uid, body.role, principal.uid)
    return {"ok": True, "uid": uid, "role": body.role}


@app.delete("/api/tenant/members/{uid}")
def remove_member(
    uid: str,
    principal: Annotated[Principal, Depends(principal_from_auth)],
) -> dict:
    require_role(principal, "admin")
    tenant_id = principal.tenant_id
    # Prevent self-removal
    if uid == principal.uid:
        raise HTTPException(status_code=400, detail="Cannot remove yourself")
    members = member_store.get_members(tenant_id)
    if not any(m.uid == uid for m in members):
        raise HTTPException(status_code=404, detail="Member not found")
    member_store.remove_member(tenant_id, uid)
    log.info("remove_member tenant=%s uid=%s by=%s", tenant_id, uid, principal.uid)
    return {"ok": True, "uid": uid}


# ── Routes: tenant hard-erase ─────────────────────────────────────────────────
@app.delete("/api/tenant")
def delete_tenant(principal: Annotated[Principal, Depends(principal_from_auth)]) -> dict:
    require_role(principal, "admin")
    tenant_id = principal.tenant_id

    # Delete all files and index entries for this tenant
    storage.delete_tenant(tenant_id)
    removed = index_store.delete_tenant(tenant_id)

    # Clear usage counters and members
    usage_store.reset_tenant(tenant_id)
    member_store.delete_tenant(tenant_id)

    log.info("tenant_erased tenant=%s docs=%d by=%s", tenant_id, removed, principal.uid)
    return {"ok": True, "tenant_id": tenant_id, "documents_removed": removed}


# ── Routes: dev reset ─────────────────────────────────────────────────────────
@app.post("/api/dev/reset")
def reset_dev_state() -> dict:
    if config.env == "production":
        raise HTTPException(status_code=403, detail="Not available in production")
    usage_store.reset()
    log.info("quota reset by dev endpoint")
    return {"ok": True}
