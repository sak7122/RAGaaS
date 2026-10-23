"""Slack and WhatsApp channels: signatures, quota, the shared answer pipeline, and
WhatsApp's phone-linking flow (team members only)."""
import dataclasses
import hashlib
import hmac
import json
import os
import time
import urllib.parse

os.environ["RAGAAS_USE_MEMORY_STORE"] = "1"

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

import backend.main as main
from backend import whatsapp as wa
from backend.slack_store import MemorySlackStore
from backend.whatsapp_store import MemoryWhatsAppStore

client = TestClient(main.app)
ADMIN_A = {"Authorization": "Bearer tenant-a-token"}
ADMIN_B = {"Authorization": "Bearer tenant-b-token"}
VIEWER = {"Authorization": "Bearer demo-sales-token"}
PNID_A, PNID_B = "1110001", "2220002"
PHONE = "447700900123"


@pytest.fixture(autouse=True)
def fresh(monkeypatch):
    main.usage_store.reset()
    main.insights_store.reset()
    monkeypatch.setattr(main, "slack_store", MemorySlackStore())
    monkeypatch.setattr(main, "whatsapp_store", MemoryWhatsAppStore())
    monkeypatch.setattr(main, "SLACK_SIGNING_SECRET", "")
    for k in ("WHATSAPP_APP_SECRET", "WHATSAPP_VERIFY_TOKEN", "WHATSAPP_ACCESS_TOKEN"):
        monkeypatch.delenv(k, raising=False)
    idx = main.load_index()
    idx["documents"] = [d for d in idx["documents"] if d["tenant_id"] != "tenant-a"]
    idx["documents"].append({
        "tenant_id": "tenant-a", "file_name": "handbook.pdf", "title": "Employee Handbook",
        "uploaded_at": "2026-10-10T00:00:00Z",
        "chunks": [{"page": 12, "chunk_index": 0,
                    "text": "Security awareness training is due within five business days of starting."}],
    })
    main.save_index(idx)
    sent: list[tuple[str, str, str]] = []
    monkeypatch.setattr(wa, "send_text", lambda pnid, to, text: sent.append((pnid, to, text)))
    monkeypatch.setattr(wa, "mark_read", lambda pnid, mid: None)
    yield sent


def prod(monkeypatch):
    monkeypatch.setattr(main, "config", dataclasses.replace(main.config, env="production"))


# ── Shared helpers ────────────────────────────────────────────────────────────
def test_whatsapp_formatting_and_split():
    assert wa.to_whatsapp("## Steps\n- **Bring** ID\n- see [policy](https://x.io)") == \
        "*Steps*\n• *Bring* ID\n• see policy (https://x.io)"
    parts = wa.split("word " * 2000, limit=4096)
    assert all(len(p) <= 4096 for p in parts) and "".join(parts).replace(" ", "") == "word" * 2000
    assert wa.digits("+44 (7700) 900-123") == PHONE
    assert wa.mask(PHONE) == "•••• 0123"


# ── Slack ─────────────────────────────────────────────────────────────────────
def slack_form(team="T1", text="when is security training due?"):
    return {"team_id": team, "text": text, "user_name": "maya",
            "response_url": "https://hooks.slack.com/commands/x"}


def connect_slack(headers=ADMIN_A, team="T1"):
    assert client.post("/api/integrations/slack/connect", headers=headers,
                       json={"team_id": team, "team_name": "Acme"}).status_code == 200


def test_slack_answers_inline_with_sources():
    connect_slack()
    r = client.post("/api/integrations/slack/command", data=slack_form())
    assert r.status_code == 200
    body = r.json()
    assert body["response_type"] == "in_channel"
    assert "maya asked:" in body["text"] and "Employee Handbook, p. 12" in body["text"]
    assert main.insights_store.channel_queries("tenant-a", "slack")[0]["slack_user"] == "maya"


