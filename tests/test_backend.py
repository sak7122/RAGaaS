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
