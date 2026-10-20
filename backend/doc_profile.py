"""
Document profiles for the Ask page's document picker: a short title, a one- or
two-sentence summary and a few starter questions per indexed document.

Built once at upload and stored on the document's metadata, so listing documents
never calls a model. Prod asks Gemini (generator.describe); dev, tests and any
model failure fall back to an extractive profile built from the first chunks.
Older documents indexed before profiles existed are backfilled extractively the
first time they are listed.

Document text is untrusted: the model only sees it as fenced data, and whatever
comes back is treated as untrusted too — coerced to plain strings and capped.
"""
from __future__ import annotations

import logging
import re
from collections import Counter

log = logging.getLogger("ragaas")

# Bump when the extractive heuristics change: stored extractive profiles older than
# this are rebuilt the next time documents are listed. Model-made profiles are kept.
PROFILE_VERSION = 2

MAX_TITLE = 80
MAX_SUMMARY = 320
MAX_QUESTION = 140
MAX_QUESTIONS = 4
SAMPLE_CHUNKS = 8          # how much of the document the profile is built from
SAMPLE_CHARS = 6000        # cap on the excerpt sent to the model

_STOP = set("""
a about above after again against all also although among an and any are around as at be because been before
being below between both but by can could did does doing down during each either else even every few for from
further had has have having here how however if in into is it its itself just less like made make many may
might more most much must near need never next no nor not now of off often on once only onto or other others
our out over own per please rather same shall should since so some such than that the their them then there
these they this those though through thus to too toward under until upon us use used using very via was we
were what when where whether which while who whom whose why will with within without would yet you your
page pages section sections document documents chapter table figure shall must also each must any
""".split())


def title_from_file(file_name: str) -> str:
    stem = file_name.rsplit(".", 1)[0] if "." in file_name else file_name
    words = re.sub(r"[_\-]+", " ", stem).strip()
    words = re.sub(r"\s+", " ", words) or file_name
    return _clip(words[:1].upper() + words[1:], MAX_TITLE)


def _clip(text: str, limit: int) -> str:
    text = re.sub(r"\s+", " ", str(text)).strip()
    if len(text) <= limit:
        return text
    cut = text[:limit].rsplit(" ", 1)[0].rstrip(",;:")
    return cut + "…"


def _clean_question(q: object) -> str | None:
    if not isinstance(q, str):
        return None
    q = re.sub(r"\s+", " ", q).strip().strip('"').strip()
    if len(q) < 8 or len(q) > MAX_QUESTION:
        return None
    return q if q.endswith("?") else q.rstrip(".") + "?"


def _ordered(chunks: list[dict]) -> list[dict]:
    return sorted(chunks, key=lambda c: (int(c.get("page", 1)), int(c.get("chunk_index", 0))))


def _sample_text(chunks: list[dict]) -> str:
    text = " ".join((c.get("text") or "").strip() for c in _ordered(chunks)[:SAMPLE_CHUNKS])
    return re.sub(r"\s+", " ", text).strip()[:SAMPLE_CHARS]


def page_count(chunks: list[dict]) -> int:
    return max((int(c.get("page", 1)) for c in chunks), default=0)


# Sentences that say what the document is ("This guide covers…") make the best summary.
_SELF_DESCRIBING = re.compile(r"\b(this|the)\s+(document|guide|handbook|policy|playbook|manual|framework|"
                              r"agreement|template|form|paper|report|plan)\b.{0,40}\b(covers|outlines|describes|"
                              r"explains|sets out|defines|provides|contains|summari[sz]es|is)\b", re.I)
# "Password Policy:" style labels name the sections a document answers questions about.
_LABEL = re.compile(r"\b([A-Z][a-z]+(?: [A-Za-z][a-z]+)?):\s")
_META_LABELS = {"effective", "owner", "version", "date", "page", "note", "notes", "approved by", "author",
                "updated", "last updated", "revision", "status", "name", "title", "email", "phone"}


def _title_from_text(stem_title: str, text: str) -> str:
    """The file name's words as the document writes them ("IT Security Policy", not "It security policy")."""
    parts = re.findall(r"[A-Za-z0-9]+", stem_title)
    if not parts:
        return stem_title
    m = re.search(r"\W+".join(re.escape(p) for p in parts), text[:400], re.I)
    if not m or m.group(0).islower():      # running prose ("the travel policy covers…"), not a title
        return stem_title
    found = m.group(0)
    return _clip(found[:1].upper() + found[1:], MAX_TITLE)