def test_slack_rejects_bad_signature_when_secret_set(monkeypatch):
    connect_slack()
    monkeypatch.setattr(main, "SLACK_SIGNING_SECRET", "s3cret")
    body = urllib.parse.urlencode(slack_form())
    ts = str(int(time.time()))
    headers = {"Content-Type": "application/x-www-form-urlencoded", "X-Slack-Request-Timestamp": ts}
    bad = client.post("/api/integrations/slack/command", content=body, headers={**headers, "X-Slack-Signature": "v0=nope"})
    assert bad.status_code == 401
    sig = "v0=" + hmac.new(b"s3cret", f"v0:{ts}:{body}".encode(), hashlib.sha256).hexdigest()
    ok = client.post("/api/integrations/slack/command", content=body, headers={**headers, "X-Slack-Signature": sig})
    assert ok.status_code == 200


def test_slack_refuses_unsigned_requests_in_production(monkeypatch):
    connect_slack()
    prod(monkeypatch)
    r = client.post("/api/integrations/slack/command", data=slack_form())
    assert r.status_code == 503


def test_slack_counts_against_the_daily_limit(monkeypatch):
    connect_slack()
    def full(_tenant):
        raise HTTPException(status_code=429, detail="Tenant query quota exceeded")
    monkeypatch.setattr(main, "enforce_quota", full)
    r = client.post("/api/integrations/slack/command", data=slack_form())
    assert r.json()["response_type"] == "ephemeral" and "limit" in r.json()["text"]


def test_slack_unknown_team():
    r = client.post("/api/integrations/slack/command", data=slack_form(team="T-unknown"))
    assert "isn't connected" in r.json()["text"]


# ── WhatsApp ──────────────────────────────────────────────────────────────────
def wa_payload(text, frm=PHONE, pnid=PNID_A, mid=None):
    return {"object": "whatsapp_business_account", "entry": [{"changes": [{"value": {
        "messaging_product": "whatsapp",
        "metadata": {"phone_number_id": pnid, "display_phone_number": "15550001111"},
        "contacts": [{"wa_id": frm, "profile": {"name": "Maya"}}],
        "messages": [{"from": frm, "id": mid or f"wamid.{time.time_ns()}", "timestamp": "1",
                      "type": "text", "text": {"body": text}}],
    }}]}]}


def hook(payload):
    return client.post("/api/integrations/whatsapp/webhook", json=payload)


def connect_number(headers=ADMIN_A, pnid=PNID_A):
    r = client.post("/api/integrations/whatsapp/connect", headers=headers,
                    json={"phone_number_id": pnid, "display_phone": "+1 555 000 1111"})
    assert r.status_code == 200, r.text
    return r.json()


def link_phone(fresh, headers=ADMIN_A, phone="+44 7700 900123"):
    code = client.post("/api/integrations/whatsapp/link", headers=headers, json={"phone": phone}).json()["code"]
    hook(wa_payload(f"link {code}"))
    return code


def test_whatsapp_webhook_verification(monkeypatch):
    monkeypatch.setenv("WHATSAPP_VERIFY_TOKEN", "tok")
    ok = client.get("/api/integrations/whatsapp/webhook",
                    params={"hub.mode": "subscribe", "hub.verify_token": "tok", "hub.challenge": "42"})
    assert ok.status_code == 200 and ok.text == "42"
    bad = client.get("/api/integrations/whatsapp/webhook",
                     params={"hub.mode": "subscribe", "hub.verify_token": "nope", "hub.challenge": "42"})
    assert bad.status_code == 403


def test_whatsapp_signature(monkeypatch, fresh):
    connect_number()
    monkeypatch.setenv("WHATSAPP_APP_SECRET", "app-secret")
    body = json.dumps(wa_payload("hi")).encode()
    assert client.post("/api/integrations/whatsapp/webhook", content=body,
                       headers={"Content-Type": "application/json"}).status_code == 401
    sig = "sha256=" + hmac.new(b"app-secret", body, hashlib.sha256).hexdigest()
    r = client.post("/api/integrations/whatsapp/webhook", content=body,
                    headers={"Content-Type": "application/json", "X-Hub-Signature-256": sig})
    assert r.status_code == 200


