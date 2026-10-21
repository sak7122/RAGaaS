from __future__ import annotations

import asyncio
import hashlib
import hmac
import io
import json
import logging
import os
import re
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Annotated, Literal

from fastapi import BackgroundTasks, Depends, FastAPI, File, Header, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, PlainTextResponse, StreamingResponse
from pydantic import BaseModel, Field, field_validator
from pypdf import PdfReader
from docx import Document
from starlette.concurrency import run_in_threadpool
from starlette.middleware.base import BaseHTTPMiddleware

from backend.config import config
from backend.firebase_services import (
    MemberRecord,
    Principal,
    QUERY_LIMIT,
    create_member_store,
    set_tenant_claim,
    create_usage_store,
    verify_firebase_token,
)
from backend.storage import create_storage_backend
from backend.index_store import chunk_count, create_index_store
from backend.rag import NOT_FOUND_ANSWER, create_embedder, create_generator
from backend.doc_profile import SAMPLE_CHUNKS, build_profile, extractive_profile, profile_is_current
from backend.insights import GAP_THRESHOLD, create_insights_store
from backend.tenant_profile import create_tenant_profile_store, prettify
from backend.mailer import send_email, send_invite_email, smtp_configured
from backend.share_store import create_share_store
from backend.widget_store import create_widget_key_store
from backend.slack_store import create_slack_store
from backend.conversations import create_conversation_store
from backend.digest import build_digest, create_digest_store
from backend import billing
from backend.ingest import SUPPORTED_LABEL, chunk_text, fetch_page
from backend.ingest import extract_chunks as ingest_extract
from backend import whatsapp as wa
from backend.whatsapp import to_whatsapp
from backend.whatsapp_store import create_whatsapp_store
from backend.planner import create_planner
from backend.academy.router import create_academy_router
from backend.academy.search import create_knowledge_search
from backend.academy.store import create_academy_store
from backend.workflow import SolveRequest, WorkflowSolution, ToolCall
from backend.tools import (
    ToolServices,
    create_tool_registry,
    create_audit_store,
    create_tool_executor,
)

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
MAX_UPLOAD_BYTES = 30 * 1024 * 1024   # Cloud Run caps HTTP/1 request bodies at 32 MiB
PDF_MAGIC      = b"%PDF"
ZIP_MAGIC      = b"PK\x03\x04"  # docx is a zip container — disambiguate by extension
VALID_ROLES    = {"admin", "uploader", "viewer"}
# Retrieval engine label surfaced in the UI. Accurate for the DIY hybrid path;
# set RAG_ENGINE_LABEL="Vertex AI Search" if you migrate to managed retrieval.
RAG_ENGINE_LABEL = os.getenv("RAG_ENGINE_LABEL", "Hybrid Vector Search")
HYBRID_VECTOR_WEIGHT = 0.7   # blend: 0.7*cosine + 0.3*keyword overlap
SLACK_SIGNING_SECRET = os.getenv("SLACK_SIGNING_SECRET", "").strip()

# Dev-only mock tokens — empty dict in production
TOKEN_TENANT_MAP: dict[str, str] = (
    {
        "mock-tenant-token-abc": "tenant-demo",
        "tenant-a-token":        "tenant-a",
        "tenant-b-token":        "tenant-b",
    }
    if config.env == "development" else {}
)

# Dev-only non-admin learners for Academy demos: token -> (tenant, uid).
# Their profiles (department/clearance) come from scripts/academy_demo_seed.py.
DEV_LEARNER_TOKENS: dict[str, tuple[str, str]] = (
    {
        "demo-sales-token": ("tenant-demo", "demo-sales"),
        "demo-eng-token":   ("tenant-demo", "demo-eng"),
        "demo-new-token":   ("tenant-demo", "demo-new"),
    }
    if config.env == "development" else {}
)

if config.env == "development":
    log.info("dev mode: mock token map active (%d tokens)", len(TOKEN_TENANT_MAP))

# ── Widget / Share CORS ───────────────────────────────────────────────────────
# Widget routes and public share reads must be accessible from any origin
# (widget embeds on 3rd-party sites). Widget keys replace browser credentials so
# allow_credentials is NOT set, which is compatible with Access-Control-Allow-Origin: *.
class WidgetCORSMiddleware(BaseHTTPMiddleware):
    _WIDGET_PATHS = ("/api/widget/", "/api/share/")

    async def dispatch(self, request: Request, call_next):
        is_widget = any(request.url.path.startswith(p) for p in self._WIDGET_PATHS)
        if is_widget and request.method == "OPTIONS":
            return JSONResponse(
                {},
                headers={
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
                    "Access-Control-Allow-Headers": "Content-Type, X-Widget-Key",
                },
            )
        response = await call_next(request)
        if is_widget:
            response.headers["Access-Control-Allow-Origin"] = "*"
        return response


class ErrorJSONMiddleware(BaseHTTPMiddleware):
    """Turn an unexpected exception into a JSON 500 *inside* the CORS layer. Without
    this the 500 carries no CORS headers and the browser reports a bare "network
    error" instead of a message."""

    async def dispatch(self, request: Request, call_next):
        try:
            return await call_next(request)
        except Exception as exc:
            log.exception("unhandled error %s %s: %s", request.method, request.url.path, exc)
            return JSONResponse({"detail": "Something went wrong on our side. Please try again."}, status_code=500)


# ── App ───────────────────────────────────────────────────────────────────────
app = FastAPI(title="RAGaaS API", version="0.1.0")
app.add_middleware(ErrorJSONMiddleware)   # added first = innermost: runs inside CORS
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=config.cors_origin_regex,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["*"],
)
app.add_middleware(WidgetCORSMiddleware)  # outer layer — handles widget/share/slack paths

usage_store          = create_usage_store()
member_store         = create_member_store()
storage              = create_storage_backend(config.env, UPLOAD_DIR, config.gcs_bucket)
index_store          = create_index_store(config.env, INDEX_FILE)
embedder             = create_embedder()
generator            = create_generator()
insights_store       = create_insights_store(config.env)
tenant_profile_store = create_tenant_profile_store(config.env)
share_store          = create_share_store(config.env)
widget_key_store     = create_widget_key_store(config.env)
slack_store          = create_slack_store(config.env)
whatsapp_store       = create_whatsapp_store(config.env)
conversation_store   = create_conversation_store(config.env)
digest_store         = create_digest_store(config.env)
billing_store        = billing.create_billing_store(config.env)
planner              = create_planner()
# generate_document needs the LLM + retrieval; lambdas resolve module globals at
# call time (retrieve_chunks is defined further down — fine, only invoked later).
tool_registry        = create_tool_registry(ToolServices(
    generate=lambda instruction, chunks: generator.generate(instruction, chunks, []),
    retrieve=lambda tid, query, k: retrieve_chunks(tid, query, k),
    publish=lambda payload: f"{config.app_base_url}/share/{share_store.create(payload)}",
))
audit_store          = create_audit_store(config.env)
tool_executor        = create_tool_executor(config.env, tool_registry, audit_store)
academy_store        = create_academy_store()
academy_search       = create_knowledge_search()
log.info("startup env=%s emulator=%s embedder=%s generator=%s planner=%s tools=%d",
         config.env, config.use_emulator, type(embedder).__name__, type(generator).__name__,
         type(planner).__name__, len(tool_registry.specs()))


# ── Models ────────────────────────────────────────────────────────────────────
HISTORY_TURN_CHARS = 2000


class TurnHistory(BaseModel):
    role: str   # "user" or "assistant"
    text: str

    # Answers often run past 2,000 characters; rejecting them made every later
    # question fail with a 422. Only the start of a turn matters for context.
    @field_validator("text")
    @classmethod
    def _clip(cls, v: str) -> str:
        return v[:HISTORY_TURN_CHARS]


class ChatRequest(BaseModel):
    message: str = Field(min_length=1, max_length=4000)
    history: list[TurnHistory] = Field(default_factory=list, max_length=4)
    # Documents picked in the Ask page; None or [] searches every document.
    file_names: list[str] | None = Field(default=None, max_length=50)
    # Saved conversation to append this turn to; None starts a new one.
    conversation_id: str | None = Field(default=None, max_length=64)


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
    scoped_to: list[str] = Field(default_factory=list)  # picked documents; empty = all


class ChatResponse(BaseModel):
    answer: str
    citations: list[Citation]
    retrieval: RetrievalTrace
    tenant_id: str
    queries_used: int
    query_limit: int
    answer_id: str | None = None          # for 👍/👎 feedback; None when not recorded
    conversation_id: str | None = None


class FeedbackRequest(BaseModel):
    answer_id: str = Field(min_length=1, max_length=64)
    helpful: bool
    conversation_id: str | None = Field(default=None, max_length=64)


class GapAnswerRequest(BaseModel):
    question: str = Field(min_length=3, max_length=500)
    answer: str = Field(min_length=3, max_length=4000)


class ImportUrlRequest(BaseModel):
    url: str = Field(min_length=8, max_length=2000)


