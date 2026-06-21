import os

os.environ["RAGAAS_USE_MEMORY_STORE"] = "1"

from fastapi.testclient import TestClient

from backend.main import app, save_index, usage_store


client = TestClient(app)
HEADERS_A = {"Authorization": "Bearer tenant-a-token"}
HEADERS_B = {"Authorization": "Bearer tenant-b-token"}


TEST_DOCS = [
    {
        "tenant_id": "tenant-a",
        "file_name": "secret_a.pdf",
        "path": "local_data/uploads/tenant-a/secret_a.pdf",
        "chunks": [{"page": 1, "chunk_index": 0, "text": "Tenant A lease includes blue parking permits."}],
        "uploaded_at": "2026-05-31T00:00:00Z",
    },
    {
        "tenant_id": "tenant-b",
        "file_name": "secret_b.pdf",
        "path": "local_data/uploads/tenant-b/secret_b.pdf",
        "chunks": [{"page": 1, "chunk_index": 0, "text": "Tenant B contract mentions red elevator access."}],
        "uploaded_at": "2026-05-31T00:00:00Z",
    },
]


def setup_function() -> None:
    usage_store.reset()
    # Load existing index and replace only the two test tenant docs
    from backend.main import load_index
    idx = load_index()
    test_tenants = {"tenant-a", "tenant-b"}
    idx["documents"] = [d for d in idx["documents"] if d["tenant_id"] not in test_tenants]
    idx["documents"].extend(TEST_DOCS)
    save_index(idx)


def test_chat_is_tenant_scoped() -> None:
    response = client.post("/api/chat", json={"message": "red elevator"}, headers=HEADERS_A)
    body = response.json()
    assert response.status_code == 200
    assert body["citations"] == []
    assert "cannot find" in body["answer"]

    response = client.post("/api/chat", json={"message": "red elevator"}, headers=HEADERS_B)
    body = response.json()
    assert response.status_code == 200
    assert body["citations"][0]["file_name"] == "secret_b.pdf"


def test_quota_breaker_blocks_after_limit() -> None:
    for _ in range(1000):
        usage_store.increment_or_reject("tenant-a")
    response = client.post("/api/chat", json={"message": "blue parking"}, headers=HEADERS_A)
    assert response.status_code == 429


def test_missing_auth_is_rejected() -> None:
    response = client.post("/api/chat", json={"message": "blue parking"})
    assert response.status_code == 401


def test_response_includes_retrieval_trace_and_scores() -> None:
    response = client.post("/api/chat", json={"message": "red elevator"}, headers=HEADERS_B)
    body = response.json()
    assert response.status_code == 200

    r = body["retrieval"]
    assert r["engine"]                       # engine label present
    assert r["chunks_searched"] >= 1
    assert r["top_k"] == len(body["citations"])
    assert sorted(r["query_terms"]) == ["elevator", "red"]
    assert r["latency_ms"] >= 1

    # Citation carries a normalized relevance score
    assert body["citations"][0]["score"] > 0


def test_insights_detect_knowledge_gaps() -> None:
    # tenant B has a doc about "red elevator access" only.
    # Ask an unanswerable question repeatedly → should surface as a gap.
    for _ in range(3):
        client.post("/api/chat", json={"message": "what is the refund policy"}, headers=HEADERS_B)
    # Ask an answerable one
    client.post("/api/chat", json={"message": "red elevator"}, headers=HEADERS_B)

    res = client.get("/api/insights", headers=HEADERS_B)
    assert res.status_code == 200
    body = res.json()
    assert body["total_queries"] >= 4
    gap_questions = [g["question"].lower() for g in body["gaps"]]
    assert any("refund" in q for q in gap_questions)
    assert body["gaps"][0]["count"] >= 3  # asked 3x, unanswered → top gap


def test_insights_requires_admin() -> None:
    # viewer-less path: missing auth is rejected
    assert client.get("/api/insights").status_code == 401


HEADERS_DEMO = {"Authorization": "Bearer mock-tenant-token-abc"}  # email tenant-demo@ragaas.local