def test_whatsapp_refuses_unsigned_in_production(monkeypatch):
    prod(monkeypatch)
    assert hook(wa_payload("hi")).status_code == 503


def test_connect_is_admin_only_and_one_workspace_per_number():
    assert client.post("/api/integrations/whatsapp/connect", headers=VIEWER,
                       json={"phone_number_id": PNID_A, "display_phone": "+1 555 000 1111"}).status_code == 403
    connect_number()
    r = client.post("/api/integrations/whatsapp/connect", headers=ADMIN_B,
                    json={"phone_number_id": PNID_A, "display_phone": "+1 555"})
    assert r.status_code == 409


def test_link_needs_a_connected_number():
    r = client.post("/api/integrations/whatsapp/link", headers=ADMIN_A, json={"phone": "+44 7700 900123"})
    assert r.status_code == 409


def test_unlinked_sender_is_told_how_to_link(fresh):
    connect_number()
    hook(wa_payload("when is security training due?"))
    assert len(fresh) == 1 and "isn't linked" in fresh[0][2]


def test_link_then_ask_with_sources_history_and_insights(fresh):
    connect_number()
    link_phone(fresh)
    assert "Linked to" in fresh[-1][2]
    me = client.get("/api/integrations/whatsapp/link", headers=ADMIN_A).json()
    assert me["linked"] and me["phone"] == "•••• 0123"

    hook(wa_payload("when is security training due?"))
    pnid, to, text = fresh[-1]
    assert (pnid, to) == (PNID_A, PHONE)
    assert "Employee Handbook, p. 12" in text
    assert len(main.whatsapp_store.history(PHONE)) == 2
    q = main.insights_store.channel_queries("tenant-a", "whatsapp")
    assert q and q[0]["question"] == "when is security training due?"


def test_code_only_works_from_the_number_entered(fresh):
    connect_number()
    code = client.post("/api/integrations/whatsapp/link", headers=ADMIN_A, json={"phone": "+44 7700 900999"}).json()["code"]
    hook(wa_payload(f"link {code}"))           # sent from PHONE, not ...999
    assert "didn't work" in fresh[-1][2]
    assert main.whatsapp_store.get_link(PHONE) is None


def test_retried_message_is_answered_once(fresh):
    connect_number()
    link_phone(fresh)
    before = len(fresh)
    hook(wa_payload("docs", mid="wamid.same"))
    hook(wa_payload("docs", mid="wamid.same"))
    assert len(fresh) == before + 1 and "Employee Handbook" in fresh[-1][2]


def test_link_from_another_workspace_does_not_carry_over(fresh):
    connect_number()
    connect_number(headers=ADMIN_B, pnid=PNID_B)
    link_phone(fresh)                                   # linked to tenant-a
    hook(wa_payload("when is security training due?", pnid=PNID_B))
    assert "isn't linked" in fresh[-1][2]


def test_unlink_command(fresh):
    connect_number()
    link_phone(fresh)
    hook(wa_payload("unlink"))
    assert main.whatsapp_store.get_link(PHONE) is None
    assert client.get("/api/integrations/whatsapp/link", headers=ADMIN_A).json()["linked"] is False


def test_whatsapp_turns_math_into_plain_text():
    assert wa.to_whatsapp("For every FD $A \\rightarrow B$, **A** is a super key.") == "For every FD A → B, *A* is a super key."

def test_whatsapp_leaves_money_alone():
    assert wa.to_whatsapp("Crowns cost $450 and cleaning $80.") == "Crowns cost $450 and cleaning $80."
    assert wa.to_whatsapp(r"Growth is $\frac{a}{b}$ yearly.") == "Growth is (a)/(b) yearly."