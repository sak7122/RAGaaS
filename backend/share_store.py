from __future__ import annotations

import logging
import os
import secrets
from datetime import datetime, timezone
from typing import Protocol

log = logging.getLogger("ragaas")


class ShareStore(Protocol):
    def create(self, data: dict) -> str: ...
    def get(self, share_id: str) -> dict | None: ...


class MemoryShareStore:
    def __init__(self) -> None:
        self._store: dict[str, dict] = {}

    def create(self, data: dict) -> str:
        share_id = secrets.token_urlsafe(8)
        self._store[share_id] = {**data, "created_at": datetime.now(timezone.utc).isoformat()}
        return share_id

    def get(self, share_id: str) -> dict | None:
        return self._store.get(share_id)


class FirestoreShareStore:
    def __init__(self, db) -> None:
        self._db = db

    def create(self, data: dict) -> str:
        share_id = secrets.token_urlsafe(8)
        self._db.collection("shares").document(share_id).set({
            **data,
            "created_at": datetime.now(timezone.utc),
        })
        return share_id

    def get(self, share_id: str) -> dict | None:
        doc = self._db.collection("shares").document(share_id).get()
        if not doc.exists:
            return None
        d = doc.to_dict() or {}
        ts = d.get("created_at")
        if hasattr(ts, "isoformat"):
            d["created_at"] = ts.isoformat()
        return d


def create_share_store(env: str) -> ShareStore:
    if os.getenv("RAGAAS_USE_MEMORY_STORE") == "1":
        return MemoryShareStore()
    if env == "production":
        try:
            from firebase_admin import firestore as fa_firestore
            return FirestoreShareStore(fa_firestore.client())
        except Exception as exc:
            log.warning("Firestore share init failed (%s); using memory", exc)
    return MemoryShareStore()
