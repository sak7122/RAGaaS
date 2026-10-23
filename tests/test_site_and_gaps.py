"""Whole-site import (crawler, scope, robots.txt, refresh) and gap-answer suggestions."""
import os

os.environ["RAGAAS_USE_MEMORY_STORE"] = "1"

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

import backend.main as main
from backend import site_import
from backend.ask_search import AskAnswer, AskCitation
from backend.site_import import MemorySiteStore, crawl, site_file_name

client = TestClient(main.app)
A = {"Authorization": "Bearer tenant-a-token"}
VIEWER = {"Authorization": "Bearer demo-sales-token"}

SITE = {
    "https://help.example.com/robots.txt": ("text/plain", "User-agent: *\nDisallow: /help/private\nSitemap: https://help.example.com/sitemap.xml"),
    "https://help.example.com/sitemap.xml": ("application/xml",
        "<urlset><url><loc>https://help.example.com/help/returns</loc></url>"
        "<url><loc>https://help.example.com/help/private/secret</loc></url>"
        "<url><loc>https://help.example.com/blog/news</loc></url></urlset>"),
    "https://help.example.com/help/": ("text/html",
        "<html><title>Help centre</title><p>Welcome to help.</p><a href='/help/shipping'>Shipping</a>"
        "<a href='https://other.example.org/x'>Other</a><a href='/help/manual.pdf'>PDF</a></html>"),
    "https://help.example.com/help/returns": ("text/html", "<title>Returns</title><p>Returns are accepted within 30 days.</p>"),
    "https://help.example.com/help/shipping": ("text/html", "<title>Shipping</title><p>Orders ship in 2 days.</p><a href='/help/faq'>FAQ</a>"),
    "https://help.example.com/help/faq": ("text/html", "<title>FAQ</title><p>Answers to common questions.</p>"),
}


def fake_fetch(url):
    if url not in SITE:
        raise HTTPException(status_code=400, detail="404")
    ctype, body = SITE[url]
    return url, ctype, body.encode()


def test_crawl_uses_sitemap_links_scope_and_robots():
    pages = crawl("https://help.example.com/help/", max_pages=10, fetch=fake_fetch)
    urls = [u for u, _, _ in pages]
    assert urls[0] == "https://help.example.com/help/"                  # start page first
    assert "https://help.example.com/help/returns" in urls              # from the sitemap
    assert "https://help.example.com/help/shipping" in urls             # linked from the start page
    assert "https://help.example.com/help/faq" in urls                  # one level deeper
    assert not any("private" in u or "blog" in u or "other.example" in u or u.endswith(".pdf") for u in urls)


def test_crawl_respects_page_limit():
    assert len(crawl("https://help.example.com/help/", max_pages=2, fetch=fake_fetch)) == 2


def test_site_file_name_is_stable():
    assert site_file_name("https://help.example.com/help/") == "site-help-example-com-help.html"


@pytest.fixture
def fresh(monkeypatch):
    main.usage_store.reset()
    monkeypatch.setattr(main, "site_store", MemorySiteStore())
    monkeypatch.setattr(main, "ask_search", None)
    idx = main.load_index()
    idx["documents"] = [d for d in idx["documents"] if d["tenant_id"] != "tenant-a"]
    main.save_index(idx)
    monkeypatch.setattr(main, "crawl", lambda url, max_pages: crawl(url, max_pages, fetch=fake_fetch))


def test_import_site_makes_one_document_with_page_urls(fresh):
    assert client.post("/api/import-site", headers=VIEWER, json={"url": "https://help.example.com/help/"}).status_code == 403
    r = client.post("/api/import-site", headers=A, json={"url": "https://help.example.com/help/"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["pages"] == 4
    doc = next(d for d in client.get("/api/documents", headers=A).json() if d["file_name"] == body["file_name"])
    assert doc["kind"] == "website" and doc["page_urls"][0] == "https://help.example.com/help/"
    # The answer cites the right web page.
    ans = client.post("/api/chat", headers=A, json={"message": "when are returns accepted"}).json()
    page = ans["citations"][0]["page"]
    assert doc["page_urls"][page - 1] == "https://help.example.com/help/returns"


def test_refresh_and_cron(fresh, monkeypatch):
    name = client.post("/api/import-site", headers=A, json={"url": "https://help.example.com/help/"}).json()["file_name"]
    assert client.post(f"/api/documents/{name}/refresh", headers=A).json()["pages"] == 4
    assert client.post("/api/documents/nope.html/refresh", headers=A).status_code == 404
    assert client.post("/api/cron/refresh-sites").status_code == 403
    monkeypatch.setenv("CRON_TOKEN", "tok")
    main.site_store.rows[("tenant-a", name)]["refreshed_at"] = "2020-01-01T00:00:00+00:00"
    assert client.post("/api/cron/refresh-sites", headers={"X-Cron-Token": "tok"}).json() == {"refreshed": 1, "failed": 0}
    client.delete(f"/api/documents/{name}", headers=A)
    assert main.site_store.all() == []


# ── gap suggestions ───────────────────────────────────────────────────────────
class FakeAsk:
    def search(self, tenant_id, query, file_names=None, page_size=10, page_token=None):
        return {"results": [{"file_name": "billing.txt", "page": 2, "snippet": "<b>payment</b> terms", "passage": "Payment is due in 30 days."}],
                "counts": {}, "total": 1, "next_page_token": None, "corrected_query": None}

    def answer(self, tenant_id, question, file_names=None, session=None):
        return AskAnswer("Payments are due within 30 days (billing.txt p.2).", [AskCitation("billing.txt", 2, "x")], True)


def test_gap_suggest_with_vertex_strips_citation_markers(fresh, monkeypatch):
    monkeypatch.setattr(main, "ask_search", FakeAsk())
    r = client.get("/api/gaps/suggest", headers=A, params={"question": "Can patients pay in instalments?"}).json()
    assert r["closest"][0]["page"] == 2 and r["draft"] == "Payments are due within 30 days."
    assert client.get("/api/gaps/suggest", headers=VIEWER, params={"question": "x y z"}).status_code == 403


def test_gap_suggest_without_vertex_gives_closest_passages(fresh):
    client.post("/api/upload", headers=A, files={"file": ("billing.txt", b"Payment terms: invoices are due within 30 days.", "text/plain")})
    r = client.get("/api/gaps/suggest", headers=A, params={"question": "when are invoices due"}).json()
    assert r["draft"] is None and r["closest"][0]["file_name"] == "billing.txt"
    assert "<b>" in r["closest"][0]["snippet"]