class DigestSubscribeRequest(BaseModel):
    on: bool


class TenantStatus(BaseModel):
    tenant_id: str
    tenant_name: str
    queries_used: int
    query_limit: int
    documents: int


class OnboardingProfile(BaseModel):
    """Answers from sign-up step 2. Closed vocabularies so they can drive
    Academy defaults (role templates, path suggestions) without free-text parsing."""
    company_size: Literal["1-10", "11-50", "51-200", "201-1000", "1000+"]
    role: Literal["founder", "hr", "lnd", "ops", "engineering", "other"]
    primary_use: Literal["onboarding", "knowledge_base", "compliance", "support"]
    country: str = Field(min_length=2, max_length=2, pattern=r"^[A-Z]{2}$")  # ISO 3166-1 alpha-2
    phone: str | None = Field(default=None, max_length=32, pattern=r"^[+0-9 ()-]*$")


class TenantProfileRequest(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    onboarding: OnboardingProfile | None = None


class DocumentMeta(BaseModel):
    file_name: str
    chunks: int
    uploaded_at: str
    # Profile for the document picker (backend/doc_profile.py)
    title: str = ""
    pages: int = 0
    summary: str = ""
    questions: list[str] = Field(default_factory=list)
    profile_source: str = ""    # "generated" (model) | "extractive"


class MemberOut(BaseModel):
    uid: str
    email: str
    role: str
    invited_at: str
    joined_at: str | None


class InviteRequest(BaseModel):
    email: str = Field(min_length=3, max_length=254)
    role: str = Field(default="viewer")


class AcceptInviteRequest(BaseModel):
    tenant_id: str = Field(min_length=1, max_length=128)
    invite_uid: str | None = None  # informational; authorization is by email


class RoleRequest(BaseModel):
    role: str


class ShareCreateRequest(BaseModel):
    question: str = Field(min_length=1, max_length=4000)
    answer: str = Field(min_length=1, max_length=20000)
    citations: list[dict] = Field(default_factory=list)


class WidgetKeyCreateRequest(BaseModel):
    label: str = Field(min_length=1, max_length=80, default="My website")


class SlackConnectRequest(BaseModel):
    team_id: str = Field(min_length=1, max_length=32)
    team_name: str = Field(min_length=1, max_length=128)


class ExecuteActionRequest(BaseModel):
    tool: str = Field(min_length=1, max_length=64)
    args: dict = Field(default_factory=dict)
    # An authenticated admin/uploader calling this with approved=True IS the
    # human approval. The executor re-checks the caller's role server-side.
    approved: bool = False
    idempotency_key: str | None = Field(default=None, max_length=128)


# ── Auth & role guards ────────────────────────────────────────────────────────
def principal_from_auth(
    authorization: Annotated[str | None, Header()] = None,
    x_widget_key: Annotated[str | None, Header()] = None,
) -> Principal:
    # Widget API key auth — viewer-only, no Firebase token needed
    if x_widget_key:
        tenant_id = widget_key_store.resolve_tenant(x_widget_key)
        if not tenant_id:
            raise HTTPException(status_code=401, detail="Invalid widget key")
        return Principal(uid="widget-user", tenant_id=tenant_id, email=None, role="viewer")
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing bearer token")
    token = authorization.removeprefix("Bearer ").strip()
    tenant_id = TOKEN_TENANT_MAP.get(token)
    if tenant_id:
        # Dev mock tokens always get admin so all endpoints are testable
        return Principal(uid=f"dev-{tenant_id}", tenant_id=tenant_id,
                         email=f"{tenant_id}@ragaas.local", role="admin")
    if token in DEV_LEARNER_TOKENS:
        tenant_id, uid = DEV_LEARNER_TOKENS[token]
        return Principal(uid=uid, tenant_id=tenant_id, email=f"{uid}@ragaas.local", role="viewer")
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


def extract_chunks(content: bytes, file_name: str) -> list[dict]:
    """Searchable chunks for any supported file; scans, photos and audio are read by
    the generator (Gemini in production)."""
    return ingest_extract(content, file_name, getattr(generator, "transcribe", None))


def tokenize(text: str) -> set[str]:
    return {w for w in re.findall(r"[a-z0-9]{3,}", text.lower())}


def enforce_quota(tenant_id: str) -> int:
    plan = billing.current_plan(billing_store, tenant_id)
    if plan.questions is not None and billing_store.questions_this_month(tenant_id) >= plan.questions:
        raise HTTPException(status_code=429, detail=(
            f"Your {plan.name} plan's {plan.questions:,} questions for this month are used up. "
            "Upgrade under Billing to keep asking."))
    used = usage_store.increment_or_reject(tenant_id)
    billing_store.count_question(tenant_id)
    return used


def require_documents_room(tenant_id: str, file_name: str) -> None:
    """Refuse a new document over the plan's limit (replacing an existing one is fine)."""
    plan = billing.current_plan(billing_store, tenant_id)
    if plan.documents is None:
        return
    names = {d["file_name"] for d in index_store.list_docs(tenant_id)} - {"team-answers.md"}
    if file_name not in names and len(names) >= plan.documents:
        raise HTTPException(status_code=403, detail=(
            f"Your {plan.name} plan includes {plan.documents} documents. Upgrade under Billing to add more."))


def require_channels(tenant_id: str, what: str) -> None:
    plan = billing.current_plan(billing_store, tenant_id)
    if not plan.channels:
        raise HTTPException(status_code=403, detail=f"{what} is included on the Team plan. Upgrade under Billing.")


def resolve_scope(tenant_id: str, file_names: list[str] | None) -> set[str] | None:
    """Documents a request is limited to, or None for all. Names not in this tenant's
    index are dropped (a picker can be stale after a delete); none left is a 400."""
    if not file_names:
        return None
    known = {d["file_name"] for d in index_store.list_docs(tenant_id)}
    scope = {safe_filename(f) for f in file_names} & known
    if not scope:
        raise HTTPException(status_code=400, detail="None of the selected documents are in this workspace.")
    return scope


def gather_candidates(tenant_id: str, search_query: str, scope: set[str] | None) -> list[dict]:
    """Vector candidates, else every chunk for keyword scoring; both limited to scope."""
    candidates: list[dict] = []
    try:
        q_vec = embedder.embed_query(search_query)
        # A scoped search filters after the nearest-neighbour query, so ask for more.
        candidates = index_store.vector_search(tenant_id, q_vec, k=30 if scope is None else 120)
    except Exception as exc:
        log.warning("vector search failed (%s); keyword fallback", exc)
    if scope is not None:
        candidates = [c for c in candidates if c["file_name"] in scope]
    if not candidates:
        pool = index_store.list_chunks(tenant_id)
        if scope is not None:
            pool = [c for c in pool if c["file_name"] in scope]
        candidates = [{**c, "vec_score": 0.0} for c in pool]
    return candidates


def distinct_top(ranked: list[tuple[float, dict]], k: int) -> list[tuple[float, dict]]:
    """Best k passages with identical text kept once. The same file uploaded twice
    otherwise fills the answer's k slots in pairs and halves the evidence it sees."""
    seen: set[str] = set()
    out: list[tuple[float, dict]] = []
    for s, c in ranked:
        key = re.sub(r"\s+", " ", c.get("text", "")).strip().lower()
        if key in seen:
            continue
        seen.add(key)
        out.append((s, c))
        if len(out) == k:
            break
    return out


def retrieve_chunks(tenant_id: str, query: str, k: int = 6,
                    history: list[dict] | None = None,
                    scope: set[str] | None = None) -> list[dict]:
    """Tenant-scoped hybrid retrieval (vector + keyword), shared by the planner.
    Returns ranked chunks: [{file_name, page, chunk_index, text, score}, ...].
    Same scoring as /api/chat; isolation is enforced at index_store level."""
    history = history or []
    search_query = query
    if hasattr(generator, "rewrite_query"):
        try:
            search_query = generator.rewrite_query(query, history)
        except Exception as exc:
            log.warning("query rewrite failed (%s); using original", exc)

    query_terms = tokenize(search_query)
    denom = max(len(query_terms), 1)

    candidates = gather_candidates(tenant_id, search_query, scope)

    ranked: list[tuple[float, dict]] = []
    for c in candidates:
        kw = len(query_terms & tokenize(c["text"])) / denom
        vec = float(c.get("vec_score", 0.0))
        score = HYBRID_VECTOR_WEIGHT * vec + (1 - HYBRID_VECTOR_WEIGHT) * kw
        if score >= 0.05:
            ranked.append((round(score, 4), c))
    ranked.sort(key=lambda t: t[0], reverse=True)

    return [
        {
            "file_name": c["file_name"], "page": c.get("page", 1),
            "chunk_index": c.get("chunk_index", 0), "text": c["text"], "score": s,
        }
        for s, c in distinct_top(ranked, k)
    ]


@dataclass
class AnswerResult:
    answer: str
    top: list[tuple[float, dict]]       # (score, chunk) passages the answer was written from
    query_terms: set[str]
    chunks_searched: int
    candidates_ranked: int
    latency_ms: int
    started: float = 0.0

    @property
    def max_score(self) -> float:
        return self.top[0][0] if self.top else 0.0

    @property
    def chunks(self) -> list[dict]:
        return [c for _, c in self.top]

    @property
    def cited_files(self) -> list[str]:
        return sorted({c["file_name"] for _, c in self.top})

    def finish(self, answer: str) -> "AnswerResult":
        self.answer = answer
        self.latency_ms = max(int((time.perf_counter() - self.started) * 1000), 1)
        return self


def answer_question(tenant_id: str, question: str, history: list[dict] | None = None,
                    scope: set[str] | None = None) -> AnswerResult:
    """One question → grounded answer. Shared by chat, Slack and WhatsApp so every
    channel gets the same retrieval (rewrite, hybrid score, dedupe, scope) and prompt.
    Callers own quota, auth and recording insights."""
    res = retrieve_for_answer(tenant_id, question, history, scope)
    return res.finish(generator.generate(question, res.chunks, history or []))


def retrieve_for_answer(tenant_id: str, question: str, history: list[dict] | None = None,
                        scope: set[str] | None = None) -> AnswerResult:
    """Everything before generation: rewrite, hybrid retrieval, dedupe."""
    history = history or []
    started = time.perf_counter()
    docs = index_store.list_docs(tenant_id)
    chunks_searched = sum(chunk_count(d) for d in docs if scope is None or d["file_name"] in scope)

    # 1) Query rewriting — expand/resolve the question for better retrieval
    search_query = question
    if hasattr(generator, "rewrite_query"):
        try:
            search_query = generator.rewrite_query(question, history)
            if search_query != question:
                log.info("query_rewrite tenant=%s original=%r rewritten=%r", tenant_id, question, search_query)
        except Exception as exc:
            log.warning("query rewrite failed (%s); using original", exc)

    query_terms = tokenize(search_query)
    denom = max(len(query_terms), 1)

    # 2-3) Vector candidates, else every chunk (keyword only); limited to picked documents
    candidates = gather_candidates(tenant_id, search_query, scope)

    # 4) Hybrid score: blend cosine with keyword overlap; drop noise below the floor
    ranked: list[tuple[float, dict]] = []
    for c in candidates:
        kw = len(query_terms & tokenize(c["text"])) / denom
        vec = float(c.get("vec_score", 0.0))
        score = HYBRID_VECTOR_WEIGHT * vec + (1 - HYBRID_VECTOR_WEIGHT) * kw
        if score >= 0.05:
            ranked.append((round(score, 4), c))
    ranked.sort(key=lambda t: t[0], reverse=True)
    top = distinct_top(ranked, 6)
    return AnswerResult(
        answer="", top=top, query_terms=query_terms, chunks_searched=chunks_searched,
        candidates_ranked=len(ranked), latency_ms=max(int((time.perf_counter() - started) * 1000), 1),
        started=started,
    )


def doc_titles(tenant_id: str) -> dict[str, str]:
    """file_name → readable title, for citing sources outside the web app."""
    return {d["file_name"]: d.get("title") or d["file_name"] for d in index_store.list_docs(tenant_id)}


def source_lines(tenant_id: str, top: list[tuple[float, dict]]) -> list[str]:
    """Unique "Title, p. N" references in the order the answer used them."""
    titles = doc_titles(tenant_id)
    out: list[str] = []
    for _, c in top:
        ref = f"{titles.get(c['file_name'], c['file_name'])}, p. {c.get('page', 1)}"
        if ref not in out:
            out.append(ref)
    return out


# ── Routes: academy (docs/PRD-onboarding.md) ─────────────────────────────────
app.include_router(create_academy_router(
    store=academy_store,
    search=academy_search,
    auth=principal_from_auth,
    require_role=require_role,
    enforce_quota=enforce_quota,
    max_upload_bytes=MAX_UPLOAD_BYTES,
    tenant_name=lambda t: tenant_profile_store.get_name(t) or prettify(t),
))


# ── Routes: health ────────────────────────────────────────────────────────────
@app.get("/api/health")
def health() -> dict:
    # kb ping doubles as the keep-alive that stops a Free-tier Supabase pausing.
    return {"ok": True, "env": config.env, "time": datetime.now(timezone.utc).isoformat(),
            "kb": academy_store.ping()}


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
    if body.onboarding is not None:
        tenant_profile_store.set_onboarding(principal.tenant_id, body.onboarding.model_dump())
    log.info("tenant_name set tenant=%s name=%s", principal.tenant_id, body.name.strip())
    return {"ok": True, "tenant_name": body.name.strip()}


# ── Routes: documents ─────────────────────────────────────────────────────────
PROFILE_FIELDS = ("title", "pages", "summary", "questions", "profile_source")


def document_meta(d: dict) -> DocumentMeta:
    return DocumentMeta(
        file_name=d["file_name"],
        chunks=chunk_count(d),
        uploaded_at=d["uploaded_at"],
        **{k: d[k] for k in PROFILE_FIELDS if d.get(k) is not None},
    )


def ensure_profile(tenant_id: str, d: dict) -> dict:
    """Backfill a profile for a document indexed before profiles existed (or with an older
    extractive one). Extractive only, so listing never waits on a model;
    POST /api/documents/{file}/profile upgrades it."""
    if profile_is_current(d):
        return d
    profile = extractive_profile(d["file_name"], index_store.doc_chunks(tenant_id, d["file_name"], SAMPLE_CHUNKS))
    profile["pages"] = max((int(c.get("page", 1)) for c in d.get("chunks", [])), default=0) or d.get("pages", 0)
    try:
        index_store.update_doc_meta(tenant_id, d["file_name"], profile)
    except Exception as exc:  # still return it; the next listing retries the write
        log.warning("profile backfill write failed tenant=%s file=%s: %s", tenant_id, d["file_name"], exc)
    return {**d, **profile}


@app.get("/api/documents", response_model=list[DocumentMeta])
def list_documents(principal: Annotated[Principal, Depends(principal_from_auth)]) -> list[DocumentMeta]:
    tenant_id = principal.tenant_id
    return [document_meta(ensure_profile(tenant_id, d)) for d in index_store.list_docs(tenant_id)]


@app.post("/api/documents/{file_name}/profile", response_model=DocumentMeta)
def regenerate_profile(
    file_name: str,
    principal: Annotated[Principal, Depends(principal_from_auth)],
) -> DocumentMeta:
    """Rebuild one document's summary and starter questions (with the model in prod)."""
    require_role(principal, "admin", "uploader")
    tenant_id = principal.tenant_id
    safe_name = safe_filename(file_name)
    doc = next((d for d in index_store.list_docs(tenant_id) if d["file_name"] == safe_name), None)
    if doc is None:
        raise HTTPException(status_code=404, detail="Document not found")
    profile = build_profile(safe_name, index_store.doc_chunks(tenant_id, safe_name, SAMPLE_CHUNKS * 4), generator)
    index_store.update_doc_meta(tenant_id, safe_name, profile)
    log.info("profile regenerated tenant=%s file=%s source=%s", tenant_id, safe_name, profile["profile_source"])
    return document_meta({**doc, **profile})


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
        raise HTTPException(status_code=413, detail="Upload exceeds 30 MB limit")

    content = await file.read()
    if len(content) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="Upload exceeds 30 MB limit")
    if not file.filename:
        raise HTTPException(status_code=400, detail="Filename required")

    file_name = safe_filename(file.filename)
    require_documents_room(tenant_id, file_name)
    chunks = extract_chunks(content, file_name)  # every supported type; rejects others
    uri = storage.upload(tenant_id, file_name, content)
    profile = index_document(tenant_id, file_name, chunks, uri)
    return {"tenant_id": tenant_id, "file_name": file_name, "chunks": len(chunks),
            "title": profile["title"], "summary": profile["summary"], "questions": profile["questions"]}


