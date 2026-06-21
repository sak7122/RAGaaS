"""
Planner — turns a problem into a WorkflowSolution.

Sits above retrieval (it CALLS retrieval, possibly multiple hops) and above the
tool registry (it READS specs to propose tool calls; it never executes).

Mirrors backend/rag.py: a Protocol + a deterministic dev impl (MockPlanner, no
network, good for pytest) + a prod impl (GeminiPlanner) + a create_* factory.

DESIGN ONLY — both impls are stubs. Fill in Phase 2.
"""
from __future__ import annotations

import json
import logging
import os
from typing import Callable, Protocol

from backend.tools import ToolRegistry
from backend.workflow import (
    SolveRequest,
    SourceRef,
    ToolCall,
    WorkflowSolution,
    WorkflowStep,
)

log = logging.getLogger("ragaas")

# A retrieval callable injected by main.py so the planner stays storage-agnostic:
#   retrieve(tenant_id, query, k) -> ranked chunks [{file_name, page, text, score}]
RetrieveFn = Callable[[str, str, int], list[dict]]

# A grounded-answer callable — the SAME path /api/chat uses (generator.generate).
# Stage 1 of solve relies on this proven RAG answer; the workflow is built FROM it.
#   answer(question, chunks) -> grounded prose answer
AnswerFn = Callable[[str, list[dict]], str]

_NO_ANSWER = "cannot find"  # substring the generators use when docs don't cover it


def _is_no_answer(text: str) -> bool:
    return not text or _NO_ANSWER in text.lower()[:80]


def _extract_json(text: str) -> str:
    """Best-effort: strip markdown fences, isolate the outermost JSON object."""
    t = (text or "").strip()
    if t.startswith("```"):
        t = t.strip("`")
        if t[:4].lower() == "json":
            t = t[4:]
    i, j = t.find("{"), t.rfind("}")
    return t[i:j + 1] if i != -1 and j != -1 and j > i else t


class Planner(Protocol):
    def solve(
        self,
        tenant_id: str,
        req: SolveRequest,
        retrieve: RetrieveFn,
        registry: ToolRegistry,
        answer: AnswerFn,
    ) -> WorkflowSolution: ...


def _snippet(text: str, limit: int = 200) -> str:
    s = " ".join((text or "").split())
    return s if len(s) <= limit else s[:limit].rsplit(" ", 1)[0] + "…"


def _src(c: dict) -> SourceRef:
    return SourceRef(
        file_name=c["file_name"], page=c["page"],
        chunk_index=c["chunk_index"], excerpt=_snippet(c["text"], 280), score=c["score"],
    )


def _answer_fallback(problem: str, grounded: str, chunks: list[dict],
                     tenant_id: str, registry: ToolRegistry,
                     propose_actions: bool) -> WorkflowSolution:
    """When structured synthesis fails, never drop the answer: wrap the grounded
    chat-grade answer as a single sourced step. This is the safety net that
    fixed the 'solver failed but chat worked' case."""
    step = WorkflowStep(
        n=1,
        action=_snippet(grounded, 600),
        rationale="Grounded answer synthesized from your documents.",
        sources=[_src(c) for c in chunks[:3]],
    )
    if propose_actions and registry.get("generate_document"):
        step.suggested_tool_call = ToolCall(
            tool="generate_document",
            args={"doc_type": "summary", "title": _snippet(problem, 120),
                  "instructions": "Summarize the grounded answer into an actionable document."},
        )
    confidence = round(min(0.9, (chunks[0]["score"] if chunks else 0.0) + 0.25), 2)
    return WorkflowSolution(problem=problem, steps=[step], open_questions=[],
                            confidence=confidence, tenant_id=tenant_id)


class MockPlanner:
    """Dev planner — deterministic, no LLM. Two-stage like prod: stage 1 gets the
    grounded answer (MockGenerator), stage 2 lays it out as step 1 followed by
    supporting excerpts. Every step carries a SourceRef (no-hallucination by
    construction). Replace with GeminiPlanner for real synthesis."""

    MAX_STEPS = 4

    def solve(self, tenant_id, req, retrieve, registry, answer) -> WorkflowSolution:
        chunks = retrieve(tenant_id, req.problem, 6)
        if not chunks:
            return WorkflowSolution(
                problem=req.problem, steps=[],
                open_questions=["No uploaded documents matched this problem."],
                confidence=0.0, tenant_id=tenant_id,
            )

        grounded = answer(req.problem, chunks)
        if _is_no_answer(grounded):
            return WorkflowSolution(
                problem=req.problem, steps=[],
                open_questions=["The documents don't appear to cover this problem."],
                confidence=0.1, tenant_id=tenant_id,
            )

        steps: list[WorkflowStep] = [WorkflowStep(
            n=1, action=_snippet(grounded, 600),
            rationale="Direct answer grounded in your documents.",
            sources=[_src(chunks[0])],
        )]
        for i, c in enumerate(chunks[1:self.MAX_STEPS], start=2):
            steps.append(WorkflowStep(
                n=i,
                action=f"Supporting detail from {c['file_name']} (p.{c['page']}): {_snippet(c['text'])}",
                rationale="Related excerpt that backs the answer.",
                sources=[_src(c)],
            ))

        if req.propose_actions and registry.get("generate_document"):
            steps[0].suggested_tool_call = ToolCall(
                tool="generate_document",
                args={"doc_type": "summary", "title": _snippet(req.problem, 120),
                      "instructions": "Summarize the grounded answer into an actionable document."},
            )

        confidence = round(min(0.95, chunks[0]["score"] + 0.2), 2)
        return WorkflowSolution(
            problem=req.problem, steps=steps, open_questions=[],
            confidence=confidence, tenant_id=tenant_id,
        )


