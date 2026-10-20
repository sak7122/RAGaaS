"""Turn an uploaded file into searchable chunks: [{page, chunk_index, text}].

Text formats are parsed locally. Scans, photos and recordings are read by the
generator's `transcribe(bytes, mime)` (Gemini in production), so a scanned PDF, a
phone photo of a notice or a voice memo all become searchable text.
"""
from __future__ import annotations

import csv
import io
import ipaddress
import logging
import re
import socket
import urllib.parse
from html.parser import HTMLParser
from typing import Callable

from fastapi import HTTPException

log = logging.getLogger("ragaas")

PDF_MAGIC = b"%PDF"
ZIP_MAGIC = b"PK\x03\x04"
# Gemini reads inline files up to ~20 MB per request.
MAX_TRANSCRIBE_BYTES = 19 * 1024 * 1024
ROWS_PER_CHUNK = 25

IMAGE_TYPES = {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "webp": "image/webp",
               "heic": "image/heic", "heif": "image/heif"}
AUDIO_TYPES = {"mp3": "audio/mpeg", "wav": "audio/wav", "m4a": "audio/mp4", "aac": "audio/aac",
               "ogg": "audio/ogg", "opus": "audio/ogg", "flac": "audio/flac", "webm": "audio/webm"}
TEXT_TYPES = {"txt", "md", "markdown"}
HTML_TYPES = {"html", "htm"}
SUPPORTED = (["pdf", "docx", "xlsx", "csv", "pptx"] + sorted(TEXT_TYPES | HTML_TYPES)
             + sorted(IMAGE_TYPES) + sorted(AUDIO_TYPES))
SUPPORTED_LABEL = "PDF, Word, Excel, CSV, PowerPoint, text, Markdown, HTML, photos (JPG/PNG) or audio (MP3/M4A/WAV)"

Transcriber = Callable[[bytes, str], str] | None


def chunk_text(text: str, chunk_size: int = 300, overlap: int = 50) -> list[str]:
    words = text.split()
    chunks: list[str] = []
    start = 0
    while start < len(words):
        end = min(start + chunk_size, len(words))
        chunks.append(" ".join(words[start:end]))
        if end == len(words):
            break
        start += chunk_size - overlap
    return chunks or [""]


def _pages_to_chunks(pages: list[tuple[int, str]]) -> list[dict]:
    out = []
    for page, text in pages:
        for idx, chunk in enumerate(chunk_text(text)):
            if chunk.strip():
                out.append({"page": page, "chunk_index": idx, "text": chunk})
    return out


def _need(result: list[dict], what: str) -> list[dict]:
    if not result:
        raise HTTPException(status_code=422, detail=f"No readable text found in this {what}.")
    return result


def _ext(file_name: str) -> str:
    return file_name.rsplit(".", 1)[-1].lower() if "." in file_name else ""


# ── Transcription (scans, photos, audio) ─────────────────────────────────────
PAGE_MARK = re.compile(r"^\s*=+\s*page\s+(\d+)\s*=+\s*$", re.I | re.M)


def _transcribe(content: bytes, mime: str, transcribe: Transcriber, what: str) -> str:
    if transcribe is None:
        raise HTTPException(status_code=422, detail=f"Reading {what} needs the AI reader, which isn't available here.")
    if len(content) > MAX_TRANSCRIBE_BYTES:
        raise HTTPException(status_code=413, detail=f"{what.capitalize()} files can be up to 19 MB.")
    try:
        return transcribe(content, mime)
    except HTTPException:
        raise
    except Exception as exc:
        log.warning("transcribe failed mime=%s: %s", mime, exc)
        raise HTTPException(status_code=502, detail=f"Couldn't read this {what}. Try again, or upload a clearer file.")


def _scanned_pdf(content: bytes, transcribe: Transcriber) -> list[dict]:
    text = _transcribe(content, "application/pdf", transcribe, "scanned PDF")
    # The reader is asked to mark pages as "=== Page N ===".
    parts = PAGE_MARK.split(text)
    if len(parts) > 1:
        pages = [(int(parts[i]), parts[i + 1]) for i in range(1, len(parts) - 1, 2)]
    else:
        pages = [(1, text)]
    return _need(_pages_to_chunks(pages), "scanned PDF")


# ── Local parsers ─────────────────────────────────────────────────────────────
def _pdf(content: bytes, transcribe: Transcriber) -> list[dict]:
    from pypdf import PdfReader
    try:
        reader = PdfReader(io.BytesIO(content))
        pages = [(n, (p.extract_text() or "").strip()) for n, p in enumerate(reader.pages, start=1)]
    except Exception as exc:
        log.warning("PDF parse failed: %s", exc)
        raise HTTPException(status_code=400, detail="Could not parse PDF: the file may be corrupted or encrypted.")
    result = _pages_to_chunks(pages)
    if result:
        return result
    # No selectable text: a scanned or image-only PDF. Read it with OCR.
    return _scanned_pdf(content, transcribe)


