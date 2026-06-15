from __future__ import annotations

import logging
import os
from datetime import datetime, timezone
from typing import Protocol

log = logging.getLogger("ragaas")


class SlackStore(Protocol):
    def connect(self, team_id: str, team_name: str, tenant_id: str) -> None: ...
    def get_tenant(self, team_id: str) -> str | None: ...
    def list_connections(self, tenant_id: str) -> list[dict]: ...
    def disconnect(self, team_id: str, tenant_id: str) -> bool: ...


class MemorySlackStore:
    def __init__(self) -> None:
        self._ws: dict[str, dict] = {}

    def connect(self, team_id: str, team_name: str, tenant_id: str) -> None:
        self._ws[team_id] = {
            "team_id": team_id, "team_name": team_name,
            "tenant_id": tenant_id,
            "connected_at": datetime.now(timezone.utc).isoformat(),
        }

    def get_tenant(self, team_id: str) -> str | None:
        ws = self._ws.get(team_id)
        return ws["tenant_id"] if ws else None

    def list_connections(self, tenant_id: str) -> list[dict]:
        return [ws for ws in self._ws.values() if ws["tenant_id"] == tenant_id]

    def disconnect(self, team_id: str, tenant_id: str) -> bool:
        ws = self._ws.get(team_id)
        if not ws or ws["tenant_id"] != tenant_id:
            return False
        del self._ws[team_id]
        return True


class FirestoreSlackStore:
    def __init__(self, db) -> None:
        self._db = db

    def connect(self, team_id: str, team_name: str, tenant_id: str) -> None:
        self._db.collection("slack_workspaces").document(team_id).set({
            "team_name": team_name, "tenant_id": tenant_id,
            "connected_at": datetime.now(timezone.utc),
        })

    def get_tenant(self, team_id: str) -> str | None:
        doc = self._db.collection("slack_workspaces").document(team_id).get()
        return (doc.to_dict() or {}).get("tenant_id") if doc.exists else None

    def list_connections(self, tenant_id: str) -> list[dict]:
        q = self._db.collection("slack_workspaces").where("tenant_id", "==", tenant_id)
        results = []
        for doc in q.stream():
            d = doc.to_dict() or {}
            ts = d.get("connected_at")
            results.append({
                "team_id": doc.id, "team_name": d.get("team_name", ""),
                "connected_at": ts.isoformat() if hasattr(ts, "isoformat") else (ts or ""),
            })
        return results

    def disconnect(self, team_id: str, tenant_id: str) -> bool:
        ref = self._db.collection("slack_workspaces").document(team_id)
        snap = ref.get()
        if not snap.exists or (snap.to_dict() or {}).get("tenant_id") != tenant_id:
            return False
        ref.delete()
        return True


def create_slack_store(env: str) -> SlackStore:
    if os.getenv("RAGAAS_USE_MEMORY_STORE") == "1":
        return MemorySlackStore()
    if env == "production":
        try:
            from firebase_admin import firestore as fa_firestore
            return FirestoreSlackStore(fa_firestore.client())
        except Exception as exc:
            log.warning("Firestore slack init failed (%s); using memory", exc)
    return MemorySlackStore()
