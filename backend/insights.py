"""
Query insights + knowledge-gap detection — the product differentiator.

Every chat query is recorded with its best retrieval score. Aggregation surfaces:
  - what the team/customers ask most
  - how confident the KB is (avg best-match score)
  - KNOWLEDGE GAPS: frequent questions the documents answer poorly

Dev  → MemoryInsightsStore (bounded in-process list)
Prod → FirestoreInsightsStore (tenants/{tid}/query_log)
"""
from __future__ import annotations

import logging
import os
import re
import threading
from collections import defaultdict
from datetime import datetime, timezone
from typing import Protocol

log = logging.getLogger("ragaas")

# A query whose best chunk scores below this is "poorly answered" → a gap.
GAP_THRESHOLD = 0.30
# How many recent events to aggregate over.
WINDOW = 1000


def normalize_question(q: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9 ]", "", q.lower())).strip()


def _aggregate(events: list[dict]) -> dict:
    """events: [{question, score, ts}] most-recent-first or any order."""
    if not events:
        return {
            "total_queries": 0,
            "avg_confidence": 0.0,
            "answered_rate": 0.0,
            "top_questions": [],
            "gaps": [],
            "window": WINDOW,
        }

    by_q: dict[str, list[float]] = defaultdict(list)
    display: dict[str, str] = {}
    total_score = 0.0
    answered = 0
    for e in events:
        norm = normalize_question(e["question"])
        if not norm:
            continue
        by_q[norm].append(float(e["score"]))
        display.setdefault(norm, e["question"].strip())
        total_score += float(e["score"])
        if float(e["score"]) >= GAP_THRESHOLD:
            answered += 1

    n = len(events)
    top_questions = sorted(
        (
            {
                "question": display[k],
                "count": len(v),
                "avg_score": round(sum(v) / len(v), 3),
            }
            for k, v in by_q.items()
        ),
        key=lambda x: x["count"],
        reverse=True,
    )[:6]

    # Gaps: questions whose AVERAGE best-score is below threshold, ranked by how
    # often they're asked (frequent + unanswered = highest priority).
    gaps = sorted(
        (
            {
                "question": display[k],
                "count": len(v),
                "best_score": round(max(v), 3),
                "avg_score": round(sum(v) / len(v), 3),
            }
            for k, v in by_q.items()
            if sum(v) / len(v) < GAP_THRESHOLD
        ),
        key=lambda x: (x["count"], -x["avg_score"]),
        reverse=True,
    )[:6]

    return {
        "total_queries": n,
        "avg_confidence": round(total_score / n, 3),
        "answered_rate": round(answered / n, 3),
        "top_questions": top_questions,
        "gaps": gaps,
        "window": WINDOW,
    }


class InsightsStore(Protocol):
    def record(self, tenant_id: str, question: str, score: float) -> None: ...
    def summary(self, tenant_id: str) -> dict: ...
    def reset(self) -> None: ...


class MemoryInsightsStore:
    def __init__(self) -> None:
        self._events: dict[str, list[dict]] = defaultdict(list)
        self._lock = threading.Lock()

    def record(self, tenant_id: str, question: str, score: float) -> None:
        with self._lock:
            buf = self._events[tenant_id]
            buf.append({"question": question, "score": float(score),
                        "ts": datetime.now(timezone.utc).isoformat()})
            if len(buf) > WINDOW:
                del buf[: len(buf) - WINDOW]

    def summary(self, tenant_id: str) -> dict:
        with self._lock:
            return _aggregate(list(self._events.get(tenant_id, [])))

    def reset(self) -> None:
        with self._lock:
            self._events.clear()


class FirestoreInsightsStore:
    def __init__(self, db) -> None:
        self._db = db

    def _col(self, tenant_id: str):
        return self._db.collection("tenants").document(tenant_id).collection("query_log")

    def record(self, tenant_id: str, question: str, score: float) -> None:
        self._col(tenant_id).add({
            "question": question,
            "score": float(score),
            "ts": datetime.now(timezone.utc),
        })

    def summary(self, tenant_id: str) -> dict:
        from google.cloud.firestore_v1.base_query import FieldFilter  # noqa: F401
        q = self._col(tenant_id).order_by("ts", direction="DESCENDING").limit(WINDOW)
        events = [d.to_dict() or {} for d in q.stream()]
        return _aggregate(events)

    def reset(self) -> None:
        # Dev-only convenience; prod keeps history.
        pass


def create_insights_store(env: str) -> InsightsStore:
    if os.getenv("RAGAAS_USE_MEMORY_STORE") == "1":
        return MemoryInsightsStore()
    if env == "production":
        try:
            from firebase_admin import firestore as fa_firestore
            return FirestoreInsightsStore(fa_firestore.client())
        except Exception as exc:
            log.warning("Firestore insights init failed (%s); using memory", exc)
    return MemoryInsightsStore()