def test_invite_then_accept_joins_shared_tenant() -> None:
    # tenant-a admin invites tenant-b's email as an uploader.
    inv = client.post(
        "/api/tenant/invite",
        json={"email": "tenant-b@ragaas.local", "role": "uploader"},
        headers=HEADERS_A,
    )
    assert inv.status_code == 201

    # The invited user (token resolves to email tenant-b@ragaas.local) accepts.
    acc = client.post(
        "/api/tenant/accept-invite",
        json={"tenant_id": "tenant-a"},
        headers=HEADERS_B,
    )
    assert acc.status_code == 200
    assert acc.json()["role"] == "uploader"

    # They now appear as a joined member of tenant-a under their real uid.
    members = client.get("/api/tenant/members", headers=HEADERS_A).json()
    joined = [m for m in members if m["uid"] == "dev-tenant-b"]
    assert joined and joined[0]["joined_at"] and joined[0]["role"] == "uploader"
    # The placeholder invite row is gone.
    assert not any(m["uid"].startswith("invited-") for m in members)

    # Idempotent: accepting again is a no-op success.
    again = client.post("/api/tenant/accept-invite", json={"tenant_id": "tenant-a"}, headers=HEADERS_B)
    assert again.status_code == 200
    assert again.json().get("already_member") is True


def test_accept_invite_rejects_uninvited_email() -> None:
    # tenant-demo's email was never invited to tenant-a → cannot join.
    res = client.post("/api/tenant/accept-invite", json={"tenant_id": "tenant-a"}, headers=HEADERS_DEMO)
    assert res.status_code == 404


def test_vector_search_ranks_embedded_chunks() -> None:
    # Insert an embedded doc and confirm it is retrieved via the vector path
    from backend.main import load_index, save_index as _save
    from backend.rag import LocalEmbedder

    emb = LocalEmbedder()
    text = "The annual security audit covers firewall and access logs."
    idx = load_index()
    idx["documents"] = [d for d in idx["documents"] if d["tenant_id"] != "tenant-a"]
    idx["documents"].append({
        "tenant_id": "tenant-a",
        "file_name": "audit.pdf",
        "path": "local_data/uploads/tenant-a/audit.pdf",
        "chunks": [{"page": 1, "chunk_index": 0, "text": text, "embedding": emb.embed_query(text)}],
        "uploaded_at": "2026-05-31T00:00:00Z",
    })
    _save(idx)

    response = client.post("/api/chat", json={"message": "security audit firewall"}, headers=HEADERS_A)
    body = response.json()
    assert response.status_code == 200
    assert body["citations"][0]["file_name"] == "audit.pdf"
    assert body["retrieval"]["candidates_ranked"] >= 1


# ── /api/solve (agentic workflow) ─────────────────────────────────────────────
def test_solve_requires_auth() -> None:
    assert client.post("/api/solve", json={"problem": "anything"}).status_code == 401


def test_solve_is_tenant_scoped() -> None:
    # tenant-a asks about tenant-b's only topic → must not leak tenant-b sources.
    res = client.post("/api/solve", json={"problem": "red elevator access"}, headers=HEADERS_A)
    assert res.status_code == 200
    body = res.json()
    assert body["tenant_id"] == "tenant-a"
    files = [s["file_name"] for step in body["steps"] for s in step["sources"]]
    assert "secret_b.pdf" not in files


def test_solve_steps_are_grounded_or_open_questions() -> None:
    # Every step must cite at least one source (no ungrounded/hallucinated steps).
    res = client.post("/api/solve", json={"problem": "blue parking permits"}, headers=HEADERS_A)
    assert res.status_code == 200
    body = res.json()
    assert body["steps"], "expected a grounded workflow for an answerable problem"
    for step in body["steps"]:
        assert step["sources"], f"step {step['n']} has no sources (ungrounded)"
        assert step["sources"][0]["file_name"] == "secret_a.pdf"
    # Proposed actions stay human-gated.
    tcs = [s["suggested_tool_call"] for s in body["steps"] if s["suggested_tool_call"]]
    for tc in tcs:
        assert tc["requires_approval"] is True
        assert tc["status"] == "proposed"


def test_solve_no_match_yields_open_questions() -> None:
    res = client.post("/api/solve", json={"problem": "quarterly revenue in mongolia"}, headers=HEADERS_A)
    body = res.json()
    assert res.status_code == 200
    assert body["steps"] == []
    assert body["open_questions"]
    assert body["confidence"] == 0.0


def test_solve_shares_quota_breaker() -> None:
    for _ in range(1000):
        usage_store.increment_or_reject("tenant-a")
    res = client.post("/api/solve", json={"problem": "blue parking"}, headers=HEADERS_A)
    assert res.status_code == 429