def index_document(tenant_id: str, file_name: str, chunks: list[dict], uri: str = "",
                   extra: dict | None = None, profile: dict | None = None) -> dict:
    """Embed, profile and store one document's chunks. Shared by uploads, web-page
    imports and the team-answers document. Returns the document profile."""
    try:
        vectors = embedder.embed([c["text"] for c in chunks])
        for c, v in zip(chunks, vectors):
            c["embedding"] = v
    except Exception as exc:
        # Keyword fallback still works, but answer quality drops sharply: make it loud.
        log.error("embedding failed for %s (%d chunks): %s; stored without vectors",
                  file_name, len(chunks), exc)
    # Summary + starter questions for the document picker; never fails the upload.
    profile = profile or build_profile(file_name, chunks, generator)
    index_store.upsert_doc(tenant_id, {
        "tenant_id": tenant_id,
        "file_name": file_name,
        "storage_uri": uri,
        "chunks": chunks,
        "uploaded_at": datetime.now(timezone.utc).isoformat(),
        **profile,
        **(extra or {}),
    })
    log.info("index tenant=%s file=%s chunks=%d profile=%s",
             tenant_id, file_name, len(chunks), profile.get("profile_source"))
    return profile


# ── Routes: web page import ──────────────────────────────────────────────────
@app.post("/api/import-url")
def import_url(body: ImportUrlRequest, principal: Annotated[Principal, Depends(principal_from_auth)]) -> dict:
    """Add a public web page (FAQ, policy, help article) as a document."""
    require_role(principal, "admin", "uploader")
    final_url, title, text = fetch_page(body.url.strip())
    parts = urllib.parse.urlsplit(final_url)
    slug = re.sub(r"[^a-z0-9]+", "-", f"{parts.hostname}{parts.path}".lower()).strip("-")[:80] or "page"
    file_name = safe_filename(f"{slug}.html")
    require_documents_room(principal.tenant_id, file_name)
    chunks = [{"page": 1, "chunk_index": i, "text": c} for i, c in enumerate(chunk_text(text)) if c.strip()]
    if not chunks:
        raise HTTPException(status_code=422, detail="No readable text on that page.")
    profile = index_document(principal.tenant_id, file_name, chunks, uri=final_url,
                             extra={"source_url": final_url})
    if title and profile.get("profile_source") != "generated":
        index_store.update_doc_meta(principal.tenant_id, file_name, {"title": title[:120]})
    return {"file_name": file_name, "chunks": len(chunks), "title": title or profile["title"],
            "source_url": final_url}


