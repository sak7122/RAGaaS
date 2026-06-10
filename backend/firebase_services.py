from __future__ import annotations

import logging
import os
import threading
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Protocol

import firebase_admin
from fastapi import HTTPException
from firebase_admin import auth, credentials, firestore

log = logging.getLogger("ragaas")

QUERY_LIMIT = 1000
TENANT_EMAIL_MAP = {
    "demo@ragaas.local": "tenant-demo",
    "tenant-a@ragaas.local": "tenant-a",
    "tenant-b@ragaas.local": "tenant-b",
}


@dataclass(frozen=True)
class Principal:
    uid: str
    tenant_id: str
    email: str | None = None


class UsageStore(Protocol):
    def get_count(self, tenant_id: str) -> int: ...
    def increment_or_reject(self, tenant_id: str) -> int: ...
    def reset(self) -> None: ...


class MemoryUsageStore:
    def __init__(self) -> None:
        self.counts: dict[str, int] = {}
        self._lock = threading.Lock()

    def get_count(self, tenant_id: str) -> int:
        with self._lock:
            return self.counts.get(tenant_id, 0)

    def increment_or_reject(self, tenant_id: str) -> int:
        with self._lock:
            current = self.counts.get(tenant_id, 0)
            if current >= QUERY_LIMIT:
                raise HTTPException(status_code=429, detail="Tenant query quota exceeded")
            self.counts[tenant_id] = current + 1
            return self.counts[tenant_id]

    def reset(self) -> None:
        with self._lock:
            self.counts.clear()


class FirestoreUsageStore:
    def __init__(self) -> None:
        self.client = firestore.client()

    def _doc(self, tenant_id: str):
        day = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        return self.client.collection("tenant_usage").document(f"{tenant_id}_{day}")

    def get_count(self, tenant_id: str) -> int:
        snap = self._doc(tenant_id).get()
        return int((snap.to_dict() or {}).get("queries", 0)) if snap.exists else 0

    def increment_or_reject(self, tenant_id: str) -> int:
        doc = self._doc(tenant_id)
        tx = self.client.transaction()

        @firestore.transactional
        def bump(transaction):
            snap = doc.get(transaction=transaction)
            current = int((snap.to_dict() or {}).get("queries", 0)) if snap.exists else 0
            if current >= QUERY_LIMIT:
                raise HTTPException(status_code=429, detail="Tenant query quota exceeded")
            next_count = current + 1
            transaction.set(
                doc,
                {
                    "tenant_id": tenant_id,
                    "queries": next_count,
                    "query_limit": QUERY_LIMIT,
                    "updated_at": datetime.now(timezone.utc),
                },
                merge=True,
            )
            return next_count

        return bump(tx)

    def reset(self) -> None:
        for doc in self.client.collection("tenant_usage").stream():
            doc.reference.delete()


def init_firebase() -> None:
    if firebase_admin._apps:
        return
    project_id = os.getenv("FIREBASE_PROJECT_ID", "ragaas-local")
    if os.getenv("FIREBASE_AUTH_EMULATOR_HOST") or os.getenv("FIRESTORE_EMULATOR_HOST"):
        firebase_admin.initialize_app(options={"projectId": project_id})
    else:
        firebase_admin.initialize_app(credentials.ApplicationDefault(), {"projectId": project_id})


def create_usage_store() -> UsageStore:
    if os.getenv("RAGAAS_USE_MEMORY_STORE") == "1":
        return MemoryUsageStore()
    try:
        init_firebase()
        return FirestoreUsageStore()
    except Exception as exc:
        log.warning("Firebase unavailable (%s: %s), falling back to MemoryUsageStore — quota will not persist across restarts", type(exc).__name__, exc)
        return MemoryUsageStore()


def tenant_from_claims(decoded: dict) -> str:
    tenant_id = decoded.get("tenant_id")
    if isinstance(tenant_id, str) and tenant_id:
        return tenant_id
    email = decoded.get("email")
    if isinstance(email, str) and email in TENANT_EMAIL_MAP:
        return TENANT_EMAIL_MAP[email]
    return "tenant-demo"


def verify_firebase_token(id_token: str) -> Principal:
    try:
        init_firebase()
        decoded = auth.verify_id_token(id_token)
    except Exception as exc:
        raise HTTPException(status_code=403, detail="Invalid Firebase ID token") from exc
    uid = str(decoded.get("uid") or decoded.get("sub") or "")
    if not uid:
        raise HTTPException(status_code=403, detail="Invalid Firebase ID token")
    email = decoded.get("email") if isinstance(decoded.get("email"), str) else None
    return Principal(uid=uid, email=email, tenant_id=tenant_from_claims(decoded))
