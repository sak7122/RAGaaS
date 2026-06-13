"""
Index backends for chunk metadata (tenant docs + their text chunks).
Dev  → LocalIndexStore    (local_data/index.json)
Prod → FirestoreIndexStore (tenants/{tenantId}/documents/{fileName})

Firestore document shape:
  { tenant_id, file_name, chunks: [{page, chunk_index, text}], uploaded_at, gcs_uri }
"""
from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Protocol, runtime_checkable

log = logging.getLogger("ragaas")


@runtime_checkable
class IndexBackend(Protocol):
    def list_docs(self, tenant_id: str) -> list[dict]: ...
    def upsert_doc(self, tenant_id: str, doc: dict) -> None: ...
    def delete_doc(self, tenant_id: str, file_name: str) -> bool: ...
    def delete_tenant(self, tenant_id: str) -> int: ...


# ── Dev: JSON file ────────────────────────────────────────────────────────────

class LocalIndexStore:
    def __init__(self, index_file: Path) -> None:
        self._file = index_file

    def _load(self) -> dict:
        if not self._file.exists():
            return {"documents": []}
        return json.loads(self._file.read_text(encoding="utf-8"))

    def _save(self, data: dict) -> None:
        self._file.parent.mkdir(parents=True, exist_ok=True)
        self._file.write_text(json.dumps(data, indent=2), encoding="utf-8")

    def list_docs(self, tenant_id: str) -> list[dict]:
        return [d for d in self._load()["documents"] if d["tenant_id"] == tenant_id]

    def upsert_doc(self, tenant_id: str, doc: dict) -> None:
        data = self._load()
        data["documents"] = [
            d for d in data["documents"]
            if not (d["tenant_id"] == tenant_id and d["file_name"] == doc["file_name"])
        ]
        data["documents"].append(doc)
        self._save(data)

    def delete_doc(self, tenant_id: str, file_name: str) -> bool:
        data = self._load()
        before = len(data["documents"])
        data["documents"] = [
            d for d in data["documents"]
            if not (d["tenant_id"] == tenant_id and d["file_name"] == file_name)
        ]
        if len(data["documents"]) == before:
            return False
        self._save(data)
        return True

    def delete_tenant(self, tenant_id: str) -> int:
        data = self._load()
        before = len(data["documents"])
        data["documents"] = [d for d in data["documents"] if d["tenant_id"] != tenant_id]
        removed = before - len(data["documents"])
        self._save(data)
        return removed


# ── Prod: Firestore ───────────────────────────────────────────────────────────

class FirestoreIndexStore:
    """
    Collection path: tenants/{tenant_id}/documents/{file_name}
    """

    def __init__(self, db) -> None:  # db: google.cloud.firestore.Client
        self._db = db

    def _col(self, tenant_id: str):
        return self._db.collection("tenants").document(tenant_id).collection("documents")

    def list_docs(self, tenant_id: str) -> list[dict]:
        docs = self._col(tenant_id).stream()
        return [d.to_dict() for d in docs if d.exists]

    def upsert_doc(self, tenant_id: str, doc: dict) -> None:
        ref = self._col(tenant_id).document(doc["file_name"])
        ref.set(doc)

    def delete_doc(self, tenant_id: str, file_name: str) -> bool:
        ref = self._col(tenant_id).document(file_name)
        snap = ref.get()
        if not snap.exists:
            return False
        ref.delete()
        return True

    def delete_tenant(self, tenant_id: str) -> int:
        col = self._col(tenant_id)
        docs = list(col.stream())
        for d in docs:
            d.reference.delete()
        return len(docs)


# ── Factory ───────────────────────────────────────────────────────────────────

def create_index_store(env: str, index_file: Path) -> IndexBackend:
    if env == "production":
        try:
            import firebase_admin
            from firebase_admin import firestore as fa_firestore
            db = fa_firestore.client()
            log.info("index_store=Firestore")
            return FirestoreIndexStore(db)
        except Exception as exc:
            log.error("Firestore index store init failed: %s", exc)
            raise
    log.info("index_store=local file=%s", index_file)
    return LocalIndexStore(index_file)
