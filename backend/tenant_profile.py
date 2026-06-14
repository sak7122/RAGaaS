"""
Tenant profile — a human-friendly name for a workspace (tenant_id).

New self-serve workspaces get a uid-based id like `ws-abc123`. This store holds
the display name the user typed at signup ("Acme Corp") so the UI shows that
instead of the raw id. Per-tenant, set by an admin.

Dev  → MemoryTenantProfileStore
Prod → FirestoreTenantProfileStore (tenants/{tid}/profile/main)
"""
from __future__ import annotations

import logging
import os
import threading
from typing import Protocol

log = logging.getLogger("ragaas")


def prettify(tenant_id: str) -> str:
    """Fallback label when no name is set."""
    if tenant_id.startswith("ws-"):
        return "My Workspace"
    return tenant_id.replace("-", " ").replace("_", " ").title()


class TenantProfileStore(Protocol):
    def get_name(self, tenant_id: str) -> str | None: ...
    def set_name(self, tenant_id: str, name: str) -> None: ...
    def delete_tenant(self, tenant_id: str) -> None: ...


class MemoryTenantProfileStore:
    def __init__(self) -> None:
        self._names: dict[str, str] = {
            "tenant-demo": "Demo Workspace",
            "tenant-a": "Tenant A",
            "tenant-b": "Tenant B",
        }
        self._lock = threading.Lock()

    def get_name(self, tenant_id: str) -> str | None:
        with self._lock:
            return self._names.get(tenant_id)

    def set_name(self, tenant_id: str, name: str) -> None:
        with self._lock:
            self._names[tenant_id] = name

    def delete_tenant(self, tenant_id: str) -> None:
        with self._lock:
            self._names.pop(tenant_id, None)


class FirestoreTenantProfileStore:
    def __init__(self, db) -> None:
        self._db = db

    def _doc(self, tenant_id: str):
        return self._db.collection("tenants").document(tenant_id).collection("profile").document("main")

    def get_name(self, tenant_id: str) -> str | None:
        snap = self._doc(tenant_id).get()
        return (snap.to_dict() or {}).get("name") if snap.exists else None

    def set_name(self, tenant_id: str, name: str) -> None:
        self._doc(tenant_id).set({"name": name}, merge=True)

    def delete_tenant(self, tenant_id: str) -> None:
        self._doc(tenant_id).delete()


def create_tenant_profile_store(env: str) -> TenantProfileStore:
    if os.getenv("RAGAAS_USE_MEMORY_STORE") == "1":
        return MemoryTenantProfileStore()
    if env == "production":
        try:
            from firebase_admin import firestore as fa_firestore
            return FirestoreTenantProfileStore(fa_firestore.client())
        except Exception as exc:
            log.warning("Firestore tenant-profile init failed (%s); using memory", exc)
    return MemoryTenantProfileStore()
