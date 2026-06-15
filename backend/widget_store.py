from __future__ import annotations

import logging
import os
import secrets
from datetime import datetime, timezone
from typing import Protocol

log = logging.getLogger("ragaas")

KEY_PREFIX = "wk_"


class WidgetKeyStore(Protocol):
    def create_key(self, tenant_id: str, label: str) -> dict: ...
    def list_keys(self, tenant_id: str) -> list[dict]: ...
    def delete_key(self, tenant_id: str, key_id: str) -> bool: ...
    def resolve_tenant(self, raw_key: str) -> str | None: ...


class MemoryWidgetKeyStore:
    def __init__(self) -> None:
        self._keys: dict[str, dict] = {}  # key_id → entry

    def create_key(self, tenant_id: str, label: str) -> dict:
        key_id = secrets.token_urlsafe(8)
        raw_key = KEY_PREFIX + secrets.token_urlsafe(24)
        now = datetime.now(timezone.utc).isoformat()
        self._keys[key_id] = {
            "key_id": key_id, "key": raw_key,
            "tenant_id": tenant_id, "label": label, "created_at": now,
        }
        return self._keys[key_id].copy()

    def list_keys(self, tenant_id: str) -> list[dict]:
        return [
            {k: v for k, v in e.items() if k != "key"}
            for e in self._keys.values()
            if e["tenant_id"] == tenant_id
        ]

    def delete_key(self, tenant_id: str, key_id: str) -> bool:
        e = self._keys.get(key_id)
        if not e or e["tenant_id"] != tenant_id:
            return False
        del self._keys[key_id]
        return True

    def resolve_tenant(self, raw_key: str) -> str | None:
        for e in self._keys.values():
            if e["key"] == raw_key:
                return e["tenant_id"]
        return None


class FirestoreWidgetKeyStore:
    def __init__(self, db) -> None:
        self._db = db

    def _col(self, tenant_id: str):
        return self._db.collection("tenants").document(tenant_id).collection("widget_keys")

    def create_key(self, tenant_id: str, label: str) -> dict:
        key_id = secrets.token_urlsafe(8)
        raw_key = KEY_PREFIX + secrets.token_urlsafe(24)
        now = datetime.now(timezone.utc)
        self._col(tenant_id).document(key_id).set({
            "key": raw_key, "tenant_id": tenant_id,
            "label": label, "created_at": now,
        })
        return {"key_id": key_id, "key": raw_key, "tenant_id": tenant_id,
                "label": label, "created_at": now.isoformat()}

    def list_keys(self, tenant_id: str) -> list[dict]:
        results = []
        for doc in self._col(tenant_id).stream():
            d = doc.to_dict() or {}
            ts = d.get("created_at")
            results.append({
                "key_id": doc.id, "label": d.get("label", ""),
                "created_at": ts.isoformat() if hasattr(ts, "isoformat") else (ts or ""),
                "tenant_id": tenant_id,
            })
        return results

    def delete_key(self, tenant_id: str, key_id: str) -> bool:
        ref = self._col(tenant_id).document(key_id)
        if not ref.get().exists:
            return False
        ref.delete()
        return True

    def resolve_tenant(self, raw_key: str) -> str | None:
        try:
            q = self._db.collection_group("widget_keys").where("key", "==", raw_key).limit(1)
            for doc in q.stream():
                return (doc.to_dict() or {}).get("tenant_id")
        except Exception:
            pass
        return None


def create_widget_key_store(env: str) -> WidgetKeyStore:
    if os.getenv("RAGAAS_USE_MEMORY_STORE") == "1":
        return MemoryWidgetKeyStore()
    if env == "production":
        try:
            from firebase_admin import firestore as fa_firestore
            return FirestoreWidgetKeyStore(fa_firestore.client())
        except Exception as exc:
            log.warning("Firestore widget_key init failed (%s); using memory", exc)
    return MemoryWidgetKeyStore()
