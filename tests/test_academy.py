import os

os.environ["RAGAAS_USE_MEMORY_STORE"] = "1"

import pytest
from fastapi.testclient import TestClient

from backend.academy.search import parse_engines, vertex_filter, VertexKnowledgeSearch
from backend.academy.store import Entitlement
from backend.firebase_services import Principal
from backend.main import academy_search, academy_store, app, principal_from_auth, usage_store

client = TestClient(app)
ADMIN_A = {"Authorization": "Bearer tenant-a-token"}
ADMIN_B = {"Authorization": "Bearer tenant-b-token"}


def as_user(uid: str, tenant: str = "tenant-a", role: str = "viewer") -> None:
    app.dependency_overrides[principal_from_auth] = lambda: Principal(
        uid=uid, tenant_id=tenant, email=f"{uid}@x.co", role=role)


def upload(name: str, text: str, headers=ADMIN_A, **form) -> dict:
    r = client.post("/api/academy/documents", headers=headers,
                    files={"file": (name, text.encode(), "text/plain")}, data=form)
    assert r.status_code == 201, r.text
    return r.json()


def ask(question: str, headers=None) -> dict:
    r = client.post("/api/academy/ask", json={"question": question}, headers=headers or {})
    assert r.status_code == 200, r.text
    return r.json()


@pytest.fixture(autouse=True)
def clean():
    academy_store.reset()
    academy_search.reset()
    usage_store.reset()
    app.dependency_overrides.clear()
    yield
    app.dependency_overrides.clear()


@pytest.fixture
def kb():
    upload("handbook.txt", "Office wifi password rotates every friday.", sensitivity="0")
    upload("payroll.txt", "Payroll salary bands are confidential.", sensitivity="2")
    upload("runbook.txt", "Deploy runbook: rollback with the release tool.",
           sensitivity="1", dept_tags="engineering")
    upload("other.txt", "Office wifi password for tenant b is different.",
           headers=ADMIN_B, sensitivity="0")
    client.put("/api/academy/learners/u-sales", headers=ADMIN_A, json={
        "email": "s@a.co", "department": "sales", "role": "sdr", "clearance": 1})


def test_learner_sees_public_but_not_restricted_or_other_department(kb) -> None:
    as_user("u-sales")
    assert ask("wifi password")["grounded"] is True
    assert ask("payroll salary bands")["grounded"] is False
    assert ask("deploy runbook rollback")["grounded"] is False


def test_stopword_overlap_is_not_an_answer(kb) -> None:
    # "what are the" appears in public docs; must not count as grounding for a
    # question whose real answer is restricted.
    as_user("u-sales")
    body = ask("What are the salary bands?")
    assert body["grounded"] is False
    assert body["citations"] == []


def test_department_tag_grants_access(kb) -> None:
    as_user("admin", role="admin")
    client.put("/api/academy/learners/u-eng", json={
        "email": "e@a.co", "department": "engineering", "clearance": 1})
    as_user("u-eng")
    body = ask("deploy runbook rollback")
    assert body["grounded"] is True
    assert body["citations"][0]["title"] == "runbook.txt"


def test_learner_without_profile_gets_public_only(kb) -> None:
    as_user("u-new")
    assert ask("wifi password")["grounded"] is True
    assert ask("deploy runbook rollback")["grounded"] is False


def test_admin_sees_department_tagged_and_restricted_docs(kb) -> None:
    assert ask("deploy runbook rollback", ADMIN_A)["grounded"] is True
    assert ask("payroll salary bands", ADMIN_A)["grounded"] is True
    assert vertex_filter(Entitlement(2, unrestricted=True)) == "sensitivity <= 2"


def test_tenant_isolation(kb) -> None:
    body = ask("wifi password", ADMIN_A)
    titles = {c["title"] for c in body["citations"]}
    assert titles == {"handbook.txt"}
    assert all(d["title"] != "other.txt" for d in client.get(
        "/api/academy/documents", headers=ADMIN_A).json())


def test_viewer_cannot_upload_or_set_learners() -> None:
    as_user("u-viewer")
    r = client.post("/api/academy/documents",
                    files={"file": ("x.txt", b"hello", "text/plain")})
    assert r.status_code == 403
    assert client.put("/api/academy/learners/u2", json={"email": "a@b.co"}).status_code == 403


def test_upload_rejects_bad_type_and_tags() -> None:
    r = client.post("/api/academy/documents", headers=ADMIN_A,
                    files={"file": ("evil.exe", b"MZ", "application/octet-stream")})
    assert r.status_code == 415
    r = client.post("/api/academy/documents", headers=ADMIN_A,
                    files={"file": ("a.txt", b"x", "text/plain")}, data={"dept_tags": "Bad Tag!"})
    assert r.status_code == 422


def test_ask_counts_against_quota(kb) -> None:
    for _ in range(1000):
        usage_store.increment_or_reject("tenant-a")
    r = client.post("/api/academy/ask", json={"question": "wifi"}, headers=ADMIN_A)
    assert r.status_code == 429


def test_vertex_filter_expression() -> None:
    assert vertex_filter(Entitlement(1, "sales", "sdr")) == (
        'sensitivity <= 1 AND dept_tags: ANY("all", "sales") AND role_tags: ANY("all", "sdr")')
    assert vertex_filter(Entitlement()) == (
        'sensitivity <= 0 AND dept_tags: ANY("all") AND role_tags: ANY("all")')


def test_parse_engines() -> None:
    assert parse_engines("tenant-demo=pilot; ws-abc=acme;bad;=x") == {
        "tenant-demo": "pilot", "ws-abc": "acme"}
    assert parse_engines("") == {}


def test_vertex_parse_treats_skipped_answer_as_ungrounded() -> None:
    parsed = VertexKnowledgeSearch._parse({"answer": {
        "answerText": "something", "references": [],
        "answerSkippedReasons": ["NO_RELEVANT_CONTENT"]}})
    assert parsed.grounded is False and parsed.citations == []
