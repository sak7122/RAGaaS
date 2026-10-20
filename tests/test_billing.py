"""Plans, limits and Razorpay subscription flow (no network: Razorpay calls are faked)."""
import hashlib
import hmac
import json
import os

os.environ["RAGAAS_USE_MEMORY_STORE"] = "1"

import pytest
from fastapi.testclient import TestClient

import backend.main as main
from backend import billing
from backend.billing import MemoryBillingStore

client = TestClient(main.app)
A = {"Authorization": "Bearer tenant-a-token"}
VIEWER = {"Authorization": "Bearer demo-sales-token"}


@pytest.fixture(autouse=True)
def fresh(monkeypatch):
    main.usage_store.reset()
    monkeypatch.setattr(main, "billing_store", MemoryBillingStore())
    for k in ("BILLING_ENFORCED", "RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET", "RAZORPAY_WEBHOOK_SECRET",
              "RAZORPAY_PLAN_STARTER", "RAZORPAY_PLAN_TEAM"):
        monkeypatch.delenv(k, raising=False)
    idx = main.load_index()
    idx["documents"] = [d for d in idx["documents"] if d["tenant_id"] != "tenant-a"]
    main.save_index(idx)


def enforce(monkeypatch):
    monkeypatch.setenv("BILLING_ENFORCED", "1")


def razorpay(monkeypatch):
    monkeypatch.setenv("RAZORPAY_KEY_ID", "rzp_test_x")
    monkeypatch.setenv("RAZORPAY_KEY_SECRET", "keysecret")
    monkeypatch.setenv("RAZORPAY_WEBHOOK_SECRET", "hooksecret")
    monkeypatch.setenv("RAZORPAY_PLAN_TEAM", "plan_team_1")
    monkeypatch.setattr(billing, "create_subscription", lambda plan, tenant, email: {"id": "sub_123"})


def upload(name):
    return client.post("/api/upload", headers=A, files={"file": (name, b"Some policy text here.", "text/plain")})


def test_not_enforced_means_beta_with_no_limits():
    body = client.get("/api/billing", headers=A).json()
    assert body["enforced"] is False and body["plan"]["id"] == "beta"
    assert client.post("/api/integrations/slack/connect", headers=A,
                       json={"team_id": "T1", "team_name": "Acme"}).status_code == 200


def test_free_plan_monthly_question_limit(monkeypatch):
    enforce(monkeypatch)
    upload("policy.txt")
    for _ in range(main.billing_store.questions_this_month("tenant-a"), 100):
        main.billing_store.count_question("tenant-a")
    r = client.post("/api/chat", headers=A, json={"message": "what is the policy"})
    assert r.status_code == 429 and "Free plan" in r.json()["detail"]


def test_free_plan_document_limit(monkeypatch):
    enforce(monkeypatch)
    for i in range(10):
        assert upload(f"doc{i}.txt").status_code == 200
    assert upload("doc0.txt").status_code == 200          # replacing is fine
    r = upload("doc10.txt")
    assert r.status_code == 403 and "10 documents" in r.json()["detail"]


def test_channels_need_the_team_plan(monkeypatch):
    enforce(monkeypatch)
    r = client.post("/api/integrations/slack/connect", headers=A, json={"team_id": "T1", "team_name": "Acme"})
    assert r.status_code == 403 and "Team plan" in r.json()["detail"]
    main.billing_store.set_plan("tenant-a", "team", status="active")
    assert client.post("/api/integrations/slack/connect", headers=A,
                       json={"team_id": "T1", "team_name": "Acme"}).status_code == 200


def test_unpaid_plan_falls_back_to_free(monkeypatch):
    enforce(monkeypatch)
    main.billing_store.set_plan("tenant-a", "team", status="halted")
    assert client.get("/api/billing", headers=A).json()["plan"]["id"] == "free"


def test_checkout_without_razorpay_says_so(monkeypatch):
    enforce(monkeypatch)
    r = client.post("/api/billing/checkout", headers=A, json={"plan": "team"})
    assert r.status_code == 503


def test_checkout_is_admin_only(monkeypatch):
    razorpay(monkeypatch)
    assert client.post("/api/billing/checkout", headers=VIEWER, json={"plan": "team"}).status_code == 403


def test_checkout_verify_upgrades(monkeypatch):
    enforce(monkeypatch)
    razorpay(monkeypatch)
    r = client.post("/api/billing/checkout", headers=A, json={"plan": "team"}).json()
    assert r["subscription_id"] == "sub_123" and r["key_id"] == "rzp_test_x"
    bad = {"razorpay_payment_id": "pay_1", "razorpay_subscription_id": "sub_123", "razorpay_signature": "nope"}
    assert client.post("/api/billing/verify", headers=A, json=bad).status_code == 400
    sig = hmac.new(b"keysecret", b"pay_1|sub_123", hashlib.sha256).hexdigest()
    ok = client.post("/api/billing/verify", headers=A, json={**bad, "razorpay_signature": sig})
    assert ok.status_code == 200 and ok.json()["plan"] == "team"
    assert client.get("/api/billing", headers=A).json()["plan"]["id"] == "team"


def test_verify_rejects_someone_elses_subscription(monkeypatch):
    razorpay(monkeypatch)
    sig = hmac.new(b"keysecret", b"pay_1|sub_other", hashlib.sha256).hexdigest()
    r = client.post("/api/billing/verify", headers=A, json={
        "razorpay_payment_id": "pay_1", "razorpay_subscription_id": "sub_other", "razorpay_signature": sig})
    assert r.status_code == 400


def hook(event, sub, secret=b"hooksecret"):
    body = json.dumps({"event": event, "payload": {"subscription": {"entity": sub}}}).encode()
    sig = hmac.new(secret, body, hashlib.sha256).hexdigest()
    return client.post("/api/billing/webhook", content=body,
                       headers={"Content-Type": "application/json", "X-Razorpay-Signature": sig})


def test_webhook_signature_and_lifecycle(monkeypatch):
    enforce(monkeypatch)
    razorpay(monkeypatch)
    sub = {"id": "sub_9", "notes": {"tenant_id": "tenant-a", "plan": "starter"}, "current_end": 1893456000}
    assert hook("subscription.activated", sub, secret=b"wrong").status_code == 401
    assert hook("subscription.activated", sub).status_code == 200
    body = client.get("/api/billing", headers=A).json()
    assert body["plan"]["id"] == "starter" and body["renews_at"].startswith("2030")
    hook("subscription.halted", sub)
    assert client.get("/api/billing", headers=A).json()["plan"]["id"] == "free"
