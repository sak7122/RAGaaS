"""Answer quality: duplicate passages and earlier refusals must not crowd out evidence."""
import os

os.environ["RAGAAS_USE_MEMORY_STORE"] = "1"

from fastapi.testclient import TestClient

from backend.main import app, distinct_top, load_index, save_index, usage_store
from backend.rag import usable_history

client = TestClient(app)
TENANT = "tenant-a"
HEADERS = {"Authorization": "Bearer tenant-a-token"}

PAGES = [
    "Consistent hashing places servers and keys on a hash ring; virtual nodes balance the load.",
    "Quorum consensus uses N replicas, W write acknowledgements and R read responses.",
    "Vector clocks pair a server with a version counter to detect conflicting writes.",
    "Hinted handoff and Merkle trees repair replicas after temporary and permanent failures.",
]


def _doc(name: str) -> dict:
    return {"tenant_id": TENANT, "file_name": name, "uploaded_at": "2026-10-10T00:00:00Z",
            "chunks": [{"page": 90 + i, "chunk_index": 0, "text": t} for i, t in enumerate(PAGES)]}


def setup_function() -> None:
    usage_store.reset()
    idx = load_index()
    idx["documents"] = [d for d in idx["documents"] if d["tenant_id"] != TENANT]
    idx["documents"] += [_doc("kv_book.pdf"), _doc("kv_book_1_.pdf")]   # same book uploaded twice
    save_index(idx)


def test_duplicate_upload_does_not_halve_the_evidence() -> None:
    res = client.post("/api/chat", headers=HEADERS,
                      json={"message": "consistent hashing quorum vector clocks hinted handoff replicas"})
    texts = [c["excerpt"] for c in res.json()["citations"]]
    assert len(texts) == len(set(texts))          # each passage once
    assert len(texts) == len(PAGES)               # so all four distinct pages fit


def test_distinct_top_keeps_order_and_limit() -> None:
    a, b, c = {"text": "A  passage"}, {"text": "a passage"}, {"text": "other"}
    out = distinct_top([(0.9, a), (0.8, b), (0.7, c)], k=2)
    assert out == [(0.9, a), (0.7, c)]


def test_earlier_refusals_are_left_out_of_history() -> None:
    nf = "I cannot find the answer to your question in the provided document excerpts."
    history = [
        {"role": "user", "text": "explain the proximity service"}, {"role": "assistant", "text": nf},
        {"role": "user", "text": "explain page 47"}, {"role": "assistant", "text": "I couldn't find this in the documents you can access."},
        {"role": "user", "text": "what is a quorum?"}, {"role": "assistant", "text": "A quorum is W+R>N (kv_book.pdf p.91)."},
    ]
    kept = usable_history(history)
    assert all("find" not in t["text"] for t in kept if t["role"] == "assistant")
    assert kept[-1]["text"].startswith("A quorum")
    assert len(kept) <= 4
