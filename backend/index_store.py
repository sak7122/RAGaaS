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
    # Returns candidate chunks ranked by vector similarity:
    #   [{file_name, page, chunk_index, text, vec_score}, ...]
    def vector_search(self, tenant_id: str, query_vector: list[float], k: int) -> list[dict]: ...


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

    def vector_search(self, tenant_id: str, query_vector: list[float], k: int) -> list[dict]:
        from backend.rag import cosine
        out: list[dict] = []
        for d in self.list_docs(tenant_id):
            for ch in d.get("chunks", []):
                emb = ch.get("embedding")
                if not emb:
                    continue
                out.append({
                    "file_name": d["file_name"],
                    "page": ch.get("page", 1),
                    "chunk_index": ch.get("chunk_index", 0),
                    "text": ch.get("text", ""),
                    "vec_score": cosine(query_vector, emb),
                })
        out.sort(key=lambda c: c["vec_score"], reverse=True)
        return out[:k]


# ── Prod: Firestore ───────────────────────────────────────────────────────────

class FirestoreIndexStore:
    """
    Collection path: tenants/{tenant_id}/documents/{file_name}
    """

    def __init__(self, db) -> None:  # db: google.cloud.firestore.Client
        self._db = db

    def _col(self, tenant_id: str):
        return self._db.collection("tenants").document(tenant_id).collection("documents")

    def _chunks(self, tenant_id: str):
        # Flat per-tenant chunk collection holding vectors for find_nearest.
        return self._db.collection("tenants").document(tenant_id).collection("chunks")

    @staticmethod
    def _chunk_id(file_name: str, page: int, idx: int) -> str:
        safe = file_name.replace("/", "_")
        return f"{safe}::{page}::{idx}"

    def list_docs(self, tenant_id: str) -> list[dict]:
        docs = self._col(tenant_id).stream()
        return [d.to_dict() for d in docs if d.exists]

    def upsert_doc(self, tenant_id: str, doc: dict) -> None:
        from google.cloud.firestore_v1.vector import Vector

        file_name = doc["file_name"]
        # Store the doc WITHOUT per-chunk embeddings (keeps it under the 1 MB
        # Firestore doc limit); embeddings live in the chunks subcollection.
        light = {**doc, "chunks": [
            {k: ch[k] for k in ("page", "chunk_index", "text") if k in ch}
            for ch in doc.get("chunks", [])
        ]}
        self._col(tenant_id).document(file_name).set(light)

        # Replace this file's chunk vectors
        self._delete_chunks_for_file(tenant_id, file_name)
        batch = self._db.batch()
        for ch in doc.get("chunks", []):
            emb = ch.get("embedding")
            if not emb:
                continue
            cid = self._chunk_id(file_name, ch.get("page", 1), ch.get("chunk_index", 0))
            batch.set(self._chunks(tenant_id).document(cid), {
                "file_name": file_name,
                "page": ch.get("page", 1),
                "chunk_index": ch.get("chunk_index", 0),
                "text": ch.get("text", ""),
                "embedding": Vector(emb),
            })
        batch.commit()

    def _delete_chunks_for_file(self, tenant_id: str, file_name: str) -> None:
        q = self._chunks(tenant_id).where("file_name", "==", file_name)
        for d in q.stream():
            d.reference.delete()

    def delete_doc(self, tenant_id: str, file_name: str) -> bool:
        ref = self._col(tenant_id).document(file_name)
        snap = ref.get()
        if not snap.exists:
            return False
        ref.delete()
        self._delete_chunks_for_file(tenant_id, file_name)
        return True

    def delete_tenant(self, tenant_id: str) -> int:
        col = self._col(tenant_id)
        docs = list(col.stream())
        for d in docs:
            d.reference.delete()
        for c in self._chunks(tenant_id).stream():
            c.reference.delete()
        return len(docs)

    def vector_search(self, tenant_id: str, query_vector: list[float], k: int) -> list[dict]:
        from google.cloud.firestore_v1.base_vector_query import DistanceMeasure
        from google.cloud.firestore_v1.vector import Vector

        snaps = self._chunks(tenant_id).find_nearest(
            vector_field="embedding",
            query_vector=Vector(query_vector),
            distance_measure=DistanceMeasure.COSINE,
            limit=k,
            distance_result_field="_distance",
        ).stream()

        out: list[dict] = []
        for s in snaps:
            d = s.to_dict() or {}
            dist = float(d.get("_distance", 1.0))
            out.append({
                "file_name": d.get("file_name", ""),
                "page": d.get("page", 1),
                "chunk_index": d.get("chunk_index", 0),
                "text": d.get("text", ""),
                "vec_score": max(0.0, 1.0 - dist),  # cosine distance -> similarity
            })
        return out


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
