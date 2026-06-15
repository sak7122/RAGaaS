"""
RAG core: embeddings + generation, with a dev path (no external calls, offline,
deterministic) and a prod path (Vertex AI embeddings + Gemini, keyless via ADC).

Dev path is used when RAGAAS_ENV != production or the google-genai SDK is absent,
so pytest and the local stack work with zero credentials.
"""
from __future__ import annotations

import hashlib
import logging
import math
import os
import re
from typing import Protocol

log = logging.getLogger("ragaas")

EMBED_DIM = 256  # dev embedder dimensionality


# ── Tokenizer (shared) ────────────────────────────────────────────────────────
def _tokens(text: str) -> list[str]:
    return re.findall(r"[a-z0-9]{3,}", text.lower())


def cosine(a: list[float], b: list[float]) -> float:
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    if na == 0 or nb == 0:
        return 0.0
    return dot / (na * nb)


# ── Embedder ──────────────────────────────────────────────────────────────────
class Embedder(Protocol):
    dim: int
    def embed(self, texts: list[str]) -> list[list[float]]: ...
    def embed_query(self, text: str) -> list[float]: ...


class LocalEmbedder:
    """Deterministic hashing embedding — token-hash bag-of-words, L2 normalized.
    No network. Similar text -> similar vectors, good enough for dev/tests."""
    dim = EMBED_DIM

    def _vec(self, text: str) -> list[float]:
        v = [0.0] * self.dim
        for tok in _tokens(text):
            h = int(hashlib.md5(tok.encode()).hexdigest(), 16)
            v[h % self.dim] += 1.0
        norm = math.sqrt(sum(x * x for x in v))
        if norm > 0:
            v = [x / norm for x in v]
        return v

    def embed(self, texts: list[str]) -> list[list[float]]:
        return [self._vec(t) for t in texts]

    def embed_query(self, text: str) -> list[float]:
        return self._vec(text)


class VertexEmbedder:
    """Vertex AI text embeddings (e.g. text-embedding-005) via google-genai + ADC."""

    def __init__(self, model: str, project: str, location: str) -> None:
        from google import genai  # imported lazily; only in prod
        self._genai = genai
        self.model = model
        self.client = genai.Client(vertexai=True, project=project, location=location)
        # text-embedding-005 -> 768 dims
        self.dim = 768

    def _embed_batch(self, texts: list[str]) -> list[list[float]]:
        resp = self.client.models.embed_content(model=self.model, contents=texts)
        return [list(e.values) for e in resp.embeddings]

    def embed(self, texts: list[str]) -> list[list[float]]:
        out: list[list[float]] = []
        # Vertex caps batch size; chunk to be safe
        for i in range(0, len(texts), 100):
            out.extend(self._embed_batch(texts[i:i + 100]))
        return out

    def embed_query(self, text: str) -> list[float]:
        return self._embed_batch([text])[0]


# ── Generator ─────────────────────────────────────────────────────────────────
class Generator(Protocol):
    def generate(self, question: str, chunks: list[dict], history: list[dict] | None = None) -> str: ...


class MockGenerator:
    """Dev generator — grounded extractive answer assembled from retrieved chunks."""

    def generate(self, question: str, chunks: list[dict], history: list[dict] | None = None) -> str:
        if not chunks:
            return "I cannot find that answer in your uploaded documents."
        files = ", ".join(sorted({c["file_name"] for c in chunks}))
        top = chunks[0]["text"].strip().replace("\n", " ")
        if len(top) > 400:
            top = top[:400].rsplit(" ", 1)[0] + "…"
        return (
            f"Based on your documents ({files}):\n\n{top}\n\n"
            f"[Dev mode: extractive answer. Production uses Gemini for synthesis.]"
        )


