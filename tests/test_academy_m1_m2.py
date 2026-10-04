import os

os.environ["RAGAAS_USE_MEMORY_STORE"] = "1"

import pytest
from fastapi.testclient import TestClient

from backend.academy.course import extract_json_array, validate_item
from backend.firebase_services import Principal
from backend.main import academy_search, academy_store, app, principal_from_auth, usage_store

client = TestClient(app)
ADMIN_A = {"Authorization": "Bearer tenant-a-token"}
ADMIN_B = {"Authorization": "Bearer tenant-b-token"}

HANDBOOK = ("Acme Handbook. Office hours are ten to six on weekdays. The wifi password rotates "
            "every Friday morning. Leave requests are filed through the HR portal.")
SALES = ("Sales Playbook. Discounts above fifteen percent need director approval. Refunds are "
         "allowed within thirty days of purchase. Log every call in the CRM the same day.")


def as_user(uid: str, email: str | None = None, tenant: str = "tenant-a", role: str = "viewer") -> None:
    app.dependency_overrides[principal_from_auth] = lambda: Principal(
        uid=uid, tenant_id=tenant, email=email or f"{uid}@x.co", role=role)


def upload(name: str, text: str, headers=ADMIN_A, **form) -> dict:
    r = client.post("/api/academy/documents", headers=headers,
                    files={"file": (name, text.encode(), "text/plain")}, data=form)
    assert r.status_code == 201, r.text
    return r.json()


@pytest.fixture(autouse=True)
def clean():
    academy_store.reset()
    academy_search.reset()
    usage_store.reset()
    app.dependency_overrides.clear()
    yield
    app.dependency_overrides.clear()


# ── M1: documents ─────────────────────────────────────────────────────────────
def test_reupload_identical_is_noop_and_changed_bumps_version() -> None:
    first = upload("handbook.txt", HANDBOOK, sensitivity="0")
    same = upload("handbook.txt", HANDBOOK, sensitivity="0")
    assert same["unchanged"] is True and same["id"] == first["id"] and same["version"] == 1
    changed = upload("handbook.txt", HANDBOOK + " Lunch is at one.", sensitivity="0")
    assert changed["id"] == first["id"] and changed["version"] == 2 and not changed["unchanged"]
    assert len(client.get("/api/academy/documents", headers=ADMIN_A).json()) == 1


def test_new_version_marks_generated_content_stale_and_blocks_publish() -> None:
    upload("handbook.txt", HANDBOOK, sensitivity="0")
    path = client.post("/api/academy/paths", headers=ADMIN_A,
                       json={"title": "Day one", "clearance": 0, "module_count": 1}).json()
    assert path["status"] == "draft"
    changed = upload("handbook.txt", HANDBOOK + " Badges are collected at security.", sensitivity="0")
    assert changed["stale_marked"] >= 1
    detail = client.get(f"/api/academy/paths/{path['id']}", headers=ADMIN_A).json()
    assert detail["status"] == "stale"
    assert detail["modules"][0]["status"] == "stale"
    r = client.post(f"/api/academy/paths/{path['id']}/publish", headers=ADMIN_A)
    assert r.status_code == 409
    # Editing the lesson is the review that clears it.
    mid = detail["modules"][0]["id"]
    client.put(f"/api/academy/modules/{mid}", headers=ADMIN_A, json={"lesson_md": "Reviewed lesson."})
    assert client.post(f"/api/academy/paths/{path['id']}/publish", headers=ADMIN_A).status_code == 200


def test_delete_document_removes_it_from_search_and_list() -> None:
    doc = upload("handbook.txt", HANDBOOK, sensitivity="0")
    assert client.post("/api/academy/ask", headers=ADMIN_A, json={"question": "wifi password"}).json()["grounded"]
    r = client.delete(f"/api/academy/documents/{doc['id']}", headers=ADMIN_A)
    assert r.status_code == 200
    assert client.get("/api/academy/documents", headers=ADMIN_A).json() == []
    assert not client.post("/api/academy/ask", headers=ADMIN_A, json={"question": "wifi password"}).json()["grounded"]
    assert client.delete(f"/api/academy/documents/{doc['id']}", headers=ADMIN_A).status_code == 404


def test_cannot_delete_other_tenants_document() -> None:
    doc = upload("handbook.txt", HANDBOOK, sensitivity="0")
    assert client.delete(f"/api/academy/documents/{doc['id']}", headers=ADMIN_B).status_code == 404


# ── M1: learners ──────────────────────────────────────────────────────────────
CSV = ("email,department,role,clearance,seniority\n"
       "Sam@Acme.com,sales,sdr,internal,2\n"
       "not-an-email,sales,,internal,\n"
       "lee@acme.com,engineering,,restricted,\n"
       "kim@acme.com,ops,,secret,\n")


def test_csv_import_creates_pending_learners_and_reports_bad_rows() -> None:
    r = client.post("/api/academy/learners/import", headers={**ADMIN_A, "Content-Type": "text/csv"},
                    content=CSV.encode())
    body = r.json()
    assert r.status_code == 200, body
    assert body["created"] == 2 and body["updated"] == 0
    assert [e["line"] for e in body["errors"]] == [3, 5]
    learners = {lr["email"]: lr for lr in client.get("/api/academy/learners", headers=ADMIN_A).json()}
    assert learners["sam@acme.com"]["pending"] is True and learners["sam@acme.com"]["clearance"] == 1
    assert learners["lee@acme.com"]["clearance"] == 2
    # Re-import updates instead of duplicating.
    again = client.post("/api/academy/learners/import", headers={**ADMIN_A, "Content-Type": "text/csv"},
                        content=b"email,department\nsam@acme.com,marketing\n").json()
    assert again == {"created": 0, "updated": 1, "errors": []}


