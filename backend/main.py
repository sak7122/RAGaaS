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
from docx import Document

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
from backend.rag import create_embedder, create_generator
from backend.insights import create_insights_store
from backend.tenant_profile import create_tenant_profile_store, prettify

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
ZIP_MAGIC      = b"PK\x03\x04"  # docx is a zip container — disambiguate by extension
VALID_ROLES    = {"admin", "uploader", "viewer"}
# Retrieval engine label surfaced in the UI. Accurate for the DIY hybrid path;
# set RAG_ENGINE_LABEL="Vertex AI Search" if you migrate to managed retrieval.
RAG_ENGINE_LABEL = os.getenv("RAG_ENGINE_LABEL", "Hybrid Vector Search")
HYBRID_VECTOR_WEIGHT = 0.7   # blend: 0.7*cosine + 0.3*keyword overlap

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
embedder      = create_embedder()
generator     = create_generator()
insights_store = create_insights_store(config.env)
tenant_profile_store = create_tenant_profile_store(config.env)
log.info("startup env=%s emulator=%s embedder=%s generator=%s",
         config.env, config.use_emulator, type(embedder).__name__, type(generator).__name__)


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
    tenant_name: str
    queries_used: int
    query_limit: int
    documents: int


class TenantProfileRequest(BaseModel):
    name: str = Field(min_length=1, max_length=80)


class DocumentMeta(BaseModel):
    file_name: str
    chunks: int
    uploaded_at: str


class QuestionStat(BaseModel):
    question: str
    count: int
    avg_score: float


class KnowledgeGap(BaseModel):
    question: str
    count: int
    best_score: float
    avg_score: float


class InsightsResponse(BaseModel):
    total_queries: int
    avg_confidence: float
    answered_rate: float
    top_questions: list[QuestionStat]
    gaps: list[KnowledgeGap]
    window: int


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


# ── Document helpers ──────────────────────────────────────────────────────────
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


def _extract_pdf_chunks(content: bytes) -> list[dict]:
    try:
        reader = PdfReader(io.BytesIO(content))
        result = []
        for page_num, page in enumerate(reader.pages, start=1):
            page_text = (page.extract_text() or "").strip()
            for idx, chunk in enumerate(chunk_text(page_text)):
                if chunk.strip():               # skip empty chunks (blank/image pages)
                    result.append({"page": page_num, "chunk_index": idx, "text": chunk})
        # No selectable text -> almost certainly a scanned/image PDF (needs OCR).
        if not result:
            raise HTTPException(
                status_code=422,
                detail=("No selectable text found in this PDF. It looks like a scanned or "
                        "image-only document — OCR isn't supported yet. Upload a text-based PDF."),
            )
        return result
    except HTTPException:
        raise
    except Exception as exc:
        log.warning("PDF parse failed: %s", exc)
        raise HTTPException(
            status_code=400,
            detail="Could not parse PDF — file may be corrupted or encrypted",
        )


def _extract_docx_chunks(content: bytes) -> list[dict]:
    try:
        doc = Document(io.BytesIO(content))
        # Paragraphs + table cells — docx has no reliable page boundaries, so page=1.
        parts = [p.text for p in doc.paragraphs]
        for table in doc.tables:
            for row in table.rows:
                parts.extend(cell.text for cell in row.cells)
        full_text = "\n".join(t for t in parts if t and t.strip())
        result = [
            {"page": 1, "chunk_index": idx, "text": chunk}
            for idx, chunk in enumerate(chunk_text(full_text))
            if chunk.strip()
        ]
        if not result:
            raise HTTPException(
                status_code=422,
                detail="No text found in this Word document. Upload a document that contains text.",
            )
        return result
    except HTTPException:
        raise
    except Exception as exc:
        log.warning("DOCX parse failed: %s", exc)
        raise HTTPException(
            status_code=400,
            detail="Could not parse Word document — file may be corrupted. Legacy .doc isn't supported; save as .docx.",
        )


