"""Import a whole public website (help centre, FAQ, policies) as one document.

Pages are found from the site's sitemap (robots.txt "Sitemap:" or /sitemap.xml),
else by following same-site links from the start page. Only pages under the start
URL's path are taken, robots.txt Disallow rules for all agents are respected, and
every fetch goes through the same private/metadata address checks as single-page
import (ingest.fetch_raw).

Each web page becomes one "page" of the document, so citations point at it and
doc meta keeps page_urls to link back. A registry of imported sites lets a weekly
job (POST /api/cron/refresh-sites) re-crawl them.
"""
from __future__ import annotations

import logging
import os
import re
import threading
import time
import urllib.parse
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from html.parser import HTMLParser
from typing import Callable, Protocol

from fastapi import HTTPException

from backend.ingest import _decode, fetch_raw, html_to_text

log = logging.getLogger("ragaas")

MAX_PAGES = 40
TIME_BUDGET_S = 100            # Cloud Run allows 300 s; leave room to index
PARALLEL = 6
SKIP_EXT = re.compile(r"\.(png|jpe?g|gif|svg|webp|ico|css|js|json|zip|pdf|docx?|xlsx?|pptx?|mp[34]|woff2?|ttf)$", re.I)

Fetch = Callable[[str], tuple[str, str, bytes]]