def test_pending_learner_is_claimed_on_first_sign_in() -> None:
    upload("sales.txt", SALES, sensitivity="1", dept_tags="sales")
    client.post("/api/academy/learners/import", headers={**ADMIN_A, "Content-Type": "text/csv"},
                content=b"email,department,clearance\nsam@acme.com,sales,internal\n")
    as_user("firebase-uid-sam", email="Sam@acme.com")
    me = client.get("/api/academy/me").json()
    assert me["department"] == "sales" and me["clearance"] == 1
    assert client.post("/api/academy/ask", json={"question": "discount director approval"}).json()["grounded"]
    as_user("admin", role="admin")
    uids = [lr["uid"] for lr in client.get("/api/academy/learners").json()]
    assert uids == ["firebase-uid-sam"]


def test_csv_without_email_header_is_rejected() -> None:
    r = client.post("/api/academy/learners/import", headers={**ADMIN_A, "Content-Type": "text/csv"},
                    content=b"name,department\nSam,sales\n")
    assert r.status_code == 422


def test_viewer_cannot_manage_learners_or_paths() -> None:
    as_user("u-viewer")
    assert client.get("/api/academy/learners").status_code == 403
    assert client.post("/api/academy/paths", json={"title": "x path"}).status_code == 403


# ── M2: paths ─────────────────────────────────────────────────────────────────
def test_path_generation_respects_audience_entitlement() -> None:
    upload("handbook.txt", HANDBOOK, sensitivity="0")
    upload("sales.txt", SALES, sensitivity="1", dept_tags="sales")
    eng = client.post("/api/academy/paths", headers=ADMIN_A,
                      json={"title": "Engineering day one", "department": "engineering", "clearance": 1}).json()
    sales = client.post("/api/academy/paths", headers=ADMIN_A,
                        json={"title": "Sales day one", "department": "sales", "clearance": 1}).json()
    assert [m["title"] for m in eng["modules"]] == ["Handbook"]
    assert sorted(m["title"] for m in sales["modules"]) == ["Handbook", "Sales"]
    for m in sales["modules"]:
        assert m["source_doc_ids"] and m["items"]
        mcq = next(i for i in m["items"] if i["type"] == "mcq")
        assert len(mcq["options"]) == 4 and 0 <= mcq["answer"] <= 3


def test_path_needs_visible_documents() -> None:
    upload("sales.txt", SALES, sensitivity="2")
    r = client.post("/api/academy/paths", headers=ADMIN_A, json={"title": "Too low", "clearance": 0})
    assert r.status_code == 422


def test_item_edit_validates_and_publish_then_edit_returns_to_draft() -> None:
    upload("handbook.txt", HANDBOOK, sensitivity="0")
    path = client.post("/api/academy/paths", headers=ADMIN_A, json={"title": "Basics", "clearance": 0}).json()
    item = next(i for i in path["modules"][0]["items"] if i["type"] == "mcq")
    bad = client.put(f"/api/academy/items/{item['id']}", headers=ADMIN_A,
                     json={"type": "mcq", "stem": "Pick one", "options": ["a", "a", "b", "c"], "answer": 0})
    assert bad.status_code == 422
    assert client.post(f"/api/academy/paths/{path['id']}/publish", headers=ADMIN_A).json()["status"] == "published"
    ok = client.put(f"/api/academy/items/{item['id']}", headers=ADMIN_A,
                    json={"type": "true_false", "stem": "Wifi rotates on Fridays.", "answer": True})
    assert ok.status_code == 200 and ok.json()["options"] is None
    assert client.get(f"/api/academy/paths/{path['id']}", headers=ADMIN_A).json()["status"] == "draft"


def test_paths_are_tenant_isolated() -> None:
    upload("handbook.txt", HANDBOOK, sensitivity="0")
    path = client.post("/api/academy/paths", headers=ADMIN_A, json={"title": "Basics", "clearance": 0}).json()
    assert client.get(f"/api/academy/paths/{path['id']}", headers=ADMIN_B).status_code == 404
    assert client.get("/api/academy/paths", headers=ADMIN_B).json() == []
    mid = path["modules"][0]["id"]
    assert client.put(f"/api/academy/modules/{mid}", headers=ADMIN_B, json={"title": "pwned"}).status_code == 404


# ── Generator parsing ─────────────────────────────────────────────────────────
def test_extract_json_array_handles_fences_and_prose() -> None:
    assert extract_json_array('Sure! ```json\n[{"title": "A"}]\n``` hope that helps') == [{"title": "A"}]
    assert extract_json_array("no json here") == []
    assert extract_json_array("[broken") == []


def test_validate_item_rejects_malformed_model_output() -> None:
    good = {"type": "mcq", "stem": "Q?", "options": ["a", "b", "c", "d"], "answer": 2, "explanation": "x"}
    assert validate_item(good, ["d1"]).answer == 2
    assert validate_item({**good, "answer": 4}, []) is None
    assert validate_item({**good, "answer": True}, []) is None          # bool is not an index
    assert validate_item({**good, "options": ["a", "A", "b", "c"]}, []) is None
    assert validate_item({"type": "true_false", "stem": "S", "answer": "yes"}, []) is None
    assert validate_item({"type": "essay", "stem": "S"}, []) is None
