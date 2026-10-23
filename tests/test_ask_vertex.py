"""Ask on Vertex AI Search: response parsing, citation placement, workspace
isolation, fallback to the Gemini pipeline, sessions and index mirroring."""
import json
import os

os.environ["RAGAAS_USE_MEMORY_STORE"] = "1"

import pytest
from fastapi.testclient import TestClient

import backend.main as main
from backend.ask_search import AskAnswer, AskCitation, VertexAskSearch, build_filter, insert_citations, page_doc_id, pages_from_chunks
from backend.conversations import MemoryConversationStore

client = TestClient(main.app)
A = {"Authorization": "Bearer tenant-a-token"}


# ── pure helpers ──────────────────────────────────────────────────────────────
def test_citations_land_after_their_sentence():
    text = "1NF needs atomic values. BCNF needs a super key."
    first = len("1NF needs atomic values.".encode())
    out = insert_citations(text, [(0, first, ["notes.pdf p.22"]), (first + 1, len(text.encode()), ["notes.pdf p.23"])])
    assert out == "1NF needs atomic values (notes.pdf p.22). BCNF needs a super key (notes.pdf p.23)."


def test_citation_offsets_are_utf8_bytes():
    text = "सुरक्षा प्रशिक्षण पाँच दिन में। Done."
    end = len("सुरक्षा प्रशिक्षण पाँच दिन में।".encode())
    out = insert_citations(text, [(0, end, ["hb.pdf p.12"])])
    assert out.startswith("सुरक्षा प्रशिक्षण पाँच दिन में (hb.pdf p.12)।")


def test_filter_and_ids():
    assert build_filter("t1", None) == 'tenant_id: ANY("t1")'
    assert build_filter("t1", ["b.pdf", 'a"x.pdf']) == 'tenant_id: ANY("t1") AND file_name: ANY("a\\"x.pdf", "b.pdf")'
    pid = page_doc_id("t1", "x.pdf", 3)
    assert pid.endswith("-p3") and len(pid) <= 63 and pid != page_doc_id("t2", "x.pdf", 3)
    assert pages_from_chunks([{"page": 2, "chunk_index": 1, "text": "b"}, {"page": 2, "chunk_index": 0, "text": "a"}]) == {2: "a\n\nb"}


def test_parse_drops_other_workspace_references():
    data = {"session": {"name": "s/1"}, "answer": {
        "answerText": "Answer.", "relatedQuestions": ["Next?"],
        "references": [
            {"chunkInfo": {"content": "mine", "documentMetadata": {"structData": {"tenant_id": "t1", "file_name": "m.pdf", "page": 4}}}},
            {"chunkInfo": {"content": "theirs", "documentMetadata": {"structData": {"tenant_id": "t2", "file_name": "x.pdf", "page": 1}}}},
        ],
        "citations": [{"startIndex": 0, "endIndex": 7, "sources": [{"referenceId": "0"}, {"referenceId": "1"}]}],
    }}
    a = VertexAskSearch._parse(data, "t1")
    assert a.grounded and [(c.file_name, c.page) for c in a.citations] == [("m.pdf", 4)]
    assert a.answer == "Answer (m.pdf p.4)." and a.session == "s/1" and a.related == ["Next?"]


def test_parse_skipped_answer_is_not_grounded():
    a = VertexAskSearch._parse({"answer": {"answerText": "x", "answerSkippedReasons": ["NO_RELEVANT_CONTENT"]}}, "t1")
    assert not a.grounded and a.citations == []


# ── main.py integration with a fake Vertex client ─────────────────────────────
class FakeAsk:
    def __init__(self, grounded=True):
        self.grounded = grounded
        self.calls, self.indexed, self.deleted = [], [], []

    def answer(self, tenant_id, question, file_names=None, session=None):
        self.calls.append((tenant_id, question, file_names, session))
        if not self.grounded:
            return AskAnswer("", [], False, "sess-1")
        return AskAnswer("Training is due in five days (handbook.txt p.1).",
                         [AskCitation("handbook.txt", 1, "Security training is due within five business days.")],
                         True, "sess-1", ["Who runs the training?"])

    def index_document(self, tenant_id, file_name, title, chunks):
        self.indexed.append((tenant_id, file_name, sorted({c["page"] for c in chunks})))
        return len({c["page"] for c in chunks})

    def delete_document(self, tenant_id, file_name, pages):
        self.deleted.append((tenant_id, file_name, list(pages)))


@pytest.fixture
def fake(monkeypatch):
    main.usage_store.reset()
    main.insights_store.reset()
    monkeypatch.setattr(main, "conversation_store", MemoryConversationStore())
    idx = main.load_index()
    idx["documents"] = [d for d in idx["documents"] if d["tenant_id"] != "tenant-a"]
    main.save_index(idx)
    f = FakeAsk()
    monkeypatch.setattr(main, "ask_search", f)
    return f


def upload(name, text):
    return client.post("/api/upload", headers=A, files={"file": (name, text.encode(), "text/plain")})


def test_answer_comes_from_vertex_with_session_and_related(fake):
    upload("handbook.txt", "Security training is due within five business days.")
    r = client.post("/api/chat", headers=A, json={"message": "when is training due?"}).json()
    assert r["retrieval"]["engine"] == "Vertex AI Search"
    assert r["citations"][0]["file_name"] == "handbook.txt" and r["related"] == ["Who runs the training?"]
    cid = r["conversation_id"]
    client.post("/api/chat", headers=A, json={"message": "who runs it?", "conversation_id": cid})
    assert fake.calls[-1][3] == "sess-1"          # follow-up reuses the Vertex session
    assert main.insights_store.summary("tenant-a")["answered_rate"] == 1.0


def test_scope_is_passed_as_a_filter(fake):
    upload("handbook.txt", "Security training is due within five business days.")
    client.post("/api/chat", headers=A, json={"message": "training?", "file_names": ["handbook.txt"]})
    assert fake.calls[-1][2] == ["handbook.txt"]


def test_falls_back_to_gemini_pipeline_when_vertex_has_nothing(fake):
    fake.grounded = False
    upload("handbook.txt", "Security training is due within five business days.")
    r = client.post("/api/chat", headers=A, json={"message": "when is security training due"}).json()
    assert r["retrieval"]["engine"] != "Vertex AI Search" and r["citations"]


def test_stream_from_vertex(fake):
    upload("handbook.txt", "Security training is due within five business days.")
    r = client.post("/api/chat/stream", headers=A, json={"message": "when is training due?"})
    events = [json.loads(l) for l in r.text.splitlines() if l.strip()]
    assert events[0]["retrieval"]["engine"] == "Vertex AI Search"
    assert events[-1]["related"] == ["Who runs the training?"] and "(handbook.txt p.1)" in events[-1]["answer"]


def test_index_and_delete_mirror_into_vertex(fake):
    upload("guide.txt", "Page one text.")
    assert fake.indexed[-1] == ("tenant-a", "guide.txt", [1])
    client.delete("/api/documents/guide.txt", headers=A)
    assert fake.deleted[-1] == ("tenant-a", "guide.txt", [1])


def test_not_covered_answer_falls_back():
    data = {"answer": {"answerText": "The provided documents do not contain information about refunds.",
                       "references": [{"chunkInfo": {"content": "x", "documentMetadata": {"structData": {"tenant_id": "t1", "file_name": "a.pdf", "page": 1}}}}]}}
    assert not VertexAskSearch._parse(data, "t1").grounded