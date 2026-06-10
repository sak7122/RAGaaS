from __future__ import annotations

import io
import json
import logging
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Annotated

from fastapi import Depends, FastAPI, File, Header, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from pypdf import PdfReader

from backend.config import config
from backend.firebase_services import Principal, QUERY_LIMIT, create_usage_store, verify_firebase_token

# ── Structured logging ────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format='{"time":"%(asctime)s","level":"%(levelname)s","msg":"%(message)s"}',
    datefmt="%Y-%m-%dT%H:%M:%SZ",
)
log = logging.getLogger("ragaas")

# ── Constants ─────────────────────────────────────────────────────────────────
DATA_DIR = Path("local_data")
UPLOAD_DIR = DATA_DIR / "uploads"
INDEX_FILE = DATA_DIR / "index.json"
MAX_UPLOAD_BYTES = 50 * 1024 * 1024
PDF_MAGIC = b"%PDF"

# Dev-only mock tokens — empty in production (sec fix #1)
TOKEN_TENANT_MAP: dict[str, str] = (
    {
        "mock-tenant-token-abc": "tenant-demo",
        "tenant-a-token": "tenant-a",
        "tenant-b-token": "tenant-b",
    }
    if config.env == "development"
    else {}
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

usage_store = create_usage_store()
log.info("startup env=%s emulator=%s", config.env, config.use_emulator)


# ── Models ────────────────────────────────────────────────────────────────────
class ChatRequest(BaseModel):
    message: str = Field(min_length=1, max_length=4000)


class Citation(BaseModel):
    file_name: str
    chunk_index: int
    excerpt: str


class ChatResponse(BaseModel):
    answer: str
    citations: list[Citation]
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


# ── Auth ──────────────────────────────────────────────────────────────────────
def principal_from_auth(authorization: Annotated[str | None, Header()] = None) -> Principal:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing bearer token")
    token = authorization.removeprefix("Bearer ").strip()
    tenant_id = TOKEN_TENANT_MAP.get(token)
    if tenant_id:
        return Principal(uid=f"dev-{tenant_id}", tenant_id=tenant_id)
    return verify_firebase_token(token)


# ── Index helpers ─────────────────────────────────────────────────────────────
def load_index() -> dict:
    if not INDEX_FILE.exists():
        return {"documents": []}
    try:
        return json.loads(INDEX_FILE.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as exc:
        log.error("index.json unreadable (%s), starting with empty index", exc)
        return {"documents": []}


def save_index(index: dict) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    INDEX_FILE.write_text(json.dumps(index, indent=2), encoding="utf-8")


# ── PDF helpers ───────────────────────────────────────────────────────────────
def safe_filename(name: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9_.-]+", "_", name).strip("._")
    return cleaned or "upload.pdf"


def assert_safe_path(resolved: Path, base: Path) -> None:
    """Sec fix #3: prevent path traversal."""
    try:
        resolved.relative_to(base.resolve())
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid filename")


def chunk_text(text: str, chunk_size: int = 512) -> list[str]:
    """Split text into ~chunk_size character chunks at word boundaries."""
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
    """Parse PDF bytes → list of {page, chunk_index, text} dicts."""
    try:
        reader = PdfReader(io.BytesIO(content))
        result = []
        for page_num, page in enumerate(reader.pages, start=1):
            page_text = (page.extract_text() or "").strip()
            for idx, chunk in enumerate(chunk_text(page_text)):
                result.append({"page": page_num, "chunk_index": idx, "text": chunk})
    except Exception as exc:
        log.warning("PDF parse failed: %s", exc)
        raise HTTPException(status_code=400, detail="Could not parse PDF — file may be corrupted or encrypted")
    non_empty = [c for c in result if c["text"].strip()]
    if not non_empty:
        raise HTTPException(status_code=400, detail="PDF contains no extractable text")
    return non_empty


def tokenize(text: str) -> set[str]:
    return {w for w in re.findall(r"[a-z0-9]{3,}", text.lower())}


def enforce_quota(tenant_id: str) -> int:
    return usage_store.increment_or_reject(tenant_id)


# ── Routes ────────────────────────────────────────────────────────────────────
@app.get("/api/health")
def health() -> dict:
    return {"ok": True, "env": config.env, "time": datetime.now(timezone.utc).isoformat()}


@app.get("/api/tenant/status", response_model=TenantStatus)
def tenant_status(principal: Annotated[Principal, Depends(principal_from_auth)]) -> TenantStatus:
    tenant_id = principal.tenant_id
    docs = [d for d in load_index()["documents"] if d["tenant_id"] == tenant_id]
    return TenantStatus(
        tenant_id=tenant_id,
        queries_used=usage_store.get_count(tenant_id),
        query_limit=QUERY_LIMIT,
        documents=len(docs),
    )


@app.get("/api/documents", response_model=list[DocumentMeta])
def list_documents(principal: Annotated[Principal, Depends(principal_from_auth)]) -> list[DocumentMeta]:
    tenant_id = principal.tenant_id
    docs = [d for d in load_index()["documents"] if d["tenant_id"] == tenant_id]
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
    tenant_id = principal.tenant_id
    safe_name = safe_filename(file_name)
    index = load_index()
    before = len(index["documents"])
    index["documents"] = [
        d for d in index["documents"]
        if not (d["tenant_id"] == tenant_id and d["file_name"] == safe_name)
    ]
    if len(index["documents"]) == before:
        raise HTTPException(status_code=404, detail="Document not found")
    # Remove file from disk
    disk_path = (UPLOAD_DIR / tenant_id / safe_name).resolve()
    assert_safe_path(disk_path, UPLOAD_DIR / tenant_id)
    if disk_path.exists():
        disk_path.unlink()
    save_index(index)
    log.info("deleted document tenant=%s file=%s", tenant_id, safe_name)
    return {"ok": True, "file_name": safe_name}


@app.post("/api/upload")
async def upload_document(
    request: Request,
    principal: Annotated[Principal, Depends(principal_from_auth)],
    file: UploadFile = File(...),
) -> dict:
    tenant_id = principal.tenant_id

    # Sec fix #2: check Content-Length before reading
    content_length = request.headers.get("content-length")
    if content_length and int(content_length) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="Upload exceeds 50 MB limit")

    content = await file.read()

    # Sec fix #2b: hard size check after read
    if len(content) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="Upload exceeds 50 MB limit")

    # Sec fix #4: magic bytes — validate real PDF regardless of extension
    if content[:4] != PDF_MAGIC:
        raise HTTPException(status_code=400, detail="File is not a valid PDF")

    if not file.filename:
        raise HTTPException(status_code=400, detail="Filename required")

    tenant_dir = UPLOAD_DIR / tenant_id
    tenant_dir.mkdir(parents=True, exist_ok=True)
    file_name = safe_filename(file.filename)

    # Sec fix #3: path traversal guard
    disk_path = (tenant_dir / file_name).resolve()
    assert_safe_path(disk_path, tenant_dir)

    disk_path.write_bytes(content)

    # Sec fix #5: wrap PDF parsing, use chunks instead of raw pages
    try:
        chunks = extract_chunks(content)

        index = load_index()
        index["documents"] = [
            d for d in index["documents"]
            if not (d["tenant_id"] == tenant_id and d["file_name"] == file_name)
        ]
        index["documents"].append({
            "tenant_id": tenant_id,
            "file_name": file_name,
            "path": str(disk_path),
            "chunks": chunks,
            "uploaded_at": datetime.now(timezone.utc).isoformat(),
        })
        save_index(index)
    except HTTPException:
        disk_path.unlink(missing_ok=True)
        raise
    except Exception as exc:
        disk_path.unlink(missing_ok=True)
        log.error("upload failed after write, file cleaned up: %s", exc)
        raise HTTPException(status_code=500, detail="Failed to index document") from exc

    log.info("upload tenant=%s file=%s chunks=%d", tenant_id, file_name, len(chunks))
    return {"tenant_id": tenant_id, "file_name": file_name, "chunks": len(chunks)}


