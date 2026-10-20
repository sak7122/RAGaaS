"""
Query insights + knowledge-gap detection — the product differentiator.

Every question is recorded with its best retrieval score, the documents the answer
cited, the channel it came from and (later) whether the asker found it helpful.
Aggregation surfaces:
  - what the team/customers ask most, with similar phrasings grouped together
  - KNOWLEDGE GAPS: frequent questions the documents answer poorly
  - trend by week, channel mix, which documents do the work, helpful rate

Dev  → MemoryInsightsStore (bounded in-process list)
Prod → FirestoreInsightsStore (tenants/{tid}/query_log)
"""
from __future__ import annotations

import logging
import os
import re
import threading
import uuid
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from typing import Protocol

log = logging.getLogger("ragaas")

# A query whose best chunk scores below this is "poorly answered" → a gap.
GAP_THRESHOLD = 0.30
# Minimum score to store an answer in the FAQ pool.
FAQ_SCORE_THRESHOLD = 0.50
FAQ_LIMIT = 8
# How many recent events to aggregate over.
WINDOW = 1000
TREND_WEEKS = 8
# Two questions are "the same question" when this share of their content words overlap.
SIMILAR_AT = 0.6

_STOP = set("""a an the is are was were be been am do does did can could would should will shall may might must
i me my we our you your he she it they them their this that these those of to in on for at by with from about
as into over after before and or but if then so not no yes how what when where which who whom why there here
please tell know get got any some much many more most just also there's what's how's i'm""".split())


def normalize_question(q: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9 ]", "", q.lower())).strip()


def _content_words(norm: str) -> frozenset[str]:
    words = [w[:-1] if len(w) > 4 and w.endswith("s") else w for w in norm.split()]
    return frozenset(w for w in words if w not in _STOP and len(w) > 1)


def _similar(a: frozenset[str], b: frozenset[str]) -> bool:
    if not a or not b:
        return a == b
    return len(a & b) / len(a | b) >= SIMILAR_AT


def _ts(e: dict) -> datetime | None:
    t = e.get("ts")
    if isinstance(t, datetime):
        return t if t.tzinfo else t.replace(tzinfo=timezone.utc)
    if isinstance(t, str) and t:
        try:
            d = datetime.fromisoformat(t.replace("Z", "+00:00"))
            return d if d.tzinfo else d.replace(tzinfo=timezone.utc)
        except ValueError:
            return None
    return None


def _group(events: list[dict]) -> list[dict]:
    """Cluster events whose questions mean the same thing (content-word overlap).
    Each group: display phrasing (most asked), variants, scores."""
    exact: dict[str, list[dict]] = defaultdict(list)
    for e in events:
        norm = normalize_question(e.get("question", ""))
        if norm:
            exact[norm].append(e)
    # Most-asked phrasings seed the groups so they become the display text.
    groups: list[dict] = []
    for norm, evs in sorted(exact.items(), key=lambda kv: len(kv[1]), reverse=True):
        words = _content_words(norm)
        home = next((g for g in groups if _similar(words, g["words"])), None)
        if home is None:
            home = {"words": words, "phrasings": [], "events": []}
            groups.append(home)
        home["phrasings"].append((evs[0]["question"].strip(), len(evs)))
        home["events"].extend(evs)
    for g in groups:
        g["scores"] = [float(e.get("score", 0.0)) for e in g["events"]]
        g["question"] = g["phrasings"][0][0]
        g["variants"] = [p for p, _ in g["phrasings"][1:4]]
    return groups


