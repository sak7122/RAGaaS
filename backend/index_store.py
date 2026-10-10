"""
Index backends for chunk metadata (tenant docs + their text chunks).
Dev  → LocalIndexStore    (local_data/index.json)
Prod → FirestoreIndexStore (tenants/{tenantId}/documents/{fileName})

Firestore shape:
  tenants/{tid}/documents/{file}  { tenant_id, file_name, chunk_count, uploaded_at, storage_uri }
  tenants/{tid}/chunks/{file::page::idx}  { file_name, page, chunk_index, text, embedding? }
Chunk text lives only in the chunks collection, so a document's size is not
bounded by Firestore's 1 MB per-document limit. Documents written before that
change still carry an inline `chunks` list; readers handle both shapes.
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
    # Every chunk's text for keyword fallback: [{file_name, page, chunk_index, text}, ...]
    def list_chunks(self, tenant_id: str) -> list[dict]: ...
    # The first `limit` chunks of one document (by page, then chunk index), for profiles.
    def doc_chunks(self, tenant_id: str, file_name: str, limit: int) -> list[dict]: ...
    # Merge fields into a document's metadata (never its chunks). False if no such document.
    def update_doc_meta(self, tenant_id: str, file_name: str, fields: dict) -> bool: ...
    # Returns candidate chunks ranked by vector similarity:
    #   [{file_name, page, chunk_index, text, vec_score}, ...]
    def vector_search(self, tenant_id: str, query_vector: list[float], k: int) -> list[dict]: ...


def chunk_count(doc: dict) -> int:
    if "chunk_count" in doc:
        return int(doc["chunk_count"])
    return len(doc.get("chunks") or doc.get("pages", []))


def _inline_chunks(doc: dict) -> list[dict]:
    chunks = doc.get("chunks") or [
        {"page": i + 1, "chunk_index": 0, "text": p} for i, p in enumerate(doc.get("pages", []))
    ]
    return [{"file_name": doc["file_name"], "page": ch.get("page", 1),
             "chunk_index": ch.get("chunk_index", 0), "text": ch.get("text", "")} for ch in chunks]


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

    def list_chunks(self, tenant_id: str) -> list[dict]:
        return [c for d in self.list_docs(tenant_id) for c in _inline_chunks(d)]

    def doc_chunks(self, tenant_id: str, file_name: str, limit: int) -> list[dict]:
        for d in self.list_docs(tenant_id):
            if d["file_name"] == file_name:
                chunks = sorted(_inline_chunks(d), key=lambda c: (c["page"], c["chunk_index"]))
                return chunks[:limit]
        return []

    def update_doc_meta(self, tenant_id: str, file_name: str, fields: dict) -> bool:
        data = self._load()
        for d in data["documents"]:
            if d["tenant_id"] == tenant_id and d["file_name"] == file_name:
                d.update({k: v for k, v in fields.items() if k not in ("chunks", "tenant_id", "file_name")})
                self._save(data)
                return True
        return False

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
        chunks = doc.get("chunks", [])
        # Metadata only: chunk text would hit Firestore's 1 MB document limit
        # for anything longer than a short book.
        meta = {k: v for k, v in doc.items() if k != "chunks"}
        meta["chunk_count"] = len(chunks)

        # Replace this file's chunks. Every chunk is stored (keyword fallback
        # needs the text); only embedded ones are reachable by find_nearest.
        self._delete_chunks_for_file(tenant_id, file_name)
        # BulkWriter sends writes in parallel (a long book is thousands of
        # chunks; serial 500-op batches would outlast the request timeout).
        writer = self._db.bulk_writer()
        for ch in chunks:
            cid = self._chunk_id(file_name, ch.get("page", 1), ch.get("chunk_index", 0))
            row = {
                "file_name": file_name,
                "page": ch.get("page", 1),
                "chunk_index": ch.get("chunk_index", 0),
                "text": ch.get("text", ""),
            }
            if ch.get("embedding"):
                row["embedding"] = Vector(ch["embedding"])
            writer.set(self._chunks(tenant_id).document(cid), row)
        writer.close()          # flushes and waits for every write
        # Written last: the document only appears in listings once its chunks exist.
        self._col(tenant_id).document(file_name).set(meta)

    def _delete_refs(self, refs) -> None:
        writer = self._db.bulk_writer()
        for ref in refs:
            writer.delete(ref)
        writer.close()

    def _delete_chunks_for_file(self, tenant_id: str, file_name: str) -> None:
        q = self._chunks(tenant_id).where("file_name", "==", file_name).select([])
        self._delete_refs(d.reference for d in q.stream())

    def list_chunks(self, tenant_id: str) -> list[dict]:
        rows = self._chunks(tenant_id).select(["file_name", "page", "chunk_index", "text"]).stream()
        out = [r.to_dict() for r in rows]
        stored = {c["file_name"] for c in out}
        for d in self.list_docs(tenant_id):        # legacy docs with inline chunks only
            if d.get("file_name") not in stored and d.get("chunks"):
                out.extend(_inline_chunks(d))
        return out

    def doc_chunks(self, tenant_id: str, file_name: str, limit: int) -> list[dict]:
        # Equality queries come back in document-id order ("file::page::idx"), so the
        # early pages arrive first; over-fetch a little and sort numerically.
        q = (self._chunks(tenant_id).where("file_name", "==", file_name)
             .select(["file_name", "page", "chunk_index", "text"]).limit(limit * 3))
        rows = [r.to_dict() for r in q.stream()]
        if not rows:  # legacy document with inline chunks only
            snap = self._col(tenant_id).document(file_name).get()
            rows = _inline_chunks(snap.to_dict()) if snap.exists and (snap.to_dict() or {}).get("chunks") else []
        rows.sort(key=lambda c: (int(c.get("page", 1)), int(c.get("chunk_index", 0))))
        return rows[:limit]

    def update_doc_meta(self, tenant_id: str, file_name: str, fields: dict) -> bool:
        ref = self._col(tenant_id).document(file_name)
        if not ref.get().exists:
            return False
        ref.set({k: v for k, v in fields.items() if k not in ("chunks", "tenant_id", "file_name")}, merge=True)
        return True

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
        docs = list(col.select([]).stream())
        self._delete_refs(d.reference for d in docs)
        self._delete_refs(c.reference for c in self._chunks(tenant_id).select([]).stream())
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