def _docx(content: bytes) -> list[dict]:
    from docx import Document
    try:
        doc = Document(io.BytesIO(content))
        parts = [p.text for p in doc.paragraphs]
        for table in doc.tables:
            for row in table.rows:
                parts.append(" | ".join(cell.text for cell in row.cells))
    except Exception as exc:
        log.warning("DOCX parse failed: %s", exc)
        raise HTTPException(status_code=400, detail=(
            "Could not parse Word document: the file may be corrupted. Legacy .doc isn't supported; save as .docx."))
    full_text = "\n".join(t for t in parts if t and t.strip())
    return _need(_pages_to_chunks([(1, full_text)]), "Word document")


def _rows_to_chunks(sheet_no: int, sheet_name: str, rows: list[list[str]]) -> list[dict]:
    """Each row keeps its column headers ("Item: Crown | Price: 450") so a single
    chunk still makes sense on its own."""
    rows = [[(c or "").strip() for c in r] for r in rows]
    rows = [r for r in rows if any(r)]
    if not rows:
        return []
    header, body = rows[0], rows[1:] or []
    if not body:                       # a one-row sheet: no header to pair with
        header, body = [], rows
    lines = []
    for r in body:
        if header:
            cells = [f"{h or f'Column {i + 1}'}: {v}" for i, (h, v) in enumerate(zip(header, r)) if v]
        else:
            cells = [v for v in r if v]
        if cells:
            lines.append(" | ".join(cells))
    out = []
    title = f"Sheet: {sheet_name}\n" if sheet_name else ""
    for idx in range(0, len(lines), ROWS_PER_CHUNK):
        out.append({"page": sheet_no, "chunk_index": idx // ROWS_PER_CHUNK,
                    "text": title + "\n".join(lines[idx:idx + ROWS_PER_CHUNK])})
    return out


def _xlsx(content: bytes) -> list[dict]:
    from openpyxl import load_workbook
    try:
        wb = load_workbook(io.BytesIO(content), read_only=True, data_only=True)
    except Exception as exc:
        log.warning("XLSX parse failed: %s", exc)
        raise HTTPException(status_code=400, detail="Could not open this Excel file. Save it as .xlsx and try again.")
    out: list[dict] = []
    for n, ws in enumerate(wb.worksheets, start=1):
        rows = [["" if v is None else str(v) for v in row] for row in ws.iter_rows(values_only=True)]
        out += _rows_to_chunks(n, ws.title, rows)
    return _need(out, "spreadsheet")


def _decode(content: bytes) -> str:
    for enc in ("utf-8-sig", "utf-16", "cp1252", "latin-1"):
        try:
            return content.decode(enc)
        except UnicodeDecodeError:
            continue
    return content.decode("utf-8", errors="replace")


def _csv(content: bytes) -> list[dict]:
    text = _decode(content)
    try:
        dialect = csv.Sniffer().sniff(text[:4096], delimiters=",;\t|")
    except csv.Error:
        dialect = csv.excel
    rows = list(csv.reader(io.StringIO(text), dialect))
    return _need(_rows_to_chunks(1, "", rows), "CSV file")


def _pptx(content: bytes) -> list[dict]:
    from pptx import Presentation
    try:
        deck = Presentation(io.BytesIO(content))
    except Exception as exc:
        log.warning("PPTX parse failed: %s", exc)
        raise HTTPException(status_code=400, detail="Could not open this PowerPoint file. Save it as .pptx and try again.")
    pages = []
    for n, slide in enumerate(deck.slides, start=1):
        parts = []
        for shape in slide.shapes:
            if shape.has_text_frame:
                parts.append(shape.text_frame.text)
            if getattr(shape, "has_table", False) and shape.has_table:
                for row in shape.table.rows:
                    parts.append(" | ".join(c.text for c in row.cells))
        if slide.has_notes_slide:
            parts.append(slide.notes_slide.notes_text_frame.text)
        pages.append((n, "\n".join(p for p in parts if p.strip())))
    return _need(_pages_to_chunks(pages), "presentation")