class _Links(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.hrefs: list[str] = []

    def handle_starttag(self, tag, attrs):
        if tag == "a":
            href = dict(attrs).get("href")
            if href:
                self.hrefs.append(href)


def _norm(url: str) -> str:
    parts = urllib.parse.urlsplit(url)
    path = parts.path or "/"
    return urllib.parse.urlunsplit((parts.scheme, parts.netloc.lower(), path, parts.query, ""))


def _in_scope(url: str, root: urllib.parse.SplitResult) -> bool:
    p = urllib.parse.urlsplit(url)
    if p.scheme not in ("http", "https") or p.netloc.lower() != root.netloc.lower():
        return False
    prefix = root.path.rsplit("/", 1)[0] + "/" if not root.path.endswith("/") else root.path
    return p.path.startswith(prefix) and not SKIP_EXT.search(p.path)


def _robots(root: urllib.parse.SplitResult, fetch: Fetch) -> tuple[list[str], list[str]]:
    """(disallowed path prefixes for '*', sitemap URLs)."""
    try:
        _, _, body = fetch(f"{root.scheme}://{root.netloc}/robots.txt")
    except HTTPException:
        return [], []
    disallow, sitemaps, applies = [], [], False
    for raw in _decode(body).splitlines():
        line = raw.split("#", 1)[0].strip()
        if not line or ":" not in line:
            continue
        key, val = (x.strip() for x in line.split(":", 1))
        key = key.lower()
        if key == "user-agent":
            applies = val == "*"
        elif key == "disallow" and applies and val:
            disallow.append(val)
        elif key == "sitemap":
            sitemaps.append(val)
    return disallow, sitemaps


def _sitemap_urls(urls: list[str], fetch: Fetch, limit: int) -> list[str]:
    found: list[str] = []
    queue = list(urls)
    seen = set()
    while queue and len(found) < limit * 4 and len(seen) < 6:
        sm = queue.pop(0)
        if sm in seen:
            continue
        seen.add(sm)
        try:
            _, _, body = fetch(sm)
            root = ET.fromstring(body)
        except Exception:
            continue
        for el in root.iter():
            if el.tag.endswith("loc") and el.text:
                loc = el.text.strip()
                (queue if loc.endswith(".xml") else found).append(loc)
    return found


def crawl(start_url: str, max_pages: int = MAX_PAGES, fetch: Fetch | None = None,
          budget_s: float = TIME_BUDGET_S) -> list[tuple[str, str, str]]:
    """[(url, title, text)] for up to max_pages pages of the site, start page first."""
    fetch = fetch or (lambda u: fetch_raw(u, accept="text/html,application/xml,text/xml,*/*"))
    started = time.monotonic()
    first_url, _ctype, body = fetch(start_url)
    root = urllib.parse.urlsplit(first_url)
    disallow, sitemaps = _robots(root, fetch)
    allowed = lambda u: _in_scope(u, root) and not any(urllib.parse.urlsplit(u).path.startswith(d) for d in disallow)

    pages: dict[str, tuple[str, str]] = {}
    title, text = html_to_text(_decode(body))
    if text.strip():
        pages[_norm(first_url)] = (title, text)

    candidates = [u for u in _sitemap_urls(sitemaps or [f"{root.scheme}://{root.netloc}/sitemap.xml"], fetch, max_pages)
                  if allowed(u)]
    frontier = [_norm(u) for u in candidates]
    links = _Links()
    links.feed(_decode(body))
    frontier += [_norm(urllib.parse.urljoin(first_url, h)) for h in links.hrefs]
    queue = [u for u in dict.fromkeys(frontier) if allowed(u) and u not in pages]
    lock = threading.Lock()
    depth_two: list[str] = []

    def visit(url: str) -> None:
        if time.monotonic() - started > budget_s:
            return
        try:
            final, ctype, raw = fetch(url)
        except HTTPException:
            return
        if "html" not in ctype:
            return
        html = _decode(raw)
        t, x = html_to_text(html)
        lp = _Links()
        lp.feed(html)
        with lock:
            if x.strip() and len(pages) < max_pages:
                pages.setdefault(_norm(final), (t, x))
            depth_two.extend(_norm(urllib.parse.urljoin(final, h)) for h in lp.hrefs)

    for round_ in range(2):          # start page's links (and sitemap), then one level deeper
        batch = [u for u in queue if u not in pages][: max(0, max_pages - len(pages))]
        if not batch or time.monotonic() - started > budget_s:
            break
        with ThreadPoolExecutor(max_workers=PARALLEL) as pool:
            list(pool.map(visit, batch))
        queue = [u for u in dict.fromkeys(depth_two) if allowed(u) and u not in pages]
        depth_two.clear()
    if not pages:
        raise HTTPException(status_code=422, detail="No readable pages found on that site.")
    ordered = [(_norm(first_url), *pages.pop(_norm(first_url)))] if _norm(first_url) in pages else []
    ordered += [(u, t, x) for u, (t, x) in pages.items()]
    return ordered[:max_pages]


def site_file_name(url: str) -> str:
    p = urllib.parse.urlsplit(url)
    slug = re.sub(r"[^a-z0-9]+", "-", f"{p.netloc}{p.path}".lower()).strip("-")[:70] or "site"
    return f"site-{slug}.html"


# ── Registry of imported sites (for the weekly refresh) ──────────────────────
class SiteStore(Protocol):
    def save(self, tenant_id: str, file_name: str, url: str, max_pages: int) -> None: ...
    def remove(self, tenant_id: str, file_name: str) -> None: ...
    def all(self) -> list[dict]: ...


class MemorySiteStore:
    def __init__(self) -> None:
        self.rows: dict[tuple[str, str], dict] = {}

    def save(self, tenant_id: str, file_name: str, url: str, max_pages: int) -> None:
        self.rows[(tenant_id, file_name)] = {"tenant_id": tenant_id, "file_name": file_name, "url": url,
                                            "max_pages": max_pages, "refreshed_at": datetime.now(timezone.utc).isoformat()}

    def remove(self, tenant_id: str, file_name: str) -> None:
        self.rows.pop((tenant_id, file_name), None)

    def all(self) -> list[dict]:
        return list(self.rows.values())


class FirestoreSiteStore:
    def __init__(self, db) -> None:
        self._db = db

    def _doc(self, tenant_id: str, file_name: str):
        return self._db.collection("website_sources").document(f"{tenant_id}__{file_name}"[:1400])

    def save(self, tenant_id: str, file_name: str, url: str, max_pages: int) -> None:
        self._doc(tenant_id, file_name).set({"tenant_id": tenant_id, "file_name": file_name, "url": url,
                                             "max_pages": max_pages,
                                             "refreshed_at": datetime.now(timezone.utc).isoformat()})

    def remove(self, tenant_id: str, file_name: str) -> None:
        self._doc(tenant_id, file_name).delete()

    def all(self) -> list[dict]:
        return [d.to_dict() or {} for d in self._db.collection("website_sources").stream()]


def create_site_store(env: str) -> SiteStore:
    if os.getenv("RAGAAS_USE_MEMORY_STORE") == "1":
        return MemorySiteStore()
    if env == "production":
        try:
            from firebase_admin import firestore as fa_firestore
            return FirestoreSiteStore(fa_firestore.client())
        except Exception as exc:
            log.warning("Firestore site store init failed (%s); using memory", exc)
    return MemorySiteStore()
