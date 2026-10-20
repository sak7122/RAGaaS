"""Plans, monthly usage and Razorpay subscriptions.

Plans set monthly questions, documents, seats and which channels are included.
Limits are only enforced when BILLING_ENFORCED=1, so existing pilot workspaces keep
working while pricing is introduced; with it off every workspace is on "beta".

Razorpay (subscriptions, INR) env:
  RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET   API keys (Dashboard → Account & Settings → API keys)
  RAZORPAY_WEBHOOK_SECRET                secret set on the webhook (Dashboard → Webhooks)
  RAZORPAY_PLAN_STARTER, RAZORPAY_PLAN_TEAM   plan IDs created in Dashboard → Subscriptions → Plans
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import os
import threading
import urllib.request
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from typing import Protocol

log = logging.getLogger("ragaas")

RAZORPAY_API = "https://api.razorpay.com/v1"


@dataclass(frozen=True)
class Plan:
    id: str
    name: str
    price_inr: int | None          # per month; None = talk to us
    price_usd: int | None
    questions: int | None          # per month; None = no plan limit (daily breaker still applies)
    documents: int | None
    seats: int | None
    channels: bool                 # Slack, WhatsApp, website widget without badge
    academy: bool
    blurb: str


PLANS: dict[str, Plan] = {p.id: p for p in [
    Plan("free", "Free", 0, 0, 100, 10, 2, False, False,
         "Try it with your own documents."),
    Plan("starter", "Starter", 999, 15, 1000, 100, 5, False, False,
         "One small team asking questions every day."),
    Plan("team", "Team", 2999, 39, 5000, None, 20, True, False,
         "Answers in Slack, WhatsApp and on your website."),
    Plan("business", "Business", None, None, 20000, None, None, True, True,
         "Several sites, onboarding with Academy, priority support."),
]}
# Shown while billing isn't enforced: everything on, nothing charged.
BETA = Plan("beta", "Beta", 0, 0, None, None, None, True, True, "Free while RAGaaS is in pilot.")
PAID_SELF_SERVE = ("starter", "team")


def enforced() -> bool:
    return os.getenv("BILLING_ENFORCED", "") == "1"


def _env(name: str) -> str:
    return os.getenv(name, "").strip()


def razorpay_ready() -> bool:
    return bool(_env("RAZORPAY_KEY_ID") and _env("RAZORPAY_KEY_SECRET"))


def month_key(now: datetime | None = None) -> str:
    return (now or datetime.now(timezone.utc)).strftime("%Y-%m")


# ── Store ─────────────────────────────────────────────────────────────────────
class BillingStore(Protocol):
    def get(self, tenant_id: str) -> dict: ...
    def set_plan(self, tenant_id: str, plan: str, **fields) -> None: ...
    def find_by_subscription(self, subscription_id: str) -> str | None: ...
    def questions_this_month(self, tenant_id: str) -> int: ...
    def count_question(self, tenant_id: str) -> int: ...
    def reset(self) -> None: ...


class MemoryBillingStore:
    def __init__(self) -> None:
        self._acct: dict[str, dict] = {}
        self._usage: dict[tuple[str, str], int] = {}
        self._lock = threading.Lock()

    def get(self, tenant_id: str) -> dict:
        return dict(self._acct.get(tenant_id, {"plan": "free", "status": "none"}))

    def set_plan(self, tenant_id: str, plan: str, **fields) -> None:
        with self._lock:
            self._acct[tenant_id] = {**self._acct.get(tenant_id, {}), "plan": plan, **fields,
                                     "updated_at": datetime.now(timezone.utc).isoformat()}

    def find_by_subscription(self, subscription_id: str) -> str | None:
        return next((t for t, a in self._acct.items() if a.get("subscription_id") == subscription_id), None)

    def questions_this_month(self, tenant_id: str) -> int:
        return self._usage.get((tenant_id, month_key()), 0)

    def count_question(self, tenant_id: str) -> int:
        with self._lock:
            k = (tenant_id, month_key())
            self._usage[k] = self._usage.get(k, 0) + 1
            return self._usage[k]

    def reset(self) -> None:
        with self._lock:
            self._acct.clear()
            self._usage.clear()


class FirestoreBillingStore:
    def __init__(self, db) -> None:
        self._db = db

    def _doc(self, tenant_id: str):
        return self._db.collection("billing").document(tenant_id)

    def get(self, tenant_id: str) -> dict:
        snap = self._doc(tenant_id).get()
        d = (snap.to_dict() or {}) if snap.exists else {}
        return {"plan": d.get("plan", "free"), "status": d.get("status", "none"),
                **{k: v for k, v in d.items() if k not in ("plan", "status")}}

    def set_plan(self, tenant_id: str, plan: str, **fields) -> None:
        self._doc(tenant_id).set({"plan": plan, **fields, "updated_at": datetime.now(timezone.utc).isoformat()},
                                 merge=True)

    def find_by_subscription(self, subscription_id: str) -> str | None:
        for snap in self._db.collection("billing").where("subscription_id", "==", subscription_id).limit(1).stream():
            return snap.id
        return None

    def _usage(self, tenant_id: str):
        return self._doc(tenant_id).collection("usage").document(month_key())

    def questions_this_month(self, tenant_id: str) -> int:
        snap = self._usage(tenant_id).get()
        return int((snap.to_dict() or {}).get("questions", 0)) if snap.exists else 0

    def count_question(self, tenant_id: str) -> int:
        from google.cloud import firestore
        ref = self._usage(tenant_id)
        ref.set({"questions": firestore.Increment(1)}, merge=True)
        return self.questions_this_month(tenant_id)

    def reset(self) -> None:
        pass


def create_billing_store(env: str) -> BillingStore:
    if os.getenv("RAGAAS_USE_MEMORY_STORE") == "1":
        return MemoryBillingStore()
    if env == "production":
        try:
            from firebase_admin import firestore as fa_firestore
            return FirestoreBillingStore(fa_firestore.client())
        except Exception as exc:
            log.warning("Firestore billing init failed (%s); using memory", exc)
    return MemoryBillingStore()


# ── Plan resolution ──────────────────────────────────────────────────────────
ACTIVE = {"active", "authenticated", "comped"}


def current_plan(store: BillingStore, tenant_id: str) -> Plan:
    if not enforced():
        return BETA
    acct = store.get(tenant_id)
    plan = PLANS.get(acct.get("plan", "free"), PLANS["free"])
    if plan.id != "free" and acct.get("status") not in ACTIVE:
        return PLANS["free"]
    return plan


def plan_dict(p: Plan) -> dict:
    return asdict(p)


# ── Razorpay ──────────────────────────────────────────────────────────────────
def _razorpay(method: str, path: str, body: dict | None = None) -> dict:
    auth = base64.b64encode(f"{_env('RAZORPAY_KEY_ID')}:{_env('RAZORPAY_KEY_SECRET')}".encode()).decode()
    req = urllib.request.Request(
        f"{RAZORPAY_API}{path}", method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Authorization": f"Basic {auth}", "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read() or b"{}")


def create_subscription(plan_id: str, tenant_id: str, email: str | None) -> dict:
    """A Razorpay subscription the customer then authorises in Razorpay Checkout."""
    rp_plan = _env(f"RAZORPAY_PLAN_{plan_id.upper()}")
    if not rp_plan:
        raise ValueError(f"RAZORPAY_PLAN_{plan_id.upper()} is not set")
    return _razorpay("POST", "/subscriptions", {
        "plan_id": rp_plan, "total_count": 120, "customer_notify": 1, "quantity": 1,
        "notes": {"tenant_id": tenant_id, "plan": plan_id, "email": email or ""},
    })


def cancel_subscription(subscription_id: str) -> dict:
    return _razorpay("POST", f"/subscriptions/{subscription_id}/cancel", {"cancel_at_cycle_end": 1})


def checkout_signature_ok(payment_id: str, subscription_id: str, signature: str) -> bool:
    """Checkout success handler signature: HMAC-SHA256(key secret, payment_id|subscription_id)."""
    secret = _env("RAZORPAY_KEY_SECRET")
    if not secret or not signature:
        return False
    expected = hmac.new(secret.encode(), f"{payment_id}|{subscription_id}".encode(), hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature)


def webhook_signature_ok(body: bytes, signature: str | None) -> bool:
    secret = _env("RAZORPAY_WEBHOOK_SECRET")
    if not secret or not signature:
        return False
    expected = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature)


# Razorpay subscription events → our status.
EVENT_STATUS = {
    "subscription.authenticated": "authenticated",
    "subscription.activated": "active",
    "subscription.charged": "active",
    "subscription.resumed": "active",
    "subscription.pending": "past_due",
    "subscription.halted": "halted",
    "subscription.paused": "paused",
    "subscription.cancelled": "cancelled",
    "subscription.completed": "completed",
}