# ── Routes: chat ──────────────────────────────────────────────────────────────
@app.post("/api/chat", response_model=ChatResponse)
def chat(req: ChatRequest, principal: Annotated[Principal, Depends(principal_from_auth)]) -> ChatResponse:
    tenant_id = principal.tenant_id
    scope = resolve_scope(tenant_id, req.file_names)   # before the quota: a bad pick costs nothing
    queries_used = enforce_quota(tenant_id)
    history = [t.model_dump() for t in req.history]

    res = answer_question(tenant_id, req.message, history, scope)
    answer = res.answer
    citations = citations_for(res)
    retrieval = trace_for(res, scope)
    answer_id = record_answer(principal, req.message, res, scope)
    conversation_id = save_turn(principal, req.conversation_id, req.message, scope, answer,
                                citations, retrieval, answer_id)

    log.info(
        "chat tenant=%s terms=%d searched=%d ranked=%d matches=%d latency_ms=%d queries_used=%d",
        tenant_id, len(res.query_terms), res.chunks_searched, res.candidates_ranked, len(citations), res.latency_ms,
        queries_used,
    )
    return ChatResponse(
        answer=answer,
        citations=citations,
        retrieval=retrieval,
        tenant_id=tenant_id,
        queries_used=queries_used,
        query_limit=QUERY_LIMIT,
        answer_id=answer_id,
        conversation_id=conversation_id,
    )


def citations_for(res: AnswerResult) -> list[Citation]:
    return [
        Citation(file_name=c["file_name"], page=c.get("page", 1), chunk_index=c.get("chunk_index", 0),
                 excerpt=c["text"][:280].replace("\n", " "), score=s)
        for s, c in res.top
    ]


def trace_for(res: AnswerResult, scope: set[str] | None) -> RetrievalTrace:
    return RetrievalTrace(
        engine=RAG_ENGINE_LABEL, query_terms=sorted(res.query_terms), chunks_searched=res.chunks_searched,
        candidates_ranked=res.candidates_ranked, top_k=len(res.top), max_score=res.max_score,
        latency_ms=res.latency_ms, scoped_to=sorted(scope or []),
    )


def record_answer(principal: Principal, question: str, res: AnswerResult, scope: set[str] | None) -> str | None:
    """Record for knowledge analytics + gap detection. A miss inside a hand-picked
    subset says nothing about the whole knowledge base, so scoped questions only
    count once they're answered."""
    if scope is None or res.max_score >= GAP_THRESHOLD:
        return insights_store.record(principal.tenant_id, question, res.max_score, answer=res.answer,
                                     docs=res.cited_files, uid=principal.uid)
    return None


def save_turn(principal: Principal, conversation_id: str | None, question: str, scope: set[str] | None,
              answer: str, citations: list[Citation], retrieval: RetrievalTrace, answer_id: str | None) -> str | None:
    """Append the question and answer to the asker's saved conversation (new if none)."""
    if principal.uid == "widget-user":
        return None                       # anonymous widget visitors have no history
    try:
        cid = conversation_id
        now_ms = int(time.time() * 1000)
        turn = [
            {"role": "user", "text": question, "timestamp": now_ms, "scope": sorted(scope or [])},
            {"role": "assistant", "text": answer, "timestamp": now_ms, "answer_id": answer_id,
             "citations": [c.model_dump() for c in citations], "retrieval": retrieval.model_dump()},
        ]
        if not cid or not conversation_store.append(principal.tenant_id, principal.uid, cid, turn):
            cid = conversation_store.create(principal.tenant_id, principal.uid, question)
            conversation_store.append(principal.tenant_id, principal.uid, cid, turn)
        return cid
    except Exception as exc:              # history is a convenience: never fail the answer
        log.warning("save_turn failed: %s", exc)
        return conversation_id