class GeminiGenerator:
    """Prod generator — Gemini grounded synthesis via google-genai + ADC."""

    SYSTEM = (
        "You are a retrieval-augmented assistant. Answer ONLY from the provided "
        "document excerpts. If the answer is not in them, say you cannot find it. "
        "Be thorough and complete — cover all relevant points found in the excerpts. "
        "Cite the source file and page inline like (file.pdf p.N)."
    )

    def __init__(self, model: str, project: str, location: str) -> None:
        from google import genai
        from google.genai import types
        self._types = types
        self.model = model
        self.client = genai.Client(vertexai=True, project=project, location=location)

    _REWRITE_SYSTEM = (
        "You are a search-query optimizer for a document retrieval system. "
        "Your output is fed directly into an embedding model, NOT shown to a user. "
        "Rules: (1) Resolve all pronouns using conversation context. "
        "(2) Expand every acronym/abbreviation AND keep the short form too "
        "    (e.g. CGPA → 'CGPA GPA grade point average cumulative'). "
        "(3) Add synonyms and alternate phrasings that might appear in the document. "
        "(4) Output a compact keyword phrase — NOT a full sentence or question. "
        "(5) Return ONLY the keyword phrase, nothing else."
    )

    def rewrite_query(self, question: str, history: list[dict]) -> str:
        """Produce a retrieval-optimized keyword expansion of the question."""
        history_text = "\n".join(
            f"{t['role'].capitalize()}: {t['text']}" for t in history[-4:]
        )
        context_block = f"Conversation:\n{history_text}\n\n" if history else ""
        prompt = (
            f"{context_block}"
            f"Question to expand: {question}\n\n"
            "Output the retrieval keyword phrase:"
        )
        try:
            resp = self.client.models.generate_content(
                model=self.model,
                contents=prompt,
                config=self._types.GenerateContentConfig(
                    system_instruction=self._REWRITE_SYSTEM,
                    temperature=0.1,
                    max_output_tokens=120,
                ),
            )
            rewritten = (resp.text or "").strip()
            return rewritten if rewritten else question
        except Exception:
            return question

    def generate(self, question: str, chunks: list[dict], history: list[dict] | None = None) -> str:
        if not chunks:
            return "I cannot find that answer in your uploaded documents."
        context = "\n\n".join(
            f"[{c['file_name']} p.{c.get('page', 1)}]\n{c['text']}" for c in chunks
        )
        history_block = ""
        if history:
            history_block = "Conversation history:\n" + "\n".join(
                f"{t['role'].capitalize()}: {t['text']}" for t in history[-4:]
            ) + "\n\n"
        # Defense against prompt injection from untrusted PDF text: the context is
        # clearly fenced and the system prompt forbids following instructions in it.
        prompt = (
            f"{history_block}"
            f"Document excerpts:\n{context}\n\n"
            f"Question: {question}\n\n"
            f"Answer using only the excerpts above."
        )
        resp = self.client.models.generate_content(
            model=self.model,
            contents=prompt,
            config=self._types.GenerateContentConfig(
                system_instruction=self.SYSTEM,
                temperature=0.2,
                max_output_tokens=1500,
            ),
        )
        return (resp.text or "").strip() or "I cannot find that answer in your uploaded documents."


# ── Factories ─────────────────────────────────────────────────────────────────
def _use_prod() -> bool:
    if os.getenv("RAGAAS_ENV", "development") != "production":
        return False
    try:
        import google.genai  # noqa: F401
        return True
    except Exception:
        log.warning("google-genai not installed; falling back to local RAG")
        return False


def create_embedder() -> Embedder:
    if _use_prod():
        try:
            return VertexEmbedder(
                model=os.getenv("EMBED_MODEL", "text-embedding-005"),
                project=os.getenv("GCP_PROJECT_ID", ""),
                location=os.getenv("VERTEX_LOCATION", "us-central1"),
            )
        except Exception as exc:
            log.warning("VertexEmbedder init failed (%s); using LocalEmbedder", exc)
    return LocalEmbedder()


def create_generator() -> Generator:
    if _use_prod():
        try:
            return GeminiGenerator(
                model=os.getenv("GEMINI_MODEL", "gemini-2.5-flash-lite"),
                project=os.getenv("GCP_PROJECT_ID", ""),
                location=os.getenv("VERTEX_LOCATION", "us-central1"),
            )
        except Exception as exc:
            log.warning("GeminiGenerator init failed (%s); using MockGenerator", exc)
    return MockGenerator()
