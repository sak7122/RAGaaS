"""Weekly Insights digest: a short plain-text email for workspace admins.

The text is built from the same aggregate the Insights page shows, so the email and
the page never disagree. Subscriptions are per workspace (a list of admin emails);
a scheduler calls POST /api/cron/digest once a week to send them.
"""
from __future__ import annotations

import logging
import os
import threading
from typing import Protocol

log = logging.getLogger("ragaas")


def build_digest(workspace: str, summary: dict, app_url: str) -> tuple[str, str]:
    """(subject, body) for one workspace."""
    trend = summary.get("trend") or []
    this_week = trend[-1] if trend else {"questions": 0, "answered": 0}
    last_week = trend[-2] if len(trend) > 1 else {"questions": 0, "answered": 0}
    q, a = this_week["questions"], this_week["answered"]
    rate = f"{round(100 * a / q)}%" if q else "n/a"
    change = q - last_week["questions"]
    change_txt = (f"{change:+d} vs last week" if last_week["questions"] or change else "first week of data")

    lines = [
        f"Your team asked {q} question{'s' if q != 1 else ''} this week ({change_txt}).",
        f"Answered from your documents: {rate}.",
    ]
    fb = summary.get("feedback") or {}
    if fb.get("rate") is not None:
        lines.append(f"Marked helpful: {round(100 * fb['rate'])}% of rated answers.")

    gaps = summary.get("gaps") or []
    if gaps:
        lines += ["", "Questions your documents couldn't answer:"]
        for g in gaps[:3]:
            lines.append(f"  • {g['question']} (asked {g['count']}×)")
        lines += ["", f"Suggested next step: write a short answer for “{gaps[0]['question']}” "
                      "in Insights → Knowledge gaps → Draft the answer. It becomes searchable straight away."]
    else:
        lines += ["", "No unanswered questions this week."]

    unused = [d for d in (summary.get("documents") or []) if d.get("citations", 0) == 0]
    if unused:
        lines += ["", f"{len(unused)} document{'s' if len(unused) != 1 else ''} weren't used in any answer, "
                      "e.g. " + ", ".join(d.get("title") or d["file_name"] for d in unused[:3]) + "."]

    lines += ["", f"Open Insights: {app_url}", "", "You get this because you turned on the weekly summary in RAGaaS."]
    subject = f"{workspace}: {q} question{'s' if q != 1 else ''} this week, {len(gaps)} gap{'s' if len(gaps) != 1 else ''}"
    return subject, "\n".join(lines)


class DigestStore(Protocol):
    def set(self, tenant_id: str, email: str, on: bool) -> None: ...
    def emails(self, tenant_id: str) -> list[str]: ...
    def all(self) -> dict[str, list[str]]: ...


class MemoryDigestStore:
    def __init__(self) -> None:
        self._subs: dict[str, set[str]] = {}
        self._lock = threading.Lock()

    def set(self, tenant_id: str, email: str, on: bool) -> None:
        with self._lock:
            s = self._subs.setdefault(tenant_id, set())
            (s.add if on else s.discard)(email)

    def emails(self, tenant_id: str) -> list[str]:
        return sorted(self._subs.get(tenant_id, set()))

    def all(self) -> dict[str, list[str]]:
        return {t: sorted(e) for t, e in self._subs.items() if e}


class FirestoreDigestStore:
    def __init__(self, db) -> None:
        self._db = db

    def _doc(self, tenant_id: str):
        return self._db.collection("digest_subscriptions").document(tenant_id)

    def set(self, tenant_id: str, email: str, on: bool) -> None:
        from google.cloud import firestore
        op = firestore.ArrayUnion([email]) if on else firestore.ArrayRemove([email])
        self._doc(tenant_id).set({"emails": op}, merge=True)

    def emails(self, tenant_id: str) -> list[str]:
        snap = self._doc(tenant_id).get()
        return sorted((snap.to_dict() or {}).get("emails", [])) if snap.exists else []

    def all(self) -> dict[str, list[str]]:
        out = {}
        for snap in self._db.collection("digest_subscriptions").stream():
            emails = (snap.to_dict() or {}).get("emails", [])
            if emails:
                out[snap.id] = sorted(emails)
        return out


def create_digest_store(env: str) -> DigestStore:
    if os.getenv("RAGAAS_USE_MEMORY_STORE") == "1":
        return MemoryDigestStore()
    if env == "production":
        try:
            from firebase_admin import firestore as fa_firestore
            return FirestoreDigestStore(fa_firestore.client())
        except Exception as exc:
            log.warning("Firestore digest init failed (%s); using memory", exc)
    return MemoryDigestStore()