@app.post("/api/chat", response_model=ChatResponse)
def chat(req: ChatRequest, principal: Annotated[Principal, Depends(principal_from_auth)]) -> ChatResponse:
    tenant_id = principal.tenant_id
    queries_used = enforce_quota(tenant_id)
    query_terms = tokenize(req.message)
    docs = [d for d in load_index()["documents"] if d["tenant_id"] == tenant_id]
    matches: list[Citation] = []

    for doc in docs:
        chunks = doc.get("chunks") or [
            {"page": i + 1, "chunk_index": 0, "text": p}
            for i, p in enumerate(doc.get("pages", []))
        ]
        for chunk in chunks:
            score = len(query_terms & tokenize(chunk["text"]))
            if score:
                excerpt = chunk["text"][:280].replace("\n", " ")
                matches.append(Citation(
                    file_name=doc["file_name"],
                    chunk_index=chunk["chunk_index"],
                    excerpt=excerpt,
                ))
            if len(matches) >= 3:
                break
        if len(matches) >= 3:
            break

    if not matches:
        answer = "I cannot find that answer in this tenant's uploaded documents."
    else:
        files = ", ".join(sorted({m.file_name for m in matches}))
        answer = f"Local mock RAG found relevant tenant-scoped context in {files}."

    log.info("chat tenant=%s terms=%d matches=%d queries_used=%d",
             tenant_id, len(query_terms), len(matches), queries_used)
    return ChatResponse(
        answer=answer,
        citations=matches[:3],
        tenant_id=tenant_id,
        queries_used=queries_used,
        query_limit=QUERY_LIMIT,
    )


@app.post("/api/dev/reset")
def reset_dev_state() -> dict:
    if config.env == "production":
        raise HTTPException(status_code=403, detail="Not available in production")
    usage_store.reset()
    log.info("quota reset by dev endpoint")
    return {"ok": True}
