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


class Planner(Protocol):
    def solve(
        self,
        tenant_id: str,
        req: SolveRequest,
        retrieve: RetrieveFn,
        registry: ToolRegistry,
    ) -> WorkflowSolution: ...


def _snippet(text: str, limit: int = 200) -> str:
    s = " ".join(text.split())
    return s if len(s) <= limit else s[:limit].rsplit(" ", 1)[0] + "…"


class MockPlanner:
    """Dev planner — deterministic, no LLM. Single-hop retrieve, then turns each
    top distinct chunk into a grounded step. Every step carries a SourceRef, so
    the no-hallucination invariant holds by construction (extractive). Replace
    with GeminiPlanner for real synthesis; keep the signature + invariant."""

    MAX_STEPS = 4

    def solve(self, tenant_id, req, retrieve, registry) -> WorkflowSolution:
        chunks = retrieve(tenant_id, req.problem, 6)
        if not chunks:
            return WorkflowSolution(
                problem=req.problem, steps=[],
                open_questions=["No uploaded documents matched this problem."],
                confidence=0.0, tenant_id=tenant_id,
            )

        steps: list[WorkflowStep] = []
        for i, c in enumerate(chunks[:self.MAX_STEPS], start=1):
            snip = _snippet(c["text"])
            steps.append(WorkflowStep(
                n=i,
                action=f"Apply guidance from {c['file_name']} (p.{c['page']}): {snip}",
                rationale="Extracted from the most relevant document excerpt.",
                sources=[SourceRef(
                    file_name=c["file_name"], page=c["page"],
                    chunk_index=c["chunk_index"], excerpt=snip[:280], score=c["score"],
                )],
            ))

        # Propose a tracking action on step 1 if the registry offers one.
        if req.propose_actions and registry.get("create_jira_ticket") and steps:
            steps[0].suggested_tool_call = ToolCall(
                tool="create_jira_ticket",
                args={"project": "OPS", "summary": _snippet(req.problem, 120)},
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
        "You are a workflow planner for an internal knowledge base. Given a problem "
        "and document excerpts, output a STRUCTURED workflow — ordered, actionable "
        "steps — as JSON only. Hard rules: (1) Ground EVERY step in the excerpts; "
        "cite the file_name/page/chunk_index it came from in that step's sources. "
        "(2) If a needed fact is NOT in the excerpts, do NOT invent it — add it to "
        "open_questions instead. (3) Only propose a tool in suggested_tool_call if "
        "its name appears in the provided tool list; fill args per its schema; leave "
        "requires_approval=true and status=\"proposed\". (4) Output JSON only."
    )

    def __init__(self, model: str, project: str, location: str) -> None:
        from google import genai
        from google.genai import types
        self._types = types
        self.model = model
        self.client = genai.Client(vertexai=True, project=project, location=location)

    def solve(self, tenant_id, req, retrieve, registry) -> WorkflowSolution:
        chunks = retrieve(tenant_id, req.problem, 8)
        if not chunks:
            return WorkflowSolution(
                problem=req.problem, steps=[],
                open_questions=["No uploaded documents matched this problem."],
                confidence=0.0, tenant_id=tenant_id,
            )

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
            f"{tools_block}"
            f"Document excerpts:\n{context}\n\n"
            f"Return JSON matching this shape:\n{schema_hint}"
        )

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
        try:
            solution = WorkflowSolution.model_validate_json(resp.text or "{}")
        except Exception as exc:
            log.warning("planner JSON parse failed (%s); returning open question", exc)
            return WorkflowSolution(
                problem=req.problem, steps=[],
                open_questions=["Planner could not produce a structured workflow; retry."],
                confidence=0.0, tenant_id=tenant_id,
            )
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