# ── /api/actions/execute (human-gated tool layer) ─────────────────────────────
def test_execute_rejects_unknown_tool() -> None:
    res = client.post("/api/actions/execute",
                      json={"tool": "rm_rf_prod", "args": {}, "approved": True},
                      headers=HEADERS_A)
    assert res.status_code == 403
    assert res.json()["status"] == "rejected"


def test_execute_outward_requires_approval() -> None:
    # Outward tool proposed (not approved) → rejected, no side effect.
    res = client.post("/api/actions/execute",
                      json={"tool": "create_jira_ticket",
                            "args": {"project": "OPS", "summary": "x"}, "approved": False},
                      headers=HEADERS_A)
    assert res.status_code == 403
    assert "approval" in res.json()["detail"]["reason"]


def test_execute_approved_runs_dry_run() -> None:
    # Mock token → admin (an approver). Dev → dry-run, no external call.
    res = client.post("/api/actions/execute",
                      json={"tool": "create_jira_ticket",
                            "args": {"project": "OPS", "summary": "ship it"}, "approved": True},
                      headers=HEADERS_A)
    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "executed"
    assert body["detail"]["dry_run"] is True


def test_execute_is_idempotent() -> None:
    payload = {"tool": "create_jira_ticket",
               "args": {"project": "OPS", "summary": "once"},
               "approved": True, "idempotency_key": "dup-key-1"}
    first = client.post("/api/actions/execute", json=payload, headers=HEADERS_A)
    second = client.post("/api/actions/execute", json=payload, headers=HEADERS_A)
    assert first.status_code == 200 and second.status_code == 200
    assert "idempotent" in second.json()["detail"]["reason"]


def test_send_email_tool_registered_and_outward() -> None:
    from backend.tools import create_tool_registry
    spec = {s.name: s for s in create_tool_registry().specs()}
    assert "send_email" in spec
    assert spec["send_email"].outward is True
    assert "admin" in spec["send_email"].approver_roles


def test_send_email_dry_run_does_not_send() -> None:
    # Approved admin in dev → executes in dry-run, no SMTP touched.
    res = client.post("/api/actions/execute",
                      json={"tool": "send_email",
                            "args": {"to": "x@acme.com", "subject": "hi", "body": "yo"},
                            "approved": True},
                      headers=HEADERS_A)
    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "executed"
    assert body["detail"]["dry_run"] is True
    assert body["detail"]["would_send"]["to"] == "x@acme.com"


def test_send_email_requires_approval() -> None:
    res = client.post("/api/actions/execute",
                      json={"tool": "send_email",
                            "args": {"to": "x@acme.com", "subject": "hi", "body": "yo"},
                            "approved": False},
                      headers=HEADERS_A)
    assert res.status_code == 403
    assert "approval" in res.json()["detail"]["reason"]


def test_generate_document_is_not_outward() -> None:
    from backend.tools import create_tool_registry
    spec = {s.name: s for s in create_tool_registry().specs()}
    assert "generate_document" in spec
    assert spec["generate_document"].outward is False  # produces text, no external effect


def test_generate_document_produces_grounded_doc() -> None:
    # tenant-a has secret_a.pdf ("blue parking permits"). The app registry is wired
    # with ToolServices (generator + retrieval), so this returns real document text.
    res = client.post("/api/actions/execute",
                      json={"tool": "generate_document",
                            "args": {"doc_type": "summary", "title": "Parking policy",
                                     "instructions": "Summarize parking rules."},
                            "approved": True},
                      headers=HEADERS_A)
    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "executed"
    assert body["detail"]["document"]                      # non-empty draft
    assert "secret_a.pdf" in body["detail"]["sources"]     # grounded in tenant-a's doc


def test_generate_document_no_source_fails() -> None:
    # A topic no tenant-a doc covers → no grounding → failed (never fabricates).
    res = client.post("/api/actions/execute",
                      json={"tool": "generate_document",
                            "args": {"title": "Quarterly revenue in Mongolia"},
                            "approved": True},
                      headers=HEADERS_A)
    assert res.status_code == 502
    assert res.json()["status"] == "failed"


def test_publish_workflow_returns_share_url() -> None:
    res = client.post("/api/actions/execute",
                      json={"tool": "publish_workflow",
                            "args": {"title": "Onboarding plan",
                                     "markdown": "# Onboarding plan\n\n1. Provision access."},
                            "approved": True},
                      headers=HEADERS_A)
    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "executed"
    assert "/share/" in body["detail"]["url"]


