"""Saved conversations: each member's chat threads, so history follows them across
devices instead of living in one browser's localStorage.

Dev  → MemoryConversationStore
Prod → FirestoreConversationStore (conversations/{id}, filtered by tenant + uid)
"""
from __future__ import annotations

import logging
import os
import threading
import uuid
from datetime import datetime, timezone
from typing import Protocol

log = logging.getLogger("ragaas")

MAX_MESSAGES = 200        # per conversation; oldest dropped beyond this
LIST_LIMIT = 50
TITLE_CHARS = 80


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _title(text: str) -> str:
    t = " ".join(text.split())
    return t if len(t) <= TITLE_CHARS else t[: TITLE_CHARS - 1].rsplit(" ", 1)[0] + "…"


class ConversationStore(Protocol):
    def create(self, tenant_id: str, uid: str, first_question: str) -> str: ...
    def append(self, tenant_id: str, uid: str, conv_id: str, messages: list[dict]) -> bool: ...
    def get(self, tenant_id: str, uid: str, conv_id: str) -> dict | None: ...
    def list(self, tenant_id: str, uid: str) -> list[dict]: ...
    def delete(self, tenant_id: str, uid: str, conv_id: str) -> bool: ...
    def mark_feedback(self, tenant_id: str, uid: str, conv_id: str, answer_id: str, helpful: bool) -> None: ...


class MemoryConversationStore:
    def __init__(self) -> None:
        self._c: dict[str, dict] = {}
        self._lock = threading.Lock()

    def create(self, tenant_id: str, uid: str, first_question: str) -> str:
        cid = uuid.uuid4().hex
        now = _now()
        with self._lock:
            self._c[cid] = {"id": cid, "tenant_id": tenant_id, "uid": uid, "title": _title(first_question),
                            "created_at": now, "updated_at": now, "messages": []}
        return cid

    def _mine(self, tenant_id: str, uid: str, cid: str) -> dict | None:
        c = self._c.get(cid)
        return c if c and c["tenant_id"] == tenant_id and c["uid"] == uid else None

    def append(self, tenant_id: str, uid: str, conv_id: str, messages: list[dict]) -> bool:
        with self._lock:
            c = self._mine(tenant_id, uid, conv_id)
            if not c:
                return False
            c["messages"] = (c["messages"] + messages)[-MAX_MESSAGES:]
            c["updated_at"] = _now()
            return True

    def get(self, tenant_id: str, uid: str, conv_id: str) -> dict | None:
        with self._lock:
            c = self._mine(tenant_id, uid, conv_id)
            return {k: v for k, v in c.items() if k not in ("tenant_id", "uid")} if c else None

    def list(self, tenant_id: str, uid: str) -> list[dict]:
        with self._lock:
            mine = [c for c in self._c.values() if c["tenant_id"] == tenant_id and c["uid"] == uid]
        mine.sort(key=lambda c: c["updated_at"], reverse=True)
        return [{"id": c["id"], "title": c["title"], "updated_at": c["updated_at"],
                 "messages": len(c["messages"])} for c in mine[:LIST_LIMIT]]

    def delete(self, tenant_id: str, uid: str, conv_id: str) -> bool:
        with self._lock:
            if not self._mine(tenant_id, uid, conv_id):
                return False
            del self._c[conv_id]
            return True

    def mark_feedback(self, tenant_id: str, uid: str, conv_id: str, answer_id: str, helpful: bool) -> None:
        with self._lock:
            c = self._mine(tenant_id, uid, conv_id)
            for m in (c or {}).get("messages", []):
                if m.get("answer_id") == answer_id:
                    m["helpful"] = helpful


class FirestoreConversationStore:
    def __init__(self, db) -> None:
        self._db = db

    def _col(self):
        return self._db.collection("conversations")

    def _mine(self, tenant_id: str, uid: str, cid: str):
        ref = self._col().document(cid)
        snap = ref.get()
        if not snap.exists:
            return None, None
        d = snap.to_dict() or {}
        if d.get("tenant_id") != tenant_id or d.get("uid") != uid:
            return None, None
        return ref, d

    def create(self, tenant_id: str, uid: str, first_question: str) -> str:
        ref = self._col().document()
        now = _now()
        ref.set({"tenant_id": tenant_id, "uid": uid, "title": _title(first_question),
                 "created_at": now, "updated_at": now, "messages": []})
        return ref.id

    def append(self, tenant_id: str, uid: str, conv_id: str, messages: list[dict]) -> bool:
        ref, d = self._mine(tenant_id, uid, conv_id)
        if not ref:
            return False
        ref.update({"messages": (d.get("messages", []) + messages)[-MAX_MESSAGES:], "updated_at": _now()})
        return True

    def get(self, tenant_id: str, uid: str, conv_id: str) -> dict | None:
        ref, d = self._mine(tenant_id, uid, conv_id)
        if not ref:
            return None
        return {"id": conv_id, "title": d.get("title", ""), "created_at": d.get("created_at"),
                "updated_at": d.get("updated_at"), "messages": d.get("messages", [])}

    def list(self, tenant_id: str, uid: str) -> list[dict]:
        # Equality filters only (no composite index); sort in Python.
        q = self._col().where("uid", "==", uid).where("tenant_id", "==", tenant_id)
        rows = []
        for snap in q.stream():
            d = snap.to_dict() or {}
            rows.append({"id": snap.id, "title": d.get("title", ""), "updated_at": d.get("updated_at", ""),
                         "messages": len(d.get("messages", []))})
        rows.sort(key=lambda r: r["updated_at"], reverse=True)
        return rows[:LIST_LIMIT]

    def delete(self, tenant_id: str, uid: str, conv_id: str) -> bool:
        ref, _ = self._mine(tenant_id, uid, conv_id)
        if not ref:
            return False
        ref.delete()
        return True

    def mark_feedback(self, tenant_id: str, uid: str, conv_id: str, answer_id: str, helpful: bool) -> None:
        ref, d = self._mine(tenant_id, uid, conv_id)
        if not ref:
            return
        msgs = d.get("messages", [])
        for m in msgs:
            if m.get("answer_id") == answer_id:
                m["helpful"] = helpful
        ref.update({"messages": msgs})


def create_conversation_store(env: str) -> ConversationStore:
    if os.getenv("RAGAAS_USE_MEMORY_STORE") == "1":
        return MemoryConversationStore()
    if env == "production":
        try:
            from firebase_admin import firestore as fa_firestore
            return FirestoreConversationStore(fa_firestore.client())
        except Exception as exc:
            log.warning("Firestore conversations init failed (%s); using memory", exc)
    return MemoryConversationStore()
