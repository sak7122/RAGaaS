"""
Download REAL public PDFs from the web and index them for tenant-demo so you can
test retrieval + the knowledge-gap dashboard against varied real-world content.

Run from repo root:  python scripts/fetch_sample_pdfs.py
Then start the backend and ask questions in the UI (Insights tab shows gaps).

These are public, stable documents across different domains on purpose — so some
questions land well and others expose gaps.
"""
from __future__ import annotations

import io
import json
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

from pypdf import PdfReader

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from backend.rag import LocalEmbedder  # noqa: E402

TENANT_ID  = "tenant-demo"
DATA_DIR   = Path("local_data")
UPLOAD_DIR = DATA_DIR / "uploads" / TENANT_ID
INDEX_FILE = DATA_DIR / "index.json"

# (filename, url) — real public PDFs, varied domains.
SOURCES: list[tuple[str, str]] = [
    ("irs_w9_tax_form.pdf",          "https://www.irs.gov/pub/irs-pdf/fw9.pdf"),
    ("nist_cybersecurity_framework.pdf", "https://nvlpubs.nist.gov/nistpubs/CSWP/NIST.CSWP.04162018.pdf"),
    ("attention_is_all_you_need.pdf", "https://arxiv.org/pdf/1706.03762"),
    ("sec_form_10k_sample.pdf",      "https://www.sec.gov/files/form10-k.pdf"),
]

UA = {"User-Agent": "Mozilla/5.0 (RAGaaS sample fetcher)"}


def chunk_text(text: str, size: int = 512) -> list[str]:
    words = text.split()
    chunks, cur, length = [], [], 0
    for w in words:
        if length + len(w) + 1 > size and cur:
            chunks.append(" ".join(cur)); cur, length = [], 0
        cur.append(w); length += len(w) + 1
    if cur:
        chunks.append(" ".join(cur))
    return chunks or [""]


def extract_chunks(content: bytes) -> list[dict]:
    reader = PdfReader(io.BytesIO(content))
    out: list[dict] = []
    for page_num, page in enumerate(reader.pages, start=1):
        text = (page.extract_text() or "").strip()
        for idx, ch in enumerate(chunk_text(text)):
            if ch.strip():
                out.append({"page": page_num, "chunk_index": idx, "text": ch})
    return out


def download(url: str) -> bytes | None:
    try:
        req = urllib.request.Request(url, headers=UA)
        with urllib.request.urlopen(req, timeout=40) as r:
            data = r.read()
        if data[:4] != b"%PDF":
            print(f"  [skip] not a PDF: {url}")
            return None
        return data
    except Exception as exc:
        print(f"  [skip] download failed ({exc}): {url}")
        return None


def main() -> None:
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    embedder = LocalEmbedder()

    index = json.loads(INDEX_FILE.read_text(encoding="utf-8")) if INDEX_FILE.exists() else {"documents": []}
    fetched_names = {n for n, _ in SOURCES}
    index["documents"] = [
        d for d in index["documents"]
        if not (d["tenant_id"] == TENANT_ID and d["file_name"] in fetched_names)
    ]

    added = 0
    for file_name, url in SOURCES:
        print(f"Fetching {file_name} …")
        content = download(url)
        if not content:
            continue
        (UPLOAD_DIR / file_name).write_bytes(content)
        chunks = extract_chunks(content)
        if not chunks:
            print(f"  [skip] no extractable text: {file_name}")
            continue
        for c, v in zip(chunks, embedder.embed([c["text"] for c in chunks])):
            c["embedding"] = v
        index["documents"].append({
            "tenant_id": TENANT_ID,
            "file_name": file_name,
            "path": str((UPLOAD_DIR / file_name).resolve()),
            "chunks": chunks,
            "uploaded_at": datetime.now(timezone.utc).isoformat(),
        })
        added += 1
        print(f"  [ok] {file_name} — {len(chunks)} chunks")

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    INDEX_FILE.write_text(json.dumps(index, indent=2), encoding="utf-8")
    print(f"\nIndexed {added}/{len(SOURCES)} real PDFs for {TENANT_ID}.")
    print("\nTry questions that HIT (test retrieval):")
    print('  "What information does a W-9 form collect?"')
    print('  "What are the five functions of the NIST cybersecurity framework?"')
    print('  "What is multi-head attention?"')
    print('  "What sections are in a 10-K filing?"')
    print("\nTry questions that MISS (test gap detection — Insights tab):")
    print('  "What is our refund policy?"')
    print('  "How many vacation days do I get?"')
    print('  "What is the price of the enterprise plan?"')


if __name__ == "__main__":
    main()