def _aggregate(events: list[dict], now: datetime | None = None) -> dict:
    """events: [{question, score, ts, answer?, source?, docs?, helpful?}] in any order."""
    now = now or datetime.now(timezone.utc)
    if not events:
        return {
            "total_queries": 0, "avg_confidence": 0.0, "answered_rate": 0.0, "answered": 0,
            "top_questions": [], "gaps": [], "faqs": [], "window": WINDOW,
            "trend": _trend([], now), "channels": [], "documents": [],
            "feedback": {"helpful": 0, "unhelpful": 0, "rate": None, "recent_unhelpful": []},
        }

    groups = _group(events)
    n = len(events)
    total_score = sum(float(e.get("score", 0.0)) for e in events)
    answered = sum(1 for e in events if float(e.get("score", 0.0)) >= GAP_THRESHOLD)

    top_questions = sorted(
        ({"question": g["question"], "count": len(g["scores"]),
          "avg_score": round(sum(g["scores"]) / len(g["scores"]), 3), "variants": g["variants"]}
         for g in groups),
        key=lambda x: x["count"], reverse=True,
    )[:6]

    # Gaps: groups whose AVERAGE best-score is below threshold, ranked by how often
    # they're asked (frequent + unanswered = highest priority).
    gaps = []
    for g in groups:
        avg = sum(g["scores"]) / len(g["scores"])
        if avg >= GAP_THRESHOLD:
            continue
        last = max((t for t in (_ts(e) for e in g["events"]) if t), default=None)
        gaps.append({
            "question": g["question"], "count": len(g["scores"]),
            "best_score": round(max(g["scores"]), 3), "avg_score": round(avg, 3),
            "variants": g["variants"], "last_asked": last.isoformat() if last else None,
        })
    gaps.sort(key=lambda x: (x["count"], -x["avg_score"]), reverse=True)
    gaps = gaps[:8]

    # FAQs: well-answered groups with their best stored answer (thumbs-down answers excluded).
    faqs = []
    for g in groups:
        best = None
        for e in g["events"]:
            ans = (e.get("answer") or "").strip()
            sc = float(e.get("score", 0.0))
            if ans and sc >= FAQ_SCORE_THRESHOLD and e.get("helpful") is not False:
                if best is None or sc > best[0]:
                    best = (sc, ans)
        if best:
            faqs.append({"question": g["question"], "answer": best[1], "score": round(best[0], 3),
                         "count": len(g["scores"])})
    faqs.sort(key=lambda x: x["count"], reverse=True)

    channels = Counter(e.get("source") or "chat" for e in events)
    docs = Counter(d for e in events for d in set(e.get("docs") or []))
    up = sum(1 for e in events if e.get("helpful") is True)
    down_events = [e for e in events if e.get("helpful") is False]
    down_events.sort(key=lambda e: _ts(e) or now, reverse=True)

    return {
        "total_queries": n,
        "avg_confidence": round(total_score / n, 3),
        "answered_rate": round(answered / n, 3),
        "answered": answered,
        "top_questions": top_questions,
        "gaps": gaps,
        "faqs": faqs[:FAQ_LIMIT],
        "window": WINDOW,
        "trend": _trend(events, now),
        "channels": [{"source": k, "count": v} for k, v in channels.most_common()],
        "documents": [{"file_name": k, "citations": v} for k, v in docs.most_common()],
        "feedback": {
            "helpful": up, "unhelpful": len(down_events),
            "rate": round(up / (up + len(down_events)), 3) if (up + len(down_events)) else None,
            "recent_unhelpful": [
                {"question": e.get("question", ""), "answer": (e.get("answer") or "")[:400],
                 "ts": (_ts(e) or now).isoformat()}
                for e in down_events[:5]
            ],
        },
    }


def _trend(events: list[dict], now: datetime) -> list[dict]:
    """Questions and answered questions per week (Monday start), oldest first."""
    this_monday = (now - timedelta(days=now.weekday())).replace(hour=0, minute=0, second=0, microsecond=0)
    weeks = [this_monday - timedelta(weeks=i) for i in range(TREND_WEEKS - 1, -1, -1)]
    buckets = {w: [0, 0] for w in weeks}
    for e in events:
        t = _ts(e)
        if not t:
            continue
        start = (t - timedelta(days=t.weekday())).replace(hour=0, minute=0, second=0, microsecond=0)
        if start in buckets:
            buckets[start][0] += 1
            if float(e.get("score", 0.0)) >= GAP_THRESHOLD:
                buckets[start][1] += 1
    return [{"week": w.date().isoformat(), "questions": q, "answered": a} for w, (q, a) in buckets.items()]


SLACK_QUERY_LIMIT = 200   # max events returned from channel_queries()


class InsightsStore(Protocol):
    def record(self, tenant_id: str, question: str, score: float, answer: str = "",
               source: str = "chat", slack_user: str = "", docs: list[str] | None = None,
               uid: str = "") -> str: ...
    def feedback(self, tenant_id: str, event_id: str, helpful: bool, uid: str = "") -> bool: ...
    def summary(self, tenant_id: str) -> dict: ...
    def slack_queries(self, tenant_id: str) -> list[dict]: ...
    # Questions from one outside channel ("slack", "whatsapp"); "slack_user" holds who asked.
    def channel_queries(self, tenant_id: str, source: str) -> list[dict]: ...
    def reset(self) -> None: ...