class _TextOnly(HTMLParser):
    SKIP = {"script", "style", "noscript", "svg", "nav", "footer", "header", "form"}

    def __init__(self) -> None:
        super().__init__()
        self.parts: list[str] = []
        self.title = ""
        self._skip = 0
        self._in_title = False

    def handle_starttag(self, tag, attrs):
        if tag in self.SKIP:
            self._skip += 1
        if tag == "title":
            self._in_title = True
        if tag in {"p", "br", "li", "h1", "h2", "h3", "h4", "tr", "div", "section"}:
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag in self.SKIP and self._skip:
            self._skip -= 1
        if tag == "title":
            self._in_title = False

    def handle_data(self, data):
        if self._in_title:
            self.title += data
        elif not self._skip:
            self.parts.append(data)


def html_to_text(html: str) -> tuple[str, str]:
    p = _TextOnly()
    p.feed(html)
    text = re.sub(r"[ \t]+", " ", "".join(p.parts))
    text = re.sub(r"\n\s*\n+", "\n\n", text).strip()
    return p.title.strip(), text


def _html(content: bytes) -> list[dict]:
    _, text = html_to_text(_decode(content))
    return _need(_pages_to_chunks([(1, text)]), "web page")


def _text(content: bytes) -> list[dict]:
    return _need(_pages_to_chunks([(1, _decode(content))]), "text file")


def extract_chunks(content: bytes, file_name: str, transcribe: Transcriber = None) -> list[dict]:
    ext = _ext(file_name)
    if content[:4] == PDF_MAGIC:
        return _pdf(content, transcribe)
    if content[:4] == ZIP_MAGIC:
        if ext == "docx":
            return _docx(content)
        if ext == "xlsx":
            return _xlsx(content)
        if ext == "pptx":
            return _pptx(content)
    elif ext == "csv":
        return _csv(content)
    elif ext in TEXT_TYPES:
        return _text(content)
    elif ext in HTML_TYPES:
        return _html(content)
    elif ext in IMAGE_TYPES:
        text = _transcribe(content, IMAGE_TYPES[ext], transcribe, "photo")
        return _need(_pages_to_chunks([(1, text)]), "photo")
    elif ext in AUDIO_TYPES:
        text = _transcribe(content, AUDIO_TYPES[ext], transcribe, "recording")
        return _need(_pages_to_chunks([(1, text)]), "recording")
    raise HTTPException(status_code=400, detail=f"Unsupported file type. Upload {SUPPORTED_LABEL}.")


# ── Web page import (with SSRF protection) ───────────────────────────────────
MAX_PAGE_BYTES = 5 * 1024 * 1024


def _public_host(host: str) -> bool:
    """True only if every address the host resolves to is public internet: blocks
    localhost, private ranges and the cloud metadata server (169.254.169.254)."""
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror:
        return False
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if (ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved
                or ip.is_multicast or ip.is_unspecified):
            return False
    return True


def fetch_page(url: str, opener=None) -> tuple[str, str, str]:
    """(final_url, title, text) for a public web page. Follows up to 3 redirects,
    re-checking each hop."""
    import urllib.request

    class _NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *a, **k):
            return None

    opener = opener or urllib.request.build_opener(_NoRedirect)
    for _ in range(4):
        parts = urllib.parse.urlsplit(url)
        if parts.scheme not in ("http", "https") or not parts.hostname:
            raise HTTPException(status_code=400, detail="Enter a full web address starting with https://")
        if not _public_host(parts.hostname):
            raise HTTPException(status_code=400, detail="That address isn't a public web page.")
        req = urllib.request.Request(url, headers={"User-Agent": "RAGaaS-importer/1.0", "Accept": "text/html,*/*"})
        try:
            resp = opener.open(req, timeout=15)
        except urllib.error.HTTPError as e:
            if e.code in (301, 302, 303, 307, 308) and e.headers.get("Location"):
                url = urllib.parse.urljoin(url, e.headers["Location"])
                continue
            raise HTTPException(status_code=400, detail=f"The page answered with an error ({e.code}).")
        except Exception as exc:
            log.info("fetch_page failed %s: %s", url, exc)
            raise HTTPException(status_code=400, detail="Couldn't reach that page.")
        ctype = resp.headers.get("Content-Type", "")
        if "html" not in ctype and "text" not in ctype:
            raise HTTPException(status_code=400, detail="That address isn't a web page. Upload files directly instead.")
        body = resp.read(MAX_PAGE_BYTES + 1)
        if len(body) > MAX_PAGE_BYTES:
            raise HTTPException(status_code=413, detail="That page is too large to import.")
        title, text = html_to_text(_decode(body))
        if not text.strip():
            raise HTTPException(status_code=422, detail="No readable text on that page.")
        return url, title, text
    raise HTTPException(status_code=400, detail="That page redirects too many times.")
