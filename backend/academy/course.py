"""Learning-path generation (Academy M2).

Builds topic → lesson → quiz items for one target audience. Every call goes
through KnowledgeSearch.generate with the *audience's* entitlement, so a path
for Sales can only be built from documents Sales may read.

Prod: Vertex AI Search Answer API (billed as Vertex AI Search → trial credit).
Dev/tests: deterministic drafts straight from the visible documents.

Nothing here is trusted blindly: JSON is extracted defensively, every item is
validated (4 distinct options, in-range answer index, boolean T/F), and
anything that fails is dropped rather than stored.
"""
from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass, field

from backend.academy.search import KnowledgeSearch, MemoryKnowledgeSearch
from backend.academy.store import Entitlement, KbDocument

log = logging.getLogger("ragaas.academy")

MAX_MODULES = 8


@dataclass
class DraftItem:
    type: str
    stem: str
    options: list[str] | None
    answer: object
    explanation: str
    source_doc_ids: list[str] = field(default_factory=list)


@dataclass
class DraftModule:
    title: str
    lesson_md: str
    source_doc_ids: list[str]
    items: list[DraftItem]


# Answer API: the query must look like a search; format rules go in the preamble.
TOPICS_QUERY = "Main policies, procedures, rules and responsibilities a new employee must know"
TOPICS_INSTRUCTIONS = (
    "List the {n} most important distinct topics a new employee must learn from the documents. "
    "Spread the topics across ALL of the provided documents rather than taking them all from one. "
    'Reply with ONLY a JSON array and no other text: [{{"title": "short topic name", '
    '"focus": "one sentence on what to learn"}}]'
)
LESSON_INSTRUCTIONS = (
    "Write a short onboarding lesson about the topic in the query for a new employee. Use 2 to 4 "
    "short paragraphs in Markdown, then a bulleted list headed **Key facts**. Use only facts from "
    "the documents. Do not add a title heading."
)
QUIZ_INSTRUCTIONS = (
    "Write {k} quiz questions about the topic in the query using only facts from the documents. "
    "Reply with ONLY a JSON array and no other text. Use {mcq} multiple-choice items shaped "
    '{{"type": "mcq", "stem": "...", "options": ["...", "...", "...", "..."], "answer": 0, '
    '"explanation": "..."}} where answer is the index (0-3) of the correct option (vary which index '
    'is correct), and 1 true/false item shaped {{"type": "true_false", "stem": "...", "answer": true, '
    '"explanation": "..."}}.'
)


def extract_json_array(text: str) -> list:
    """Pull the first JSON array out of model text (handles ```json fences and prose)."""
    cleaned = re.sub(r"```(?:json)?", "", text)
    start, end = cleaned.find("["), cleaned.rfind("]")
    if start == -1 or end <= start:
        return []
    try:
        data = json.loads(cleaned[start:end + 1])
    except json.JSONDecodeError:
        return []
    return data if isinstance(data, list) else []


def validate_item(raw: dict, source_doc_ids: list[str]) -> DraftItem | None:
    if not isinstance(raw, dict):
        return None
    kind, stem = raw.get("type"), str(raw.get("stem", "")).strip()
    explanation = str(raw.get("explanation", "")).strip()
    if not stem or len(stem) > 500:
        return None
    if kind == "mcq":
        opts = raw.get("options")
        ans = raw.get("answer")
        if not isinstance(opts, list) or len(opts) != 4:
            return None
        opts = [str(o).strip() for o in opts]
        if any(not o for o in opts) or len({o.lower() for o in opts}) != 4:
            return None
        if isinstance(ans, bool) or not isinstance(ans, int) or not 0 <= ans <= 3:
            return None
        return DraftItem("mcq", stem, opts, ans, explanation, source_doc_ids)
    if kind == "true_false":
        ans = raw.get("answer")
        if not isinstance(ans, bool):
            return None
        return DraftItem("true_false", stem, None, ans, explanation, source_doc_ids)
    return None


