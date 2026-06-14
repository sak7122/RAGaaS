from __future__ import annotations

import logging
import os
import threading
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Protocol

log = logging.getLogger("ragaas")

import firebase_admin
from fastapi import HTTPException
from firebase_admin import auth, credentials, firestore

QUERY_LIMIT = 1000
TENANT_EMAIL_MAP = {
    "demo@ragaas.local": "tenant-demo",
    "tenant-a@ragaas.local": "tenant-a",
    "tenant-b@ragaas.local": "tenant-b",
}


# ── Principal ─────────────────────────────────────────────────────────────────
@dataclass(frozen=True)
class Principal:
    uid: str
    tenant_id: str
    email: str | None = None
    role: str = "admin"  # admin | uploader | viewer


# ── Usage Store ───────────────────────────────────────────────────────────────
class UsageStore(Protocol):
    def get_count(self, tenant_id: str) -> int: ...
    def increment_or_reject(self, tenant_id: str) -> int: ...
    def reset(self) -> None: ...
    def reset_tenant(self, tenant_id: str) -> None: ...


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

    def reset_tenant(self, tenant_id: str) -> None:
        with self._lock:
            self.counts.pop(tenant_id, None)


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

    def reset_tenant(self, tenant_id: str) -> None:
        day = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        self.client.collection("tenant_usage").document(f"{tenant_id}_{day}").delete()


# ── Member Store ──────────────────────────────────────────────────────────────
@dataclass
class MemberRecord:
    uid: str
    email: str
    role: str  # admin | uploader | viewer
    invited_at: str
    joined_at: str | None = None


class MemberStore(Protocol):
    def get_members(self, tenant_id: str) -> list[MemberRecord]: ...
    def add_member(self, tenant_id: str, member: MemberRecord) -> None: ...
    def update_role(self, tenant_id: str, uid: str, role: str) -> None: ...
    def remove_member(self, tenant_id: str, uid: str) -> None: ...
    def get_role(self, tenant_id: str, uid: str) -> str | None: ...
    def delete_tenant(self, tenant_id: str) -> None: ...


class MemoryMemberStore:
    def __init__(self) -> None:
        now = datetime.now(timezone.utc).isoformat()
        # Seed dev tenants with mock members so the UI has data to show
        self._store: dict[str, list[MemberRecord]] = {
            "tenant-demo": [
                MemberRecord("dev-tenant-demo", "demo@ragaas.local", "admin", now, now),
                MemberRecord("dev-uploader-demo", "uploader@ragaas.local", "uploader", now, now),
                MemberRecord("dev-viewer-demo", "viewer@ragaas.local", "viewer", now, None),
            ],
            "tenant-a": [
                MemberRecord("dev-tenant-a", "tenant-a@ragaas.local", "admin", now, now),
            ],
            "tenant-b": [
                MemberRecord("dev-tenant-b", "tenant-b@ragaas.local", "admin", now, now),
            ],
        }

    def get_members(self, tenant_id: str) -> list[MemberRecord]:
        return list(self._store.get(tenant_id, []))

    def add_member(self, tenant_id: str, member: MemberRecord) -> None:
        members = self._store.setdefault(tenant_id, [])
        # Replace if uid already exists
        self._store[tenant_id] = [m for m in members if m.uid != member.uid]
        self._store[tenant_id].append(member)

    def update_role(self, tenant_id: str, uid: str, role: str) -> None:
        for m in self._store.get(tenant_id, []):
            if m.uid == uid:
                m.role = role
                return

    def remove_member(self, tenant_id: str, uid: str) -> None:
        if tenant_id in self._store:
            self._store[tenant_id] = [m for m in self._store[tenant_id] if m.uid != uid]

    def get_role(self, tenant_id: str, uid: str) -> str | None:
        for m in self._store.get(tenant_id, []):
            if m.uid == uid:
                return m.role
        return None

    def delete_tenant(self, tenant_id: str) -> None:
        self._store.pop(tenant_id, None)


class FirestoreMemberStore:
    def __init__(self) -> None:
        self.client = firestore.client()

    def _col(self, tenant_id: str):
        return self.client.collection("tenants").document(tenant_id).collection("members")

    def get_members(self, tenant_id: str) -> list[MemberRecord]:
        results = []
        for doc in self._col(tenant_id).stream():
            d = doc.to_dict() or {}
            results.append(MemberRecord(
                uid=doc.id,
                email=d.get("email", ""),
                role=d.get("role", "viewer"),
                invited_at=d.get("invited_at", ""),
                joined_at=d.get("joined_at"),
            ))
        return results

    def add_member(self, tenant_id: str, member: MemberRecord) -> None:
        self._col(tenant_id).document(member.uid).set({
            "email": member.email,
            "role": member.role,
            "invited_at": member.invited_at,
            "joined_at": member.joined_at,
        })

    def update_role(self, tenant_id: str, uid: str, role: str) -> None:
        self._col(tenant_id).document(uid).update({"role": role})

    def remove_member(self, tenant_id: str, uid: str) -> None:
        self._col(tenant_id).document(uid).delete()

    def get_role(self, tenant_id: str, uid: str) -> str | None:
        snap = self._col(tenant_id).document(uid).get()
        if snap.exists:
            return (snap.to_dict() or {}).get("role")
        return None

    def delete_tenant(self, tenant_id: str) -> None:
        for doc in self._col(tenant_id).stream():
            doc.reference.delete()
        self.client.collection("tenants").document(tenant_id).delete()


# ── Factories ─────────────────────────────────────────────────────────────────
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
    except Exception:
        return MemoryUsageStore()


def create_member_store() -> MemberStore:
    if os.getenv("RAGAAS_USE_MEMORY_STORE") == "1":
        return MemoryMemberStore()
    try:
        init_firebase()
        return FirestoreMemberStore()
    except Exception:
        return MemoryMemberStore()


# ── Token verification ────────────────────────────────────────────────────────
def tenant_from_claims(decoded: dict) -> str:
    # Explicit tenant claim (set by an admin when joining a team) wins.
    tenant_id = decoded.get("tenant_id")
    if isinstance(tenant_id, str) and tenant_id:
        return tenant_id
    # Known seeded emails (dev/demo accounts).
    email = decoded.get("email")
    if isinstance(email, str) and email in TENANT_EMAIL_MAP:
        return TENANT_EMAIL_MAP[email]
    if os.getenv("RAGAAS_ENV", "development") == "development":
        return "tenant-demo"
    # Self-serve: every new account gets its OWN isolated workspace keyed by uid.
    # Tenant isolation holds (each user sees only their workspace); an admin can
    # later assign a shared tenant_id custom claim to merge users into a team.
    uid = str(decoded.get("uid") or decoded.get("sub") or "")
    if uid:
        return f"ws-{uid[:24]}"
    raise HTTPException(status_code=403, detail="Invalid token: no user id")


def verify_firebase_token(id_token: str, member_store: MemberStore | None = None) -> Principal:
    try:
        init_firebase()
        decoded = auth.verify_id_token(id_token)
    except Exception as exc:
        raise HTTPException(status_code=403, detail="Invalid Firebase ID token") from exc
    uid = str(decoded.get("uid") or decoded.get("sub") or "")
    if not uid:
        raise HTTPException(status_code=403, detail="Invalid Firebase ID token")
    email = decoded.get("email") if isinstance(decoded.get("email"), str) else None
    tenant_id = tenant_from_claims(decoded)

    # Look up role from member store; default to viewer for unknown users
    role = "viewer"
    if member_store is not None:
        stored_role = member_store.get_role(tenant_id, uid)
        if stored_role:
            role = stored_role
        else:
            # First time: auto-add as admin (first user bootstraps themselves)
            role = "admin"

    return Principal(uid=uid, email=email, tenant_id=tenant_id, role=role)
