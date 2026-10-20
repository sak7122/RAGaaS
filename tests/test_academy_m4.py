from datetime import datetime, timedelta, timezone

from test_academy_m3 import (  # noqa: F401  (clean/catalog are fixtures)
    HANDBOOK, add_learner, as_admin, as_user, catalog, clean, client, perfect_answers, upload,
    wrong_answers,
)

from backend.main import academy_store


def plan() -> dict:
    r = client.get("/api/academy/learn/plan")
    assert r.status_code == 200, r.text
    return r.json()


def path_in_plan(title: str) -> dict:
    return next(p for p in plan()["paths"] if p["title"] == title)


def submit(module: dict, answers: list[dict]) -> dict:
    r = client.post(f"/api/academy/learn/modules/{module['id']}/submit", json={"answers": answers})
    assert r.status_code == 200, r.text
    return r.json()


def complete(path: dict) -> None:
    for m in path["modules"]:
        submit(m, perfect_answers(m))


def dashboard() -> dict:
    as_admin()
    r = client.get("/api/academy/dashboard")
    assert r.status_code == 200, r.text
    return r.json()


# ── Assignments & due dates ───────────────────────────────────────────────────
def test_opening_academy_assigns_paths_with_due_dates(catalog) -> None:
    as_admin()
    r = client.patch(f"/api/academy/paths/{catalog['sales']['id']}", json={"due_days": 14})
    assert r.status_code == 200 and r.json()["rules"]["due_days"] == 14
    as_user("rep")
    sales = path_in_plan("Sales onboarding")
    due = datetime.fromisoformat(sales["due_at"])
    assert timedelta(days=13, hours=23) < due - datetime.now(timezone.utc) <= timedelta(days=14)
    assert sales["overdue"] is False and path_in_plan("All staff")["due_at"] is None
    assert academy_store.get_assignment("tenant-a", "rep", catalog["sales"]["id"]).status == "assigned"

    a = academy_store.get_assignment("tenant-a", "rep", catalog["sales"]["id"])
    a.due_at = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
    academy_store.upsert_assignment(a)
    assert path_in_plan("Sales onboarding")["overdue"] is True
    assert dashboard()["totals"]["overdue"] == 1


def test_changing_due_window_moves_open_deadlines(catalog) -> None:
    as_user("rep")
    plan()
    as_admin()
    pid = catalog["sales"]["id"]
    client.patch(f"/api/academy/paths/{pid}", json={"due_days": 7})
    a = academy_store.get_assignment("tenant-a", "rep", pid)
    assert _days(a.assigned_at, a.due_at) == 7
    client.patch(f"/api/academy/paths/{pid}", json={"due_days": None})
    assert academy_store.get_assignment("tenant-a", "rep", pid).due_at is None
    client.patch(f"/api/academy/paths/{pid}", json={"title": "Renamed"})     # untouched fields stay
    assert academy_store.get_path("tenant-a", pid).rules.get("due_days") is None


def _days(start: str, end: str) -> float:
    return round((datetime.fromisoformat(end) - datetime.fromisoformat(start)).total_seconds() / 86400)


def test_path_settings_validation_and_pass_mark(catalog) -> None:
    pid = catalog["all"]["id"]
    as_admin()
    assert client.patch(f"/api/academy/paths/{pid}", json={"pass_mark": 0.4}).status_code == 422
    assert client.patch(f"/api/academy/paths/{pid}", json={"due_days": 0}).status_code == 422
    assert client.patch(f"/api/academy/paths/{pid}", json={"pass_mark": 0.5}).json()["pass_mark"] == 0.5
    as_user("rep")
    module = catalog["all"]["modules"][0]
    first_two = perfect_answers(module)[:2]
    out = submit(module, first_two)          # 2 of 3 right ≈ 0.67 passes at 0.5
    assert out["passed"] and out["pass_mark"] == 0.5
    as_user("rep")
    assert client.patch(f"/api/academy/paths/{pid}", json={"pass_mark": 0.9}).status_code == 403


# ── Sign-off & certificates ───────────────────────────────────────────────────
def test_signoff_requires_pass_then_certificate_downloads(catalog) -> None:
    pid = catalog["all"]["id"]
    as_admin()
    client.put("/api/academy/learners/rep", json={"email": "rep@x.co", "name": "Priya Sharma",
                                                 "department": "sales", "clearance": 1})
    certify = f"/api/academy/paths/{pid}/learners/rep/certify"
    assert client.post(certify).status_code == 409                       # never started
    as_user("rep")
    assert client.get(f"/api/academy/learn/paths/{pid}/certificate").status_code == 404
    complete(catalog["all"])
    assert path_in_plan("All staff")["status"] == "passed"
    assert client.post(certify).status_code == 403                       # learners can't self-certify

    as_admin()
    r = client.post(certify)
    assert r.status_code == 200 and r.json()["certificate_id"]
    again = client.post(certify).json()
    assert again["certified_at"] == r.json()["certified_at"]             # idempotent
    admin_pdf = client.get(f"/api/academy/paths/{pid}/learners/rep/certificate")
    assert admin_pdf.status_code == 200 and admin_pdf.content.startswith(b"%PDF")
    assert "attachment" in admin_pdf.headers["content-disposition"]

    as_user("rep")
    assert path_in_plan("All staff")["status"] == "certified"
    mine = client.get(f"/api/academy/learn/paths/{pid}/certificate")
    assert mine.status_code == 200 and mine.headers["content-type"] == "application/pdf"
    submit(catalog["all"]["modules"][0], wrong_answers(catalog["all"]["modules"][0]))   # retake
    assert academy_store.get_assignment("tenant-a", "rep", pid).status == "certified"

    as_user("eng")                                                        # someone else's certificate
    assert client.get(f"/api/academy/learn/paths/{pid}/certificate").status_code == 404
    as_admin("tenant-b")
    assert client.post(certify).status_code == 404
    assert client.get(f"/api/academy/paths/{pid}/learners/rep/certificate").status_code == 404


