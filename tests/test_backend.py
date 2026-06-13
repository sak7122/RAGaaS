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