class GeminiPlanner:
    """Prod planner — Gemini structured synthesis. Single-hop retrieve + one
    constrained JSON generation into the WorkflowSolution shape. Grounds every
    step in the supplied excerpts or moves the gap to open_questions; proposes
    tool calls only from registry.specs().

    NOTE: single-hop for now. Multi-hop (retrieve→reason×max_hops) is a later
    upgrade — swap the body for an agent loop, keep the signature + invariant."""

    SYSTEM = (
        "You are a workflow planner for an internal knowledge base. You are given a "
        "problem, document excerpts, AND a verified grounded answer already derived "
        "from those excerpts. STRUCTURE that answer into an ordered, actionable "
        "workflow, output as JSON only. Hard rules: (1) Stay faithful to the verified "
        "answer and excerpts — do NOT add facts beyond them. (2) Ground every step; "
        "cite file_name/page/chunk_index in that step's sources. (3) If part of the "
        "problem isn't covered, add it to open_questions instead of inventing it. "
        "(4) Only propose a tool in suggested_tool_call if its name is in the tool "
        "list; fill args per schema; leave requires_approval=true, status=\"proposed\". "
        "(5) Always produce at least one step when a verified answer exists. "
        "(6) Output JSON only, no prose, no markdown fences."
    )

    def __init__(self, model: str, project: str, location: str) -> None:
        from google import genai
        from google.genai import types
        self._types = types
        self.model = model
        self.client = genai.Client(vertexai=True, project=project, location=location)

    def solve(self, tenant_id, req, retrieve, registry, answer) -> WorkflowSolution:
        chunks = retrieve(tenant_id, req.problem, 8)
        if not chunks:
            return WorkflowSolution(
                problem=req.problem, steps=[],
                open_questions=["No uploaded documents matched this problem."],
                confidence=0.0, tenant_id=tenant_id,
            )

        # ── Stage 1: proven RAG answer (same path /api/chat uses) ──────────────
        grounded = answer(req.problem, chunks)
        if _is_no_answer(grounded):
            return WorkflowSolution(
                problem=req.problem, steps=[],
                open_questions=["The documents don't appear to cover this problem."],
                confidence=0.1, tenant_id=tenant_id,
            )

        # ── Stage 2: structure that answer into a workflow ─────────────────────
        context = "\n\n".join(
            f"[{c['file_name']} p.{c['page']} #{c['chunk_index']}]\n{c['text']}"
            for c in chunks
        )
        tools_block = ""
        if req.propose_actions:
            specs = registry.specs()
            if specs:
                tools_block = "Tools you MAY propose:\n" + "\n".join(
                    f"- {s.name}: {s.description} args_schema={json.dumps(s.args_schema)}"
                    for s in specs
                ) + "\n\n"

        schema_hint = (
            '{"problem": str, "steps": [{"n": int, "action": str, "rationale": str, '
            '"owner_hint": str|null, "blocking": bool, "sources": [{"file_name": str, '
            '"page": int, "chunk_index": int, "excerpt": str, "score": float}], '
            '"suggested_tool_call": {"tool": str, "args": object}|null}], '
            '"open_questions": [str], "confidence": float}'
        )
        prompt = (
            f"Problem: {req.problem}\n\n"
            f"Verified grounded answer (structure THIS):\n{grounded}\n\n"
            f"{tools_block}"
            f"Document excerpts:\n{context}\n\n"
            f"Return JSON matching this shape:\n{schema_hint}"
        )

        try:
            resp = self.client.models.generate_content(
                model=self.model,
                contents=prompt,
                config=self._types.GenerateContentConfig(
                    system_instruction=self.SYSTEM,
                    temperature=0.2,
                    max_output_tokens=2048,
                    response_mime_type="application/json",
                ),
            )
            solution = WorkflowSolution.model_validate_json(_extract_json(resp.text or "{}"))
            if not solution.steps:
                raise ValueError("planner returned zero steps")
        except Exception as exc:
            # Never lose the answer — wrap it as a one-step workflow.
            log.warning("structuring failed (%s); falling back to answer step", exc)
            return _answer_fallback(req.problem, grounded, chunks, tenant_id,
                                    registry, req.propose_actions)

        solution.problem = req.problem
        solution.tenant_id = tenant_id
        return solution


def create_planner() -> Planner:
    if os.getenv("RAGAAS_ENV", "development") == "production":
        try:
            import google.genai  # noqa: F401
            return GeminiPlanner(
                model=os.getenv("PLANNER_MODEL", "gemini-2.5-flash"),
                project=os.getenv("GCP_PROJECT_ID", ""),
                location=os.getenv("VERTEX_LOCATION", "us-central1"),
            )
        except Exception as exc:
            log.warning("GeminiPlanner init failed (%s); using MockPlanner", exc)
    return MockPlanner()