# ── Dashboard ─────────────────────────────────────────────────────────────────
def test_dashboard_funnel_learners_and_totals(catalog) -> None:
    as_admin()
    client.post("/api/academy/learners/import", content=b"email,name,department\nnew@acme.com,New Hire,sales\n",
                headers={"Content-Type": "text/csv"})
    as_user("rep")
    complete(catalog["all"])
    as_user("eng")
    submit(catalog["all"]["modules"][0], wrong_answers(catalog["all"]["modules"][0]))

    d = dashboard()
    paths = {p["title"]: p for p in d["paths"]}
    assert set(paths) == {"All staff", "Sales onboarding", "Managers"}   # unpublished draft excluded
    allp = paths["All staff"]
    assert (allp["eligible"], allp["started"], allp["passed"], allp["certified"]) == (3, 2, 1, 0)
    assert allp["avg_score"] == 1.0 and allp["median_days_to_ready"] is not None
    assert paths["Managers"]["eligible"] == 0                            # nobody has restricted clearance

    learners = {lr["email"]: lr for lr in d["learners"]}
    assert learners["new@acme.com"]["pending"] and learners["new@acme.com"]["name"] == "New Hire"
    assert {p["title"] for p in learners["rep@x.co"]["paths"]} == {"All staff", "Sales onboarding"}
    eng_all = next(p for p in learners["eng@x.co"]["paths"] if p["title"] == "All staff")
    assert eng_all["weak_modules"] == [catalog["all"]["modules"][0]["title"]]
    rep_sales = next(p for p in learners["rep@x.co"]["paths"] if p["title"] == "Sales onboarding")
    assert rep_sales["weak_modules"] == []
    assert learners["rep@x.co"]["last_active"]
    t = d["totals"]
    assert (t["learners"], t["not_signed_in"], t["completed"], t["awaiting_signoff"]) == (3, 1, 1, 1)
    assert t["assignments"] == 5 and t["in_progress"] == 1


def test_dashboard_hardest_questions_gaps_and_stale(catalog) -> None:
    module = catalog["all"]["modules"][0]
    for uid in ("rep", "eng", "walk-in"):
        as_user(uid)
        submit(module, wrong_answers(module))
    as_user("rep")
    for q in ("What is the parking policy?", "what is the PARKING policy", "Who approves travel?"):
        client.post("/api/academy/ask", json={"question": q})
    client.post("/api/academy/ask", json={"question": "When does the wifi password rotate?"})  # answered
    client.post("/api/academy/ask", json={"question": "What is the level two salary band?"})  # exists, not cleared

    as_admin()
    upload("handbook.txt", HANDBOOK + " Badges are collected at security.", sensitivity="0")
    d = dashboard()
    assert len(d["hardest"]) == len(module["items"])
    assert all(h["attempts"] == 3 and h["avg_score"] < 0.5 for h in d["hardest"])
    assert d["gaps"][0]["count"] == 2 and "parking" in d["gaps"][0]["question"].lower()
    assert {g["question"] for g in d["gaps"]} >= {"Who approves travel?"}
    assert not any("wifi" in g["question"] for g in d["gaps"])
    assert not any("salary" in g["question"] for g in d["gaps"])
    stale = {s["title"]: s for s in d["stale"]}
    assert stale["All staff"]["stale_lessons"] >= 1


def test_dashboard_is_admin_only_and_tenant_scoped(catalog) -> None:
    as_user("rep")
    assert client.get("/api/academy/dashboard").status_code == 403
    as_admin("tenant-b")
    d = client.get("/api/academy/dashboard").json()
    assert d["learners"] == [] and d["paths"] == []


def test_csv_name_column_is_validated() -> None:
    as_admin()
    r = client.post("/api/academy/learners/import", headers={"Content-Type": "text/csv"},
                    content=("email,name\na@x.co,Ann\nb@x.co," + "x" * 121 + "\n").encode())
    assert r.json()["created"] == 1 and "name" in r.json()["errors"][0]["message"]
    assert client.get("/api/academy/learners").json()[0]["name"] == "Ann"