def extract_chunks(content: bytes, file_name: str) -> list[dict]:
    ext = file_name.rsplit(".", 1)[-1].lower() if "." in file_name else ""
    if content[:4] == PDF_MAGIC:
        return _extract_pdf_chunks(content)
    if ext == "docx" and content[:4] == ZIP_MAGIC:
        return _extract_docx_chunks(content)
    raise HTTPException(
        status_code=400,
        detail="Unsupported file type. Upload a PDF or a Word (.docx) document.",
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
    name = tenant_profile_store.get_name(tenant_id) or prettify(tenant_id)
    return TenantStatus(
        tenant_id=tenant_id,
        tenant_name=name,
        queries_used=usage_store.get_count(tenant_id),
        query_limit=QUERY_LIMIT,
        documents=len(docs),
    )


@app.put("/api/tenant/profile")
def set_tenant_profile(
    body: TenantProfileRequest,
    principal: Annotated[Principal, Depends(principal_from_auth)],
) -> dict:
    require_role(principal, "admin")
    tenant_profile_store.set_name(principal.tenant_id, body.name.strip())
    log.info("tenant_name set tenant=%s name=%s", principal.tenant_id, body.name.strip())
    return {"ok": True, "tenant_name": body.name.strip()}


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
    if not file.filename:
        raise HTTPException(status_code=400, detail="Filename required")

    file_name = safe_filename(file.filename)
    chunks = extract_chunks(content, file_name)  # PDF or .docx; rejects others
    uri = storage.upload(tenant_id, file_name, content)

    # Embed each chunk so it is retrievable by vector similarity
    try:
        vectors = embedder.embed([c["text"] for c in chunks])
        for c, v in zip(chunks, vectors):
            c["embedding"] = v
    except Exception as exc:
        log.warning("embedding failed for %s (%s); stored without vectors", file_name, exc)

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
    denom = max(len(query_terms), 1)

    started = time.perf_counter()
    docs = index_store.list_docs(tenant_id)
    total_chunks = sum(len(d.get("chunks") or d.get("pages", [])) for d in docs)

    # 1) Vector retrieval (top candidates by cosine)
    candidates: list[dict] = []
    try:
        q_vec = embedder.embed_query(req.message)
        candidates = index_store.vector_search(tenant_id, q_vec, k=20)
    except Exception as exc:
        log.warning("vector search failed (%s); keyword fallback", exc)

    # 2) Fallback: if no embedded chunks, scan all chunks (keyword only)
    if not candidates:
        for doc in docs:
            chunks = doc.get("chunks") or [
                {"page": i + 1, "chunk_index": 0, "text": p}
                for i, p in enumerate(doc.get("pages", []))
            ]
            for ch in chunks:
                candidates.append({
                    "file_name": doc["file_name"],
                    "page": ch.get("page", 1),
                    "chunk_index": ch.get("chunk_index", 0),
                    "text": ch.get("text", ""),
                    "vec_score": 0.0,
                })

    # 3) Hybrid score: blend cosine with keyword overlap
    ranked: list[tuple[float, dict]] = []
    for c in candidates:
        kw = len(query_terms & tokenize(c["text"])) / denom
        vec = float(c.get("vec_score", 0.0))
        score = HYBRID_VECTOR_WEIGHT * vec + (1 - HYBRID_VECTOR_WEIGHT) * kw
        if score > 0:
            ranked.append((round(score, 4), c))

    ranked.sort(key=lambda t: t[0], reverse=True)
    top = ranked[:3]
    top_chunks = [c for _, c in top]

    answer = generator.generate(req.message, top_chunks)

    citations = [
        Citation(
            file_name=c["file_name"],
            page=c.get("page", 1),
            chunk_index=c.get("chunk_index", 0),
            excerpt=c["text"][:280].replace("\n", " "),
            score=s,
        )
        for s, c in top
    ]
    latency_ms = max(int((time.perf_counter() - started) * 1000), 1)

    retrieval = RetrievalTrace(
        engine=RAG_ENGINE_LABEL,
        query_terms=sorted(query_terms),
        chunks_searched=total_chunks,
        candidates_ranked=len(ranked),
        top_k=len(citations),
        max_score=top[0][0] if top else 0.0,
        latency_ms=latency_ms,
    )

    # Record for knowledge analytics + gap detection
    insights_store.record(tenant_id, req.message, retrieval.max_score)

    log.info(
        "chat tenant=%s terms=%d searched=%d ranked=%d matches=%d latency_ms=%d queries_used=%d",
        tenant_id, len(query_terms), total_chunks, len(ranked), len(citations), latency_ms, queries_used,
    )
    return ChatResponse(
        answer=answer,
        citations=citations,
        retrieval=retrieval,
        tenant_id=tenant_id,
        queries_used=queries_used,
        query_limit=QUERY_LIMIT,
    )


# ── Routes: insights (knowledge analytics + gap detection) ────────────────────
@app.get("/api/insights", response_model=InsightsResponse)
def get_insights(principal: Annotated[Principal, Depends(principal_from_auth)]) -> InsightsResponse:
    require_role(principal, "admin")
    data = insights_store.summary(principal.tenant_id)
    return InsightsResponse(**data)


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

    # Clear usage counters, members, and profile
    usage_store.reset_tenant(tenant_id)
    member_store.delete_tenant(tenant_id)
    tenant_profile_store.delete_tenant(tenant_id)

    log.info("tenant_erased tenant=%s docs=%d by=%s", tenant_id, removed, principal.uid)
    return {"ok": True, "tenant_id": tenant_id, "documents_removed": removed}


# ── Routes: dev reset ─────────────────────────────────────────────────────────
@app.post("/api/dev/reset")
def reset_dev_state() -> dict:
    if config.env == "production":
        raise HTTPException(status_code=403, detail="Not available in production")
    usage_store.reset()
    insights_store.reset()
    log.info("quota + insights reset by dev endpoint")
    return {"ok": True}