class CourseGenerator:
    def __init__(self, search: KnowledgeSearch) -> None:
        self._search = search

    def build(self, tenant_id: str, ent: Entitlement, docs: list[KbDocument],
              module_count: int, questions_per_module: int = 4) -> list[DraftModule]:
        n = max(1, min(module_count, MAX_MODULES))
        if isinstance(self._search, MemoryKnowledgeSearch):
            return self._build_mock(tenant_id, ent, n)
        return self._build_vertex(tenant_id, ent, docs, n, max(2, min(questions_per_module, 8)))

    # ── Vertex AI Search Answer API ───────────────────────────────────────────
    def _build_vertex(self, tenant_id: str, ent: Entitlement, docs: list[KbDocument],
                      n: int, k: int) -> list[DraftModule]:
        topics_raw = extract_json_array(self._search.generate(
            tenant_id, TOPICS_QUERY, ent, TOPICS_INSTRUCTIONS.format(n=n)).answer)
        topics = [(str(t.get("title", "")).strip(), str(t.get("focus", "")).strip())
                  for t in topics_raw if isinstance(t, dict) and t.get("title")][:n]
        if not topics:   # fall back to one module per visible document
            topics = [(d.title.rsplit(".", 1)[0].replace("_", " "), "") for d in docs[:n]]

        # A generic topic search favours whichever document best matches "new employee";
        # any visible document no lesson has cited yet gets a lesson of its own.
        covered: set[str] = set()
        modules: list[DraftModule] = []
        queue = list(topics)
        uncovered = [d for d in docs]
        while queue or (len(modules) < n and uncovered):
            if queue:
                title, focus = queue.pop(0)
            else:
                d = uncovered.pop(0)
                if d.id in covered:
                    continue
                title, focus = d.title.rsplit(".", 1)[0].replace("_", " ").title(), ""
            if len(modules) >= n:
                break
            query = f"{title}: {focus}" if focus else title
            lesson = self._search.generate(tenant_id, query, ent, LESSON_INSTRUCTIONS)
            if not lesson.grounded:
                log.info("academy gen: skipped ungrounded topic %r", title)
                continue
            src = sorted({c.doc_id for c in lesson.citations if c.doc_id})
            quiz = self._search.generate(tenant_id, query, ent, QUIZ_INSTRUCTIONS.format(k=k, mcq=k - 1))
            qsrc = sorted({c.doc_id for c in quiz.citations if c.doc_id}) or src
            items = [i for i in (validate_item(r, qsrc) for r in extract_json_array(quiz.answer)) if i]
            lesson_md = re.sub(r"^\s*#+ .*\n+", "", lesson.answer.strip())   # drop a stray title heading
            modules.append(DraftModule(title, lesson_md, src, items[:k]))
            covered.update(src)
            # Reserve remaining slots for documents nothing has cited yet.
            if queue and len(modules) + len([d for d in uncovered if d.id not in covered]) >= n:
                queue = []
        return modules

    # ── Dev / tests: deterministic, no model ──────────────────────────────────
    def _build_mock(self, tenant_id: str, ent: Entitlement, n: int) -> list[DraftModule]:
        visible = self._search.visible_docs(tenant_id, ent)  # type: ignore[attr-defined]
        sentences = [(d.id, s.strip()) for d, t in visible
                     for s in re.split(r"(?<=[.!?])\s+", t) if len(s.strip()) > 20]
        modules: list[DraftModule] = []
        for doc, text in visible[:n]:
            title = doc.title.rsplit(".", 1)[0].replace("_", " ").title()
            own = [s for did, s in sentences if did == doc.id]
            if not own:
                continue
            items: list[DraftItem] = []
            others = [s for did, s in sentences if did != doc.id]
            distractors = (others + [f"This is not covered in {title}.", "None of these apply.",
                                     "It depends on the team lead."])[:3]
            items.append(DraftItem("mcq", f"Which statement comes from {title}?",
                                   [own[0], *distractors], 0, f"Stated in {doc.title}.", [doc.id]))
            items.append(DraftItem("true_false", f"True or false: {own[-1]}", None, True,
                                   f"Stated in {doc.title}.", [doc.id]))
            lesson = "\n\n".join(own[:4]) + "\n\n**Key facts**\n" + "\n".join(f"- {s}" for s in own[:3])
            modules.append(DraftModule(title, lesson, [doc.id], items))
        return modules