def test_publish_workflow_link_is_fetchable() -> None:
    # The published link resolves via the existing share endpoint.
    pub = client.post("/api/actions/execute",
                      json={"tool": "publish_workflow",
                            "args": {"title": "Audit plan", "markdown": "# Audit plan\n\nstep 1"},
                            "approved": True},
                      headers=HEADERS_A).json()
    share_id = pub["detail"]["url"].rsplit("/share/", 1)[1]
    got = client.get(f"/api/share/{share_id}")
    assert got.status_code == 200
    assert "Audit plan" in got.json()["answer"]


def test_action_audit_records_attempts() -> None:
    client.post("/api/actions/execute",
                json={"tool": "create_jira_ticket",
                      "args": {"project": "OPS", "summary": "audit me"}, "approved": True},
                headers=HEADERS_A)
    res = client.get("/api/actions/audit", headers=HEADERS_A)
    assert res.status_code == 200
    entries = res.json()
    assert any(e["tool"] == "create_jira_ticket" and e["status"] == "executed" for e in entries)
    # Raw args never stored — only a digest.
    assert all("args" not in e and e["args_digest"] for e in entries)


# ── GeminiPlanner two-stage fallback (regression: solver lost the answer) ──────
# These drive solve() with a stubbed client — no Gemini creds, no network. The
# bug fixed here: structuring failure used to discard the grounded answer and
# emit "could not produce a workflow" even though chat answered fine.
from types import SimpleNamespace

from backend.planner import GeminiPlanner
from backend.workflow import SolveRequest
from backend.tools import create_tool_registry

SEC_CHUNKS = [{
    "file_name": "form10k_instructions.pdf", "page": 3, "chunk_index": 0,
    "text": "A large accelerated filer must file its Form 10-K within 60 days "
            "after the end of the fiscal year covered by the report.",
    "score": 0.82,
}]
SEC_ANSWER = ("A large accelerated filer has 60 days after fiscal year end to "
              "file Form 10-K (General Instruction A).")


def _planner_with_response(text: str) -> GeminiPlanner:
    """GeminiPlanner whose LLM call returns `text` — bypasses __init__/google SDK."""
    p = object.__new__(GeminiPlanner)
    p.model = "stub"
    p._types = SimpleNamespace(GenerateContentConfig=lambda **kw: None)
    p.client = SimpleNamespace(models=SimpleNamespace(
        generate_content=lambda **kw: SimpleNamespace(text=text)
    ))
    return p


def _solve(planner: GeminiPlanner, answer: str):
    return planner.solve(
        "tenant-a",
        SolveRequest(problem="How many days do we have to file our Form 10-K?"),
        retrieve=lambda tid, q, k: SEC_CHUNKS,
        registry=create_tool_registry(),
        answer=lambda q, chunks: answer,
    )


def test_planner_falls_back_to_answer_step_on_prose_response() -> None:
    # Model replies in prose (not JSON) — the exact prod failure mode.
    sol = _solve(_planner_with_response("Sure! Here is some prose, not JSON."), SEC_ANSWER)
    assert sol.open_questions == []
    assert len(sol.steps) == 1, "fallback must keep the answer as a step"
    assert "60 days" in sol.steps[0].action
    assert sol.steps[0].sources[0].file_name == "form10k_instructions.pdf"


def test_planner_falls_back_when_structuring_returns_zero_steps() -> None:
    empty = '{"problem":"x","steps":[],"open_questions":[],"confidence":0.5}'
    sol = _solve(_planner_with_response(empty), SEC_ANSWER)
    assert len(sol.steps) == 1
    assert "60 days" in sol.steps[0].action


def test_planner_uses_valid_structured_json_when_returned() -> None:
    good = (
        '{"problem":"file 10-K","steps":[{"n":1,"action":"File within 60 days of '
        'fiscal year end","rationale":"large accelerated filer deadline","sources":'
        '[{"file_name":"form10k_instructions.pdf","page":3,"chunk_index":0,'
        '"excerpt":"60 days","score":0.82}]}],"open_questions":[],"confidence":0.8}'
    )
    sol = _solve(_planner_with_response(good), SEC_ANSWER)
    assert len(sol.steps) == 1
    assert sol.confidence == 0.8
    assert sol.tenant_id == "tenant-a"  # server identity, overwritten by planner


def test_planner_no_answer_yields_open_questions_not_step() -> None:
    # Stage 1 says docs don't cover it → no fabricated workflow.
    sol = _solve(_planner_with_response("ignored"),
                 "I cannot find that answer in your uploaded documents.")
    assert sol.steps == []
    assert sol.open_questions