def _event(question: str, score: float, answer: str, source: str, slack_user: str,
           docs: list[str] | None, uid: str) -> dict:
    return {
        "question": question, "score": float(score), "answer": answer, "source": source,
        "slack_user": slack_user, "docs": sorted(set(docs or [])), "uid": uid,
    }


class MemoryInsightsStore:
    def __init__(self) -> None:
        self._events: dict[str, list[dict]] = defaultdict(list)
        self._lock = threading.Lock()

    def record(self, tenant_id: str, question: str, score: float, answer: str = "",
               source: str = "chat", slack_user: str = "", docs: list[str] | None = None,
               uid: str = "") -> str:
        event_id = uuid.uuid4().hex
        with self._lock:
            buf = self._events[tenant_id]
            buf.append({**_event(question, score, answer, source, slack_user, docs, uid),
                        "id": event_id, "ts": datetime.now(timezone.utc).isoformat()})
            if len(buf) > WINDOW:
                del buf[: len(buf) - WINDOW]
        return event_id

    def feedback(self, tenant_id: str, event_id: str, helpful: bool, uid: str = "") -> bool:
        with self._lock:
            for e in self._events.get(tenant_id, []):
                if e.get("id") == event_id:
                    if uid and e.get("uid") and e["uid"] != uid:
                        return False          # only the asker rates their own answer
                    e["helpful"] = helpful
                    return True
        return False

    def summary(self, tenant_id: str) -> dict:
        with self._lock:
            return _aggregate(list(self._events.get(tenant_id, [])))

    def slack_queries(self, tenant_id: str) -> list[dict]:
        return self.channel_queries(tenant_id, "slack")

    def channel_queries(self, tenant_id: str, source: str) -> list[dict]:
        with self._lock:
            events = self._events.get(tenant_id, [])
            return [e for e in reversed(events) if e.get("source") == source][:SLACK_QUERY_LIMIT]

    def reset(self) -> None:
        with self._lock:
            self._events.clear()


class FirestoreInsightsStore:
    def __init__(self, db) -> None:
        self._db = db

    def _col(self, tenant_id: str):
        return self._db.collection("tenants").document(tenant_id).collection("query_log")

    def record(self, tenant_id: str, question: str, score: float, answer: str = "",
               source: str = "chat", slack_user: str = "", docs: list[str] | None = None,
               uid: str = "") -> str:
        ref = self._col(tenant_id).document()
        ref.set({**_event(question, score, answer, source, slack_user, docs, uid),
                 "ts": datetime.now(timezone.utc)})
        return ref.id

    def feedback(self, tenant_id: str, event_id: str, helpful: bool, uid: str = "") -> bool:
        ref = self._col(tenant_id).document(event_id)
        snap = ref.get()
        if not snap.exists:
            return False
        owner = (snap.to_dict() or {}).get("uid")
        if uid and owner and owner != uid:
            return False
        ref.update({"helpful": helpful, "feedback_at": datetime.now(timezone.utc)})
        return True

    def summary(self, tenant_id: str) -> dict:
        q = self._col(tenant_id).order_by("ts", direction="DESCENDING").limit(WINDOW)
        events = [d.to_dict() or {} for d in q.stream()]
        return _aggregate(events)

    def slack_queries(self, tenant_id: str) -> list[dict]:
        return self.channel_queries(tenant_id, "slack")

    def channel_queries(self, tenant_id: str, source: str) -> list[dict]:
        # Scan recent events ordered by ts (existing index) and filter in Python —
        # avoids a composite index on (source, ts).
        q = self._col(tenant_id).order_by("ts", direction="DESCENDING").limit(WINDOW)
        results = []
        for doc in q.stream():
            d = doc.to_dict() or {}
            if d.get("source") != source:
                continue
            ts = d.get("ts")
            if hasattr(ts, "isoformat"):
                d["ts"] = ts.isoformat()
            results.append(d)
            if len(results) >= SLACK_QUERY_LIMIT:
                break
        return results

    def reset(self) -> None:
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
