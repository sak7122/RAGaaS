"""Seed + walk through an Academy demo against a DEV backend (synthetic data only).

    python scripts/academy_demo_seed.py                 # http://127.0.0.1:8000
    python scripts/academy_demo_seed.py --api http://127.0.0.1:8000

Uses the dev-only tokens (rejected by a production backend), so it can never
touch real customer data:
    mock-tenant-token-abc  admin of tenant-demo
    demo-sales-token       sales learner, internal clearance
    demo-eng-token         engineering learner, internal clearance
    demo-new-token         new hire with no profile yet (public only)
"""
import argparse
import sys

import httpx

ADMIN = "mock-tenant-token-abc"
LEARNERS = {
    "Sales hire":       "demo-sales-token",
    "Engineering hire": "demo-eng-token",
    "No profile yet":   "demo-new-token",
    "Admin":            ADMIN,
}

DOCS = [
    ("acme_handbook.txt", "0", "", "",
     "Acme Handbook. Office hours are 10am to 6pm. The wifi password rotates every Friday "
     "and is posted at reception. Lunch is served at 1pm. Leave requests go through the HR portal."),
    ("sales_playbook.txt", "1", "sales", "",
     "Sales Playbook. Discounts above 15 percent need approval from the sales director. "
     "Refunds are allowed within 30 days of purchase. Always log calls in the CRM the same day."),
    ("deploy_runbook.txt", "1", "engineering", "",
     "Deploy Runbook. To roll back a release run release-tool rollback with the previous tag. "
     "Production deploys are frozen on Fridays after 4pm."),
    ("payroll_bands.txt", "2", "", "",
     "Payroll Bands (confidential). L1 salary band is 6 to 8 lakh. L2 is 9 to 12 lakh."),
]

QUESTIONS = [
    "When does the wifi password rotate?",
    "What discount needs director approval?",
    "How do I roll back a release?",
    "What are the salary bands?",
]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--api", default="http://127.0.0.1:8000")
    api = ap.parse_args().api.rstrip("/")
    c = httpx.Client(base_url=api, timeout=60)

    def h(token: str) -> dict:
        return {"Authorization": f"Bearer {token}"}

    try:
        c.get("/api/health").raise_for_status()
    except Exception as exc:
        sys.exit(f"Backend not reachable at {api}: {exc}")

    existing = {d["title"] for d in c.get("/api/academy/documents", headers=h(ADMIN)).json()}
    for name, sens, dept, role, text in DOCS:
        if name in existing:
            continue
        r = c.post("/api/academy/documents", headers=h(ADMIN),
                   files={"file": (name, text.encode(), "text/plain")},
                   data={"sensitivity": sens, "dept_tags": dept, "role_tags": role})
        r.raise_for_status()
    print(f"documents: {len(DOCS)} (public, sales-only, engineering-only, restricted)")

    for uid, dept in [("demo-sales", "sales"), ("demo-eng", "engineering")]:
        c.put(f"/api/academy/learners/{uid}", headers=h(ADMIN), json={
            "email": f"{uid}@ragaas.local", "department": dept, "clearance": 1,
        }).raise_for_status()
    print("learners: demo-sales (sales), demo-eng (engineering), demo-new (no profile)\n")

    width = max(len(q) for q in QUESTIONS)
    print(" " * width + " | " + " | ".join(f"{k:16}" for k in LEARNERS))
    for q in QUESTIONS:
        row = []
        for token in LEARNERS.values():
            r = c.post("/api/academy/ask", headers=h(token), json={"question": q})
            body = r.json()
            row.append(f"{'answered' if body.get('grounded') else 'not visible':16}")
        print(f"{q:{width}} | " + " | ".join(row))
    print(f"\nTry it yourself: {api}/docs  (Authorize header: Bearer <token above>)")


if __name__ == "__main__":
    main()
