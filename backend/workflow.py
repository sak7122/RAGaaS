"""
Workflow contracts — the output shape of /api/solve.

A "solve" turns a problem statement into a grounded, structured workflow:
ordered steps, each citing source chunks, each optionally proposing a tool call.
This is the product's differentiator vs plain /api/chat (prose answer).

DESIGN ONLY — these are the schemas. The planner that fills them lives in
backend/planner.py; the tools a step may propose live in backend/tools.py.

Hard rule encoded here: every proposed tool call defaults to requires_approval=
True and status="proposed". The planner NEVER executes — it proposes. Execution
is a separate, human-gated step (see backend/tools.py ToolExecutor).
"""
from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, Field


# ── Request ───────────────────────────────────────────────────────────────────
class SolveRequest(BaseModel):
    problem: str = Field(min_length=1, max_length=4000)
    # Optional prior turns, same shape as ChatRequest.history in main.py
    history: list[dict] = Field(default_factory=list, max_length=4)
    # Cap planner cost/latency: max retrieve→reason hops the agent may take.
    max_hops: int = Field(default=3, ge=1, le=6)
    # If False, planner omits suggested_tool_call entirely (pure plan, no actions).
    propose_actions: bool = True


# ── Grounding ─────────────────────────────────────────────────────────────────
class SourceRef(BaseModel):
    """Points a step at the evidence that justifies it — same identity as
    main.py Citation so the frontend can reuse its citation renderer."""
    file_name: str
    page: int = 1
    chunk_index: int = 0
    excerpt: str = Field(max_length=280)
    score: float = 0.0  # normalized relevance 0..1


# ── Proposed action ───────────────────────────────────────────────────────────
ToolCallStatus = Literal["proposed", "approved", "rejected", "executed", "failed"]


class ToolCall(BaseModel):
    """A step's optional bid to *do* something via the tool registry. Born as
    "proposed"; only the human-gated executor advances it to "executed"."""
    tool: str = Field(min_length=1, max_length=64)  # must exist in ToolRegistry
    args: dict = Field(default_factory=dict)
    # Outward/irreversible tools (ticket, email) must keep this True. The
    # executor refuses to run a call whose tool is outward-facing unless an
    # explicit human approval token accompanies it.
    requires_approval: bool = True
    status: ToolCallStatus = "proposed"
    # Set by the executor: idempotency key so re-running a workflow can't create
    # duplicate tickets/emails. None until the executor assigns one.
    idempotency_key: str | None = None
    # Populated after execution (provider id, url) or on failure (error string).
    result: dict | None = None


# ── Step ──────────────────────────────────────────────────────────────────────
class WorkflowStep(BaseModel):
    n: int = Field(ge=1)
    action: str = Field(min_length=1, max_length=600)
    rationale: str = Field(default="", max_length=800)
    owner_hint: str | None = Field(default=None, max_length=120)  # team/role from docs
    blocking: bool = False  # must complete before later steps can start
    sources: list[SourceRef] = Field(default_factory=list)
    suggested_tool_call: ToolCall | None = None


# ── Solution (the /api/solve response) ────────────────────────────────────────
class WorkflowSolution(BaseModel):
    problem: str  # restated + scoped by the planner
    steps: list[WorkflowStep] = Field(default_factory=list)
    # Where the docs are silent — surfaced, NOT hallucinated into a step.
    open_questions: list[str] = Field(default_factory=list)
    confidence: Annotated[float, Field(ge=0.0, le=1.0)] = 0.0
    tenant_id: str = ""
    queries_used: int = 0
    query_limit: int = 0
    # Reuse RetrievalTrace from main.py if you want retrieval observability here.