# ── Routes: chat (streamed) ──────────────────────────────────────────────────
@app.post("/api/chat/stream")
def chat_stream(req: ChatRequest, principal: Annotated[Principal, Depends(principal_from_auth)]) -> StreamingResponse:
    """Same answer as /api/chat, sent as newline-delimited JSON while it is written:
    {"type":"meta"} (sources, known before writing) → {"type":"delta"}… → {"type":"done"}."""
    tenant_id = principal.tenant_id
    scope = resolve_scope(tenant_id, req.file_names)
    queries_used = enforce_quota(tenant_id)
    history = [t.model_dump() for t in req.history]
    res = retrieve_for_answer(tenant_id, req.message, history, scope)
    citations = citations_for(res)

    def line(obj: dict) -> bytes:
        return (json.dumps(obj, ensure_ascii=False) + "\n").encode()

    def events():
        yield line({"type": "meta", "citations": [c.model_dump() for c in citations],
                    "retrieval": trace_for(res, scope).model_dump(),
                    "queries_used": queries_used, "query_limit": QUERY_LIMIT})
        parts: list[str] = []
        try:
            for piece in generator.generate_stream(req.message, res.chunks, history):
                parts.append(piece)
                yield line({"type": "delta", "text": piece})
        except Exception as exc:
            log.warning("chat_stream generation failed tenant=%s: %s", tenant_id, exc)
            if not parts:
                parts = ["Sorry, something went wrong writing that answer. Try again."]
                yield line({"type": "delta", "text": parts[0]})
        res.finish("".join(parts).strip() or NOT_FOUND_ANSWER)
        retrieval = trace_for(res, scope)
        answer_id = record_answer(principal, req.message, res, scope)
        conversation_id = save_turn(principal, req.conversation_id, req.message, scope, res.answer,
                                    citations, retrieval, answer_id)
        log.info("chat_stream tenant=%s matches=%d latency_ms=%d", tenant_id, len(citations), res.latency_ms)
        yield line({"type": "done", "answer": res.answer, "answer_id": answer_id,
                    "conversation_id": conversation_id, "retrieval": retrieval.model_dump()})

    return StreamingResponse(events(), media_type="application/x-ndjson",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# ── Routes: answer feedback ──────────────────────────────────────────────────
@app.post("/api/feedback")
def answer_feedback(body: FeedbackRequest, principal: Annotated[Principal, Depends(principal_from_auth)]) -> dict:
    if not insights_store.feedback(principal.tenant_id, body.answer_id, body.helpful, uid=principal.uid):
        raise HTTPException(status_code=404, detail="Answer not found")
    if body.conversation_id:
        conversation_store.mark_feedback(principal.tenant_id, principal.uid, body.conversation_id,
                                         body.answer_id, body.helpful)
    return {"ok": True}


# ── Routes: saved conversations ──────────────────────────────────────────────
@app.get("/api/conversations")
def list_conversations(principal: Annotated[Principal, Depends(principal_from_auth)]) -> list[dict]:
    return conversation_store.list(principal.tenant_id, principal.uid)


@app.get("/api/conversations/{conversation_id}")
def get_conversation(conversation_id: str, principal: Annotated[Principal, Depends(principal_from_auth)]) -> dict:
    conv = conversation_store.get(principal.tenant_id, principal.uid, conversation_id)
    if not conv:
        raise HTTPException(status_code=404, detail="Conversation not found")
    return conv


@app.delete("/api/conversations/{conversation_id}")
def delete_conversation(conversation_id: str, principal: Annotated[Principal, Depends(principal_from_auth)]) -> dict:
    if not conversation_store.delete(principal.tenant_id, principal.uid, conversation_id):
        raise HTTPException(status_code=404, detail="Conversation not found")
    return {"ok": True}


# ── Routes: close a knowledge gap with a written answer ──────────────────────
TEAM_ANSWERS_FILE = "team-answers.md"
TEAM_ANSWERS_PROFILE = {
    "title": "Answers from your team", "pages": 0, "profile_source": "generated",
    "summary": "Short answers your admins wrote for questions the other documents didn't cover.",
    "questions": [],
}


@app.post("/api/gaps/answer")
def answer_gap(body: GapAnswerRequest, principal: Annotated[Principal, Depends(principal_from_auth)]) -> dict:
    """Save a written answer as part of the "Answers from your team" document, so the
    next person who asks gets it, cited like any other source."""
    require_role(principal, "admin", "uploader")
    tenant_id = principal.tenant_id
    existing = index_store.doc_chunks(tenant_id, TEAM_ANSWERS_FILE, limit=2000)
    q = body.question.strip()
    entries = [c["text"] for c in existing if not c["text"].lower().startswith(f"q: {q.lower()}\n")]
    entries.append(f"Q: {q}\nA: {body.answer.strip()}")
    chunks = [{"page": i + 1, "chunk_index": 0, "text": t} for i, t in enumerate(entries)]
    questions = [t.split("\n", 1)[0][3:] for t in entries][-4:]
    index_document(tenant_id, TEAM_ANSWERS_FILE, chunks,
                   profile={**TEAM_ANSWERS_PROFILE, "pages": len(chunks), "questions": questions})
    log.info("gap_answered tenant=%s entries=%d", tenant_id, len(chunks))
    return {"ok": True, "file_name": TEAM_ANSWERS_FILE, "entries": len(chunks)}


# ── Routes: solve (agentic workflow) ──────────────────────────────────────────
@app.post("/api/solve", response_model=WorkflowSolution)
def solve(req: SolveRequest, principal: Annotated[Principal, Depends(principal_from_auth)]) -> WorkflowSolution:
    tenant_id = principal.tenant_id
    queries_used = enforce_quota(tenant_id)  # shares the per-tenant breaker with /api/chat
    history = req.history

    def _retrieve(tid: str, query: str, k: int) -> list[dict]:
        # tid is always tenant_id (planner is tenant-bound); pass history for rewrite.
        return retrieve_chunks(tid, query, k, history)

    def _answer(question: str, chunks: list[dict]) -> str:
        # Stage 1 of solve = the exact grounded answer path /api/chat uses.
        return generator.generate(question, chunks, history)

    solution = planner.solve(tenant_id, req, _retrieve, tool_registry, _answer)
    # Server owns identity + quota fields — never trust the planner for these.
    solution.tenant_id = tenant_id
    solution.queries_used = queries_used
    solution.query_limit = QUERY_LIMIT
    log.info("solve tenant=%s steps=%d open_q=%d confidence=%.2f queries_used=%d",
             tenant_id, len(solution.steps), len(solution.open_questions),
             solution.confidence, queries_used)
    return solution


# ── Routes: actions (human-gated tool execution) ──────────────────────────────
@app.post("/api/actions/execute")
def execute_action(
    body: ExecuteActionRequest,
    principal: Annotated[Principal, Depends(principal_from_auth)],
) -> JSONResponse:
    call = ToolCall(
        tool=body.tool,
        args=body.args,
        status="approved" if body.approved else "proposed",
        idempotency_key=body.idempotency_key,
    )
    result = tool_executor.execute(principal, call)
    code = {"executed": 200, "rejected": 403, "failed": 502}.get(result.status, 400)
    log.info("action_execute tenant=%s tool=%s status=%s by=%s",
             principal.tenant_id, result.tool, result.status, principal.uid)
    return JSONResponse(
        {"ok": result.ok, "tool": result.tool, "status": result.status, "detail": result.detail},
        status_code=code,
    )


@app.get("/api/actions/audit")
def list_action_audit(principal: Annotated[Principal, Depends(principal_from_auth)]) -> list[dict]:
    require_role(principal, "admin")
    return [
        {"tool": e.tool, "status": e.status, "actor_uid": e.actor_uid,
         "idempotency_key": e.idempotency_key, "at": e.at, "args_digest": e.args_digest}
        for e in audit_store.list_for_tenant(principal.tenant_id)
    ]


# ── Routes: insights (knowledge analytics + gap detection) ────────────────────
def insights_summary(tenant_id: str) -> dict:
    """The aggregate plus every document's usage, including ones never cited."""
    data = insights_store.summary(tenant_id)
    cited = {d["file_name"]: d["citations"] for d in data.get("documents", [])}
    docs = []
    for d in index_store.list_docs(tenant_id):
        docs.append({"file_name": d["file_name"], "title": d.get("title") or d["file_name"],
                     "uploaded_at": d.get("uploaded_at"), "citations": cited.get(d["file_name"], 0)})
    docs.sort(key=lambda d: d["citations"], reverse=True)
    data["documents"] = docs
    return data


@app.get("/api/insights")
def get_insights(principal: Annotated[Principal, Depends(principal_from_auth)]) -> dict:
    require_role(principal, "admin")
    return insights_summary(principal.tenant_id)


@app.get("/api/insights/digest")
def preview_digest(principal: Annotated[Principal, Depends(principal_from_auth)]) -> dict:
    require_role(principal, "admin")
    subject, text = build_digest(workspace_name(principal.tenant_id), insights_summary(principal.tenant_id),
                                 config.app_base_url)
    subscribed = bool(principal.email) and principal.email in digest_store.emails(principal.tenant_id)
    return {"subject": subject, "text": text, "subscribed": subscribed, "email": principal.email,
            "email_ready": smtp_configured()}


@app.post("/api/insights/digest/subscribe")
def subscribe_digest(body: DigestSubscribeRequest,
                     principal: Annotated[Principal, Depends(principal_from_auth)]) -> dict:
    require_role(principal, "admin")
    if not principal.email:
        raise HTTPException(status_code=400, detail="Your account has no email address.")
    digest_store.set(principal.tenant_id, principal.email, body.on)
    return {"ok": True, "subscribed": body.on}


@app.post("/api/insights/digest/send")
def send_digest_now(principal: Annotated[Principal, Depends(principal_from_auth)]) -> dict:
    """Email this week's summary to me now."""
    require_role(principal, "admin")
    if not principal.email:
        raise HTTPException(status_code=400, detail="Your account has no email address.")
    subject, text = build_digest(workspace_name(principal.tenant_id), insights_summary(principal.tenant_id),
                                 config.app_base_url)
    return {"sent": send_email(principal.email, subject, text)}


@app.post("/api/cron/digest")
def cron_digest(x_cron_token: Annotated[str | None, Header()] = None) -> dict:
    """Weekly send to every subscribed admin. Called by Cloud Scheduler with the
    shared CRON_TOKEN; refused when no token is configured."""
    expected = os.getenv("CRON_TOKEN", "").strip()
    if not expected or not x_cron_token or not hmac.compare_digest(x_cron_token, expected):
        raise HTTPException(status_code=403, detail="Forbidden")
    sent = 0
    for tenant_id, emails in digest_store.all().items():
        try:
            subject, text = build_digest(workspace_name(tenant_id), insights_summary(tenant_id), config.app_base_url)
            sent += sum(1 for e in emails if send_email(e, subject, text))
        except Exception as exc:
            log.warning("digest failed tenant=%s: %s", tenant_id, exc)
    log.info("cron_digest sent=%d", sent)
    return {"sent": sent}


# ── Routes: Slack query log (admin-only feed with user attribution) ───────────
@app.get("/api/slack/queries")
def get_slack_queries(principal: Annotated[Principal, Depends(principal_from_auth)]) -> list[dict]:
    require_role(principal, "admin")
    return insights_store.slack_queries(principal.tenant_id)


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
    plan = billing.current_plan(billing_store, tenant_id)
    if plan.seats is not None and len(existing) >= plan.seats:
        raise HTTPException(status_code=403, detail=(
            f"Your {plan.name} plan includes {plan.seats} people. Upgrade under Billing to invite more."))

    member = MemberRecord(uid=uid, email=body.email, role=body.role, invited_at=now, joined_at=None)
    member_store.add_member(tenant_id, member)

    invite_link = f"{config.app_base_url}/?invite={uid}&tenant={tenant_id}"
    tenant_name = tenant_profile_store.get_name(tenant_id) or prettify(tenant_id)
    inviter = principal.email or "A teammate"

    # Send a real email if SMTP is configured; otherwise return the link so
    # the admin can share it manually (dev / unconfigured prod).
    email_sent = send_invite_email(
        to_email=body.email, invite_link=invite_link,
        tenant_name=tenant_name, inviter=inviter, role=body.role,
    )
    log.info("invite tenant=%s email=%s role=%s emailed=%s", tenant_id, body.email, body.role, email_sent)
    return {"ok": True, "uid": uid, "invite_link": invite_link, "email_sent": email_sent}


@app.post("/api/tenant/accept-invite")
def accept_invite(
    body: AcceptInviteRequest,
    principal: Annotated[Principal, Depends(principal_from_auth)],
) -> dict:
    """Join a workspace the caller was invited to. Authorization is by the
    caller's *verified email* matching a pending invite in the target tenant —
    so a leaked link can't be claimed by someone else's account."""
    target = body.tenant_id
    email = (principal.email or "").strip().lower()
    if not email:
        raise HTTPException(status_code=403, detail="Your account has no email; cannot accept an invite")

    members = member_store.get_members(target)

    # Already a member (re-click / refresh) → idempotent success.
    already = next((m for m in members if m.uid == principal.uid), None)
    if already and already.joined_at:
        set_tenant_claim(principal.uid, target)  # ensure claim is present
        return {"ok": True, "tenant_id": target, "role": already.role, "already_member": True}

    pending = next(
        (m for m in members if (m.email or "").strip().lower() == email and not m.joined_at),
        None,
    )
    if pending is None:
        raise HTTPException(status_code=404, detail="No pending invite for your email in this workspace")

    now = datetime.now(timezone.utc).isoformat()
    role = pending.role
    # Swap the placeholder invite row for the caller's real uid.
    if pending.uid != principal.uid:
        member_store.remove_member(target, pending.uid)
    member_store.add_member(target, MemberRecord(
        uid=principal.uid, email=principal.email or email, role=role,
        invited_at=pending.invited_at, joined_at=now,
    ))

    # Persist the shared tenant on the user so future tokens resolve to it.
    claim_set = set_tenant_claim(principal.uid, target)
    log.info("accept-invite tenant=%s uid=%s role=%s claim=%s", target, principal.uid, role, claim_set)
    return {"ok": True, "tenant_id": target, "role": role, "claim_set": claim_set}


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


# ── Routes: share ─────────────────────────────────────────────────────────────
@app.post("/api/share", status_code=201)
def create_share(
    body: ShareCreateRequest,
    principal: Annotated[Principal, Depends(principal_from_auth)],
) -> dict:
    share_id = share_store.create({
        "question": body.question,
        "answer": body.answer,
        "citations": body.citations,
        "tenant_id": principal.tenant_id,
    })
    url = f"{config.app_base_url}/share/{share_id}"
    log.info("share_create tenant=%s share_id=%s", principal.tenant_id, share_id)
    return {"share_id": share_id, "url": url}


@app.get("/api/share/{share_id}")
def get_share(share_id: str) -> dict:
    data = share_store.get(share_id)
    if not data:
        raise HTTPException(status_code=404, detail="Share not found")
    return data


# ── Routes: widget keys ───────────────────────────────────────────────────────
@app.post("/api/tenant/widget-keys", status_code=201)
def create_widget_key(
    body: WidgetKeyCreateRequest,
    principal: Annotated[Principal, Depends(principal_from_auth)],
) -> dict:
    require_role(principal, "admin")
    result = widget_key_store.create_key(principal.tenant_id, body.label)
    log.info("widget_key_created tenant=%s key_id=%s label=%s", principal.tenant_id, result["key_id"], body.label)
    return result  # raw key returned ONCE — not stored in plaintext after this


@app.get("/api/tenant/widget-keys")
def list_widget_keys(principal: Annotated[Principal, Depends(principal_from_auth)]) -> list[dict]:
    require_role(principal, "admin")
    return widget_key_store.list_keys(principal.tenant_id)


@app.delete("/api/tenant/widget-keys/{key_id}")
def delete_widget_key(
    key_id: str,
    principal: Annotated[Principal, Depends(principal_from_auth)],
) -> dict:
    require_role(principal, "admin")
    deleted = widget_key_store.delete_key(principal.tenant_id, key_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Widget key not found")
    log.info("widget_key_deleted tenant=%s key_id=%s", principal.tenant_id, key_id)
    return {"ok": True, "key_id": key_id}


# ── Outside channels: shared helpers ──────────────────────────────────────────
def public_api_base(request: Request) -> str:
    """This API's public origin, for webhook URLs shown in setup steps. Cloud Run
    terminates TLS in front of us, so the request itself arrives as http."""
    base = str(request.base_url).rstrip("/")
    if base.startswith("http://") and not re.match(r"http://(localhost|127\.0\.0\.1)", base):
        base = "https://" + base.removeprefix("http://")
    return base


def workspace_name(tenant_id: str) -> str:
    return tenant_profile_store.get_name(tenant_id) or prettify(tenant_id)


def quota_or_message(tenant_id: str) -> str | None:
    """Count a channel question against the daily limit; a message if it's reached."""
    try:
        enforce_quota(tenant_id)
        return None
    except HTTPException as exc:
        if exc.status_code == 429:
            detail = str(exc.detail)
            return detail if detail.startswith("Your ") else "Your workspace has used today's question limit. It resets tomorrow."
        raise


# ── Routes: Slack integration ─────────────────────────────────────────────────
SLACK_FAST_PATH_S = 2.5          # Slack wants a reply within 3 s
_slack_pool = ThreadPoolExecutor(max_workers=4, thread_name_prefix="slack")


@app.post("/api/integrations/slack/connect")
def slack_connect(
    body: SlackConnectRequest,
    request: Request,
    principal: Annotated[Principal, Depends(principal_from_auth)],
) -> dict:
    require_role(principal, "admin")
    require_channels(principal.tenant_id, "Slack")
    slack_store.connect(body.team_id, body.team_name, principal.tenant_id)
    log.info("slack_connect tenant=%s team=%s", principal.tenant_id, body.team_id)
    return {
        "ok": True,
        "team_id": body.team_id,
        "signing_secret_set": bool(SLACK_SIGNING_SECRET),
        "instructions": (
            f"Add a Slack slash command:\n"
            f"  Command: /ask\n"
            f"  Request URL: {public_api_base(request)}/api/integrations/slack/command\n"
            f"  Short description: Ask your company knowledge base\n"
            f"Set SLACK_SIGNING_SECRET on Cloud Run to the signing secret from your Slack app."
        ),
    }


@app.get("/api/integrations/slack/connections")
def list_slack_connections(principal: Annotated[Principal, Depends(principal_from_auth)]) -> list[dict]:
    require_role(principal, "admin")
    return slack_store.list_connections(principal.tenant_id)


@app.delete("/api/integrations/slack/connections/{team_id}")
def slack_disconnect(
    team_id: str,
    principal: Annotated[Principal, Depends(principal_from_auth)],
) -> dict:
    require_role(principal, "admin")
    deleted = slack_store.disconnect(team_id, principal.tenant_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Slack connection not found")
    return {"ok": True, "team_id": team_id}


def _verify_slack_signature(body: bytes, timestamp: str, signature: str) -> bool:
    if not SLACK_SIGNING_SECRET:
        return False
    # Replay attack prevention: reject requests older than 5 minutes
    try:
        if abs(time.time() - float(timestamp)) > 300:
            return False
    except ValueError:
        return False
    base = f"v0:{timestamp}:{body.decode()}"
    expected = "v0=" + hmac.new(
        SLACK_SIGNING_SECRET.encode(), base.encode(), hashlib.sha256
    ).hexdigest()
    return hmac.compare_digest(expected, signature)


def _slack_answer(tenant_id: str, question: str, user_name: str) -> tuple[str, bool]:
    """(message, ok). Runs the shared pipeline; never raises."""
    try:
        res = answer_question(tenant_id, question)
        insights_store.record(tenant_id, question, res.max_score, answer=res.answer,
                              source="slack", slack_user=user_name, docs=res.cited_files)
        text = to_whatsapp(res.answer)          # Slack mrkdwn uses the same *bold* / _italic_
        refs = source_lines(tenant_id, res.top)
        if refs:
            text += "\n_Sources: " + " · ".join(refs) + "_"
        return f"*{user_name} asked:* {question}\n\n{text}", True
    except Exception as exc:
        log.warning("slack_answer failed tenant=%s err=%s", tenant_id, exc)
        return "⚠️ Something went wrong answering that. Try again.", False


def _post_to_slack(response_url: str, text: str, ok: bool) -> None:
    try:
        payload = json.dumps({"response_type": "in_channel" if ok else "ephemeral",
                              "replace_original": True, "text": text}).encode()
        req = urllib.request.Request(response_url, data=payload,
                                     headers={"Content-Type": "application/json"}, method="POST")
        urllib.request.urlopen(req, timeout=10)
    except Exception as exc:
        log.warning("slack response_url post failed: %s", exc)


@app.post("/api/integrations/slack/command")
async def slack_command(request: Request) -> dict:
    """Slack slash command handler — no Firebase auth, uses Slack signing secret."""
    body = await request.body()

    if SLACK_SIGNING_SECRET:
        ts = request.headers.get("X-Slack-Request-Timestamp", "")
        sig = request.headers.get("X-Slack-Signature", "")
        if not _verify_slack_signature(body, ts, sig):
            raise HTTPException(status_code=401, detail="Invalid Slack signature")
    elif config.env == "production":
        # Unsigned requests would let anyone who knows a team ID read that workspace.
        raise HTTPException(status_code=503, detail="Slack isn't set up: SLACK_SIGNING_SECRET is not configured")

    form = await request.form()
    team_id   = str(form.get("team_id", ""))
    text      = str(form.get("text", "")).strip()
    user_name = str(form.get("user_name", "someone"))
    response_url = str(form.get("response_url", ""))

    tenant_id = slack_store.get_tenant(team_id)
    if not tenant_id:
        return {
            "response_type": "ephemeral",
            "text": "❌ This Slack workspace isn't connected to RAGaaS. An admin must connect it first at your RAGaaS dashboard.",
        }
    if not text:
        return {"response_type": "ephemeral", "text": "Usage: `/ask [your question]`"}
    limit_msg = quota_or_message(tenant_id)
    if limit_msg:
        return {"response_type": "ephemeral", "text": limit_msg}

    log.info("slack_command tenant=%s team=%s user=%s question=%r", tenant_id, team_id, user_name, text)
    job = _slack_pool.submit(_slack_answer, tenant_id, text, user_name)
    try:
        # Most answers fit in Slack's 3 s window: reply directly, nothing left running
        # after the response (Cloud Run throttles CPU once a request has finished).
        reply, ok = await asyncio.wait_for(asyncio.shield(asyncio.wrap_future(job)), SLACK_FAST_PATH_S)
        return {"response_type": "in_channel" if ok else "ephemeral", "text": reply}
    except asyncio.TimeoutError:
        if response_url.startswith("https://hooks.slack.com/"):
            job.add_done_callback(lambda f: _post_to_slack(response_url, *f.result()))
        return {"response_type": "in_channel", "text": f"⏳ *{user_name}* asked: _{text}_\nSearching your knowledge base…"}


# ── Routes: WhatsApp integration (team members only) ──────────────────────────
WA_HELP = (
    "Ask me anything about your company's documents. I answer from them and say which page it came from.\n\n"
    "*docs*: list the documents\n*new*: start a fresh conversation\n*unlink*: disconnect this phone"
)


class WhatsAppConnectRequest(BaseModel):
    phone_number_id: str = Field(min_length=5, max_length=32, pattern=r"^\d+$")
    display_phone: str = Field(min_length=4, max_length=32)


class WhatsAppLinkRequest(BaseModel):
    phone: str = Field(min_length=6, max_length=32)


@app.post("/api/integrations/whatsapp/connect")
def whatsapp_connect(
    body: WhatsAppConnectRequest,
    request: Request,
    principal: Annotated[Principal, Depends(principal_from_auth)],
) -> dict:
    require_role(principal, "admin")
    require_channels(principal.tenant_id, "WhatsApp")
    existing = whatsapp_store.get_number(body.phone_number_id)
    if existing and existing["tenant_id"] != principal.tenant_id:
        raise HTTPException(status_code=409, detail="That WhatsApp number is connected to another workspace.")
    whatsapp_store.connect(body.phone_number_id, body.display_phone.strip(), principal.tenant_id)
    log.info("whatsapp_connect tenant=%s number=%s", principal.tenant_id, body.phone_number_id)
    return {
        "ok": True,
        "phone_number_id": body.phone_number_id,
        "webhook_url": f"{public_api_base(request)}/api/integrations/whatsapp/webhook",
        "configured": {
            "access_token": bool(wa.access_token()),
            "app_secret": bool(wa.app_secret()),
            "verify_token": bool(wa.verify_token()),
        },
    }


@app.get("/api/integrations/whatsapp/connections")
def list_whatsapp_numbers(request: Request, principal: Annotated[Principal, Depends(principal_from_auth)]) -> dict:
    require_role(principal, "admin")
    return {
        "numbers": whatsapp_store.list_numbers(principal.tenant_id),
        "webhook_url": f"{public_api_base(request)}/api/integrations/whatsapp/webhook",
        "configured": {
            "access_token": bool(wa.access_token()),
            "app_secret": bool(wa.app_secret()),
            "verify_token": bool(wa.verify_token()),
        },
    }


@app.delete("/api/integrations/whatsapp/connections/{phone_number_id}")
def whatsapp_disconnect(phone_number_id: str, principal: Annotated[Principal, Depends(principal_from_auth)]) -> dict:
    require_role(principal, "admin")
    if not whatsapp_store.disconnect(phone_number_id, principal.tenant_id):
        raise HTTPException(status_code=404, detail="WhatsApp number not found")
    return {"ok": True, "phone_number_id": phone_number_id}


@app.get("/api/integrations/whatsapp/queries")
def whatsapp_queries(principal: Annotated[Principal, Depends(principal_from_auth)]) -> list[dict]:
    require_role(principal, "admin")
    return insights_store.channel_queries(principal.tenant_id, "whatsapp")


@app.get("/api/integrations/whatsapp/link")
def whatsapp_my_link(principal: Annotated[Principal, Depends(principal_from_auth)]) -> dict:
    """Any member: is my phone linked, and which number do I message?"""
    link = whatsapp_store.link_for_member(principal.tenant_id, principal.uid)
    numbers = whatsapp_store.list_numbers(principal.tenant_id)
    return {
        "available": bool(numbers),
        "send_to": numbers[0]["display_phone"] if numbers else None,
        "linked": bool(link),
        "phone": wa.mask(link["wa_id"]) if link else None,
        "linked_at": link["linked_at"] if link else None,
    }


@app.post("/api/integrations/whatsapp/link")
def whatsapp_start_link(body: WhatsAppLinkRequest, principal: Annotated[Principal, Depends(principal_from_auth)]) -> dict:
    """Any member: get a one-time code to send from their phone. Sending it from the
    number they typed proves they hold it; seeing it proves they're signed in."""
    numbers = whatsapp_store.list_numbers(principal.tenant_id)
    if not numbers:
        raise HTTPException(status_code=409, detail="WhatsApp isn't connected for this workspace yet. Ask an admin.")
    phone = wa.digits(body.phone)
    if not 8 <= len(phone) <= 15:
        raise HTTPException(status_code=400, detail="Enter your full number with country code, e.g. +44 7700 900123.")
    code, expires = whatsapp_store.create_code(principal.tenant_id, principal.uid, principal.email or "", phone)
    return {"code": code, "message": f"link {code}", "send_to": numbers[0]["display_phone"],
            "expires_at": expires.isoformat()}


@app.delete("/api/integrations/whatsapp/link")
def whatsapp_unlink_mine(principal: Annotated[Principal, Depends(principal_from_auth)]) -> dict:
    link = whatsapp_store.link_for_member(principal.tenant_id, principal.uid)
    if link:
        whatsapp_store.unlink(link["wa_id"])
    return {"ok": True}


@app.get("/api/integrations/whatsapp/webhook")
def whatsapp_verify(request: Request) -> PlainTextResponse:
    """Meta's one-time subscription check: echo hub.challenge if the token matches."""
    q = request.query_params
    expected = wa.verify_token()
    given = q.get("hub.verify_token", "")
    if q.get("hub.mode") == "subscribe" and expected and hmac.compare_digest(given, expected):
        return PlainTextResponse(q.get("hub.challenge", ""))
    raise HTTPException(status_code=403, detail="Verification failed")


def _still_member(link: dict) -> bool:
    if config.env == "development" and str(link.get("uid", "")).startswith("dev-"):
        return True   # dev mock principals aren't stored as members
    return member_store.get_role(link["tenant_id"], link["uid"]) is not None


def _wa_send(m: wa.Incoming, text: str) -> None:
    try:
        wa.send_text(m.phone_number_id, m.wa_id, text)
    except Exception as exc:
        log.warning("whatsapp send failed number=%s err=%s", m.phone_number_id, exc)


def _whatsapp_handle(m: wa.Incoming) -> None:
    """One incoming message → one reply. Runs inside the webhook request so Cloud Run
    keeps CPU for it; Meta's retries are dropped by the message-ID claim."""
    if not m.message_id or not whatsapp_store.claim_message(m.message_id):
        return
    number = whatsapp_store.get_number(m.phone_number_id)
    if not number:
        log.warning("whatsapp message for unconnected number=%s", m.phone_number_id)
        return
    tenant_id = number["tenant_id"]
    name = workspace_name(tenant_id)
    wa.mark_read(m.phone_number_id, m.message_id)

    text = m.text
    if not text:
        _wa_send(m, "I can only read text messages for now. Type your question.")
        return
    low = text.lower().strip()

    code = re.fullmatch(r"link\s*(\d{6})", low)
    if code:
        link = whatsapp_store.redeem_code(code.group(1), m.wa_id)
        if not link or link["tenant_id"] != tenant_id:
            if link:
                whatsapp_store.unlink(m.wa_id)
            _wa_send(m, "That code didn't work. Codes last 15 minutes and must be sent from the number you "
                        "entered in RAGaaS. Get a new one under Integrations → WhatsApp.")
            return
        log.info("whatsapp_linked tenant=%s uid=%s", tenant_id, link["uid"])
        _wa_send(m, f"✅ Linked to *{name}*.\n\n{WA_HELP}")
        return

    link = whatsapp_store.get_link(m.wa_id)
    if not link or link["tenant_id"] != tenant_id or not _still_member(link):
        if link and link["tenant_id"] == tenant_id:
            whatsapp_store.unlink(m.wa_id)
        _wa_send(m, f"This phone isn't linked to *{name}* yet. In RAGaaS, open Integrations → WhatsApp, "
                    "choose *Link my phone* and send the code it shows you here.")
        return

    if low in {"help", "hi", "hello", "hey", "menu", "?"}:
        _wa_send(m, WA_HELP)
        return
    if low == "docs":
        titles = sorted(set(doc_titles(tenant_id).values()))
        _wa_send(m, "*Documents I can answer from:*\n" + "\n".join(f"• {t}" for t in titles[:40])
                 if titles else "No documents have been uploaded yet.")
        return
    if low in {"new", "reset"}:
        whatsapp_store.forget(m.wa_id)
        _wa_send(m, "Started a fresh conversation.")
        return
    if low == "unlink":
        whatsapp_store.unlink(m.wa_id)
        _wa_send(m, f"This phone is no longer linked to *{name}*.")
        return

    limit_msg = quota_or_message(tenant_id)
    if limit_msg:
        _wa_send(m, limit_msg)
        return
    try:
        res = answer_question(tenant_id, text, whatsapp_store.history(m.wa_id))
    except Exception as exc:
        log.warning("whatsapp answer failed tenant=%s err=%s", tenant_id, exc)
        _wa_send(m, "Sorry, something went wrong. Try again in a minute.")
        return
    reply = to_whatsapp(res.answer)
    refs = source_lines(tenant_id, res.top)
    if refs:
        reply += "\n\n_Sources_\n" + "\n".join(f"• {r}" for r in refs)
    _wa_send(m, reply)
    whatsapp_store.remember(m.wa_id, text, res.answer)
    insights_store.record(tenant_id, text, res.max_score, answer=res.answer, docs=res.cited_files,
                          source="whatsapp", slack_user=link.get("email") or wa.mask(m.wa_id), uid=link["uid"])
    log.info("whatsapp_answer tenant=%s matches=%d latency_ms=%d", tenant_id, len(res.top), res.latency_ms)


@app.post("/api/integrations/whatsapp/webhook")
async def whatsapp_webhook(request: Request) -> dict:
    body = await request.body()
    secret = wa.app_secret()
    if secret:
        if not wa.signature_ok(body, request.headers.get("X-Hub-Signature-256"), secret):
            raise HTTPException(status_code=401, detail="Invalid signature")
    elif config.env == "production":
        raise HTTPException(status_code=503, detail="WhatsApp isn't set up: WHATSAPP_APP_SECRET is not configured")
    try:
        payload = json.loads(body or b"{}")
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid JSON")
    for m in wa.parse(payload):
        try:
            await run_in_threadpool(_whatsapp_handle, m)
        except Exception as exc:   # always 200: an error retried by Meta would only repeat
            log.warning("whatsapp handle failed id=%s err=%s", m.message_id, exc)
    return {"ok": True}


# ── Routes: billing (plans + Razorpay subscriptions) ─────────────────────────
class CheckoutRequest(BaseModel):
    plan: Literal["starter", "team"]


class VerifyRequest(BaseModel):
    razorpay_payment_id: str = Field(min_length=1, max_length=64)
    razorpay_subscription_id: str = Field(min_length=1, max_length=64)
    razorpay_signature: str = Field(min_length=1, max_length=256)


@app.get("/api/billing")
def get_billing(principal: Annotated[Principal, Depends(principal_from_auth)]) -> dict:
    tenant_id = principal.tenant_id
    plan = billing.current_plan(billing_store, tenant_id)
    acct = billing_store.get(tenant_id)
    docs = {d["file_name"] for d in index_store.list_docs(tenant_id)} - {"team-answers.md"}
    return {
        "enforced": billing.enforced(),
        "plan": billing.plan_dict(plan),
        "status": acct.get("status", "none"),
        "renews_at": acct.get("current_end"),
        "cancel_at_period_end": bool(acct.get("cancel_at_period_end")),
        "usage": {
            "questions": billing_store.questions_this_month(tenant_id),
            "documents": len(docs),
            "seats": len(member_store.get_members(tenant_id)),
        },
        "plans": [billing.plan_dict(p) for p in billing.PLANS.values()],
        "checkout_ready": billing.razorpay_ready(),
        "can_manage": principal.role == "admin",
    }


@app.post("/api/billing/checkout")
def billing_checkout(body: CheckoutRequest, principal: Annotated[Principal, Depends(principal_from_auth)]) -> dict:
    require_role(principal, "admin")
    if not billing.razorpay_ready():
        raise HTTPException(status_code=503, detail="Online payment isn't set up yet. Email us and we'll upgrade you.")
    try:
        sub = billing.create_subscription(body.plan, principal.tenant_id, principal.email)
    except Exception as exc:
        log.warning("razorpay subscription failed tenant=%s: %s", principal.tenant_id, exc)
        raise HTTPException(status_code=502, detail="Couldn't start checkout. Try again in a minute.")
    acct = billing_store.get(principal.tenant_id)
    billing_store.set_plan(principal.tenant_id, acct.get("plan", "free"), status=acct.get("status", "none"),
                           pending_subscription_id=sub["id"], pending_plan=body.plan)
    return {"subscription_id": sub["id"], "key_id": os.getenv("RAZORPAY_KEY_ID", "").strip(), "plan": body.plan,
            "email": principal.email, "workspace": workspace_name(principal.tenant_id)}


@app.post("/api/billing/verify")
def billing_verify(body: VerifyRequest, principal: Annotated[Principal, Depends(principal_from_auth)]) -> dict:
    """Checkout's success handler: check Razorpay's signature, then switch plans."""
    require_role(principal, "admin")
    acct = billing_store.get(principal.tenant_id)
    if acct.get("pending_subscription_id") != body.razorpay_subscription_id:
        raise HTTPException(status_code=400, detail="That payment isn't for this workspace.")
    if not billing.checkout_signature_ok(body.razorpay_payment_id, body.razorpay_subscription_id,
                                         body.razorpay_signature):
        raise HTTPException(status_code=400, detail="Payment signature didn't match.")
    plan = acct.get("pending_plan", "starter")
    billing_store.set_plan(principal.tenant_id, plan, status="active",
                           subscription_id=body.razorpay_subscription_id, cancel_at_period_end=False,
                           pending_subscription_id=None, pending_plan=None)
    log.info("billing_upgraded tenant=%s plan=%s", principal.tenant_id, plan)
    return {"ok": True, "plan": plan}


@app.post("/api/billing/cancel")
def billing_cancel(principal: Annotated[Principal, Depends(principal_from_auth)]) -> dict:
    """Cancel at the end of the paid period; the plan stays until then."""
    require_role(principal, "admin")
    acct = billing_store.get(principal.tenant_id)
    sub_id = acct.get("subscription_id")
    if not sub_id:
        raise HTTPException(status_code=400, detail="No active subscription.")
    try:
        billing.cancel_subscription(sub_id)
    except Exception as exc:
        log.warning("razorpay cancel failed tenant=%s: %s", principal.tenant_id, exc)
        raise HTTPException(status_code=502, detail="Couldn't cancel right now. Try again in a minute.")
    billing_store.set_plan(principal.tenant_id, acct.get("plan", "free"), cancel_at_period_end=True)
    return {"ok": True}


@app.post("/api/billing/webhook")
async def billing_webhook(request: Request) -> dict:
    """Razorpay subscription events keep the plan in step with payments (renewals,
    failed charges, cancellations)."""
    body = await request.body()
    if not billing.webhook_signature_ok(body, request.headers.get("X-Razorpay-Signature")):
        raise HTTPException(status_code=401, detail="Invalid signature")
    event = json.loads(body or b"{}")
    status = billing.EVENT_STATUS.get(event.get("event", ""))
    sub = ((event.get("payload") or {}).get("subscription") or {}).get("entity") or {}
    if not status or not sub.get("id"):
        return {"ok": True}
    notes = sub.get("notes") or {}
    tenant_id = billing_store.find_by_subscription(sub["id"]) or notes.get("tenant_id")
    if not tenant_id:
        log.warning("billing webhook: unknown subscription %s", sub["id"])
        return {"ok": True}
    plan = notes.get("plan") if notes.get("plan") in billing.PAID_SELF_SERVE else billing_store.get(tenant_id).get("plan")
    ends = sub.get("current_end")
    fields = {"status": status, "subscription_id": sub["id"],
              "current_end": datetime.fromtimestamp(ends, timezone.utc).isoformat() if ends else None}
    if status in ("cancelled", "completed", "halted"):
        billing_store.set_plan(tenant_id, "free", **fields)
    else:
        billing_store.set_plan(tenant_id, plan or "starter", **fields)
    log.info("billing_webhook tenant=%s event=%s status=%s", tenant_id, event.get("event"), status)
    return {"ok": True}