def _prose(sentence: str) -> bool:
    words = sentence.split()
    if len(words) < 7 or "|" in sentence:
        return False
    lower = sum(1 for w in words if w[:1].islower())
    digits = sum(ch.isdigit() for ch in sentence)
    return lower / len(words) >= 0.45 and digits / len(sentence) < 0.12


def _topics(text: str, title: str) -> list[str]:
    title_words = {w.lower() for w in re.findall(r"[A-Za-z]+", title)}
    seen: list[str] = []

    def add(topic: str) -> None:
        t = topic.strip().lower()
        if t and t not in seen and not set(t.split()) <= title_words:
            seen.append(t)

    for m in _LABEL.finditer(text):                       # section labels first
        if m.group(1).lower() not in _META_LABELS:
            add(m.group(1))
    tokens = [w for w in re.findall(r"[a-z][a-z\-]{2,}", text.lower())]
    pairs = Counter(f"{a} {b}" for a, b in zip(tokens, tokens[1:])
                    if a not in _STOP and b not in _STOP and len(a) > 3 and len(b) > 3)
    for pair, n in pairs.most_common(12):                 # then repeated two-word phrases
        if n >= 2:
            add(pair)
    singles = Counter(w for w in tokens if w not in _STOP and len(w) > 4 and w not in title_words)
    for w, _ in singles.most_common(8):                   # single words only to fill the gaps
        if not any(w in s for s in seen):
            add(w)
    return seen[:MAX_QUESTIONS]


def extractive_profile(file_name: str, chunks: list[dict]) -> dict:
    """Model-free profile: self-describing or leading prose as the summary, section labels and
    repeated phrases as starter questions."""
    text = _sample_text(chunks)
    title = _title_from_text(title_from_file(file_name), text)

    sentences = [s.strip() for s in re.split(r"(?<=[.!?])\s+", text) if s.strip()]
    prose = [s for s in sentences if _prose(s)]
    ordered = [s for s in prose if _SELF_DESCRIBING.search(s)] + [s for s in prose if not _SELF_DESCRIBING.search(s)]
    summary = ""
    for sentence in ordered[:3]:
        if summary and len(summary) + len(sentence) + 1 > MAX_SUMMARY:
            break
        summary = f"{summary} {sentence}".strip()
    summary = _clip(summary or text, MAX_SUMMARY)

    questions = [f"What does the {title} say about {t}?" for t in _topics(text, title)]
    return {"title": title, "summary": summary,
            "questions": [q for q in (_clean_question(q) for q in questions) if q],
            "profile_source": "extractive", "profile_version": PROFILE_VERSION}


def profile_is_current(doc: dict) -> bool:
    if not doc.get("summary"):
        return False
    return doc.get("profile_source") == "generated" or doc.get("profile_version") == PROFILE_VERSION


def build_profile(file_name: str, chunks: list[dict], generator=None) -> dict:
    """Profile for a document; uses generator.describe when available, else extractive.
    Always returns {title, summary, questions, profile_source, pages}."""
    base = extractive_profile(file_name, chunks)
    describe = getattr(generator, "describe", None)
    if callable(describe) and chunks:
        try:
            raw = describe(base["title"], _sample_text(chunks)) or {}
            summary = _clip(raw.get("summary") or "", MAX_SUMMARY) if isinstance(raw.get("summary"), str) else ""
            questions = [q for q in (_clean_question(q) for q in (raw.get("questions") or [])[:MAX_QUESTIONS * 2]) if q]
            title = _clip(raw["title"], MAX_TITLE) if isinstance(raw.get("title"), str) and raw["title"].strip() else base["title"]
            if summary and questions:
                base = {"title": title, "summary": summary, "questions": questions[:MAX_QUESTIONS],
                        "profile_source": "generated", "profile_version": PROFILE_VERSION}
        except Exception as exc:  # model down, bad JSON, quota: the extractive profile still ships
            log.warning("profile generation failed for %s (%s); using extractive", file_name, exc)
    base["pages"] = page_count(chunks)
    return base
