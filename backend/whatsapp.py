"""WhatsApp Cloud API (Meta) helpers: webhook signature, payload parsing, message
formatting and sending. No FastAPI here; routes live in main.py.

Env:
  WHATSAPP_ACCESS_TOKEN   token of the Meta app's system user (or the 24h test token)
  WHATSAPP_APP_SECRET     Meta app secret; signs every webhook (X-Hub-Signature-256)
  WHATSAPP_VERIFY_TOKEN   any string you choose; Meta echoes it when subscribing the webhook
  WHATSAPP_GRAPH_VERSION  Graph API version, default v21.0
"""
from __future__ import annotations

import hashlib
import hmac
import json
import logging
import os
import re
import urllib.request
from dataclasses import dataclass

log = logging.getLogger("ragaas")

MAX_BODY = 4096            # WhatsApp text message limit
GRAPH = "https://graph.facebook.com"


def access_token() -> str:
    return os.getenv("WHATSAPP_ACCESS_TOKEN", "").strip()


def app_secret() -> str:
    return os.getenv("WHATSAPP_APP_SECRET", "").strip()


def verify_token() -> str:
    return os.getenv("WHATSAPP_VERIFY_TOKEN", "").strip()


def graph_version() -> str:
    return os.getenv("WHATSAPP_GRAPH_VERSION", "v21.0")


def signature_ok(body: bytes, header: str | None, secret: str) -> bool:
    """X-Hub-Signature-256 is "sha256=" + HMAC-SHA256(app secret, raw body)."""
    if not secret or not header or not header.startswith("sha256="):
        return False
    expected = "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, header)


def digits(phone: str) -> str:
    """WhatsApp IDs are the international number as digits only (no +, spaces)."""
    return re.sub(r"\D", "", phone or "")


def mask(phone: str) -> str:
    d = digits(phone)
    return f"•••• {d[-4:]}" if len(d) >= 4 else "••••"


@dataclass(frozen=True)
class Incoming:
    phone_number_id: str     # the business number that received it (→ workspace)
    wa_id: str               # sender's WhatsApp ID (their number, digits)
    name: str
    message_id: str
    type: str
    text: str


def parse(payload: dict) -> list[Incoming]:
    """Messages in a webhook payload. Status updates (sent/delivered/read) are ignored."""
    out: list[Incoming] = []
    for entry in payload.get("entry", []) or []:
        for change in entry.get("changes", []) or []:
            value = change.get("value") or {}
            pnid = str((value.get("metadata") or {}).get("phone_number_id", ""))
            names = {c.get("wa_id"): (c.get("profile") or {}).get("name", "") for c in value.get("contacts", []) or []}
            for m in value.get("messages", []) or []:
                mtype = m.get("type", "")
                if mtype == "text":
                    text = (m.get("text") or {}).get("body", "")
                elif mtype == "button":
                    text = (m.get("button") or {}).get("text", "")
                else:
                    text = ""
                sender = digits(str(m.get("from", "")))
                out.append(Incoming(pnid, sender, names.get(sender, ""), str(m.get("id", "")), mtype, text.strip()))
    return out


def to_whatsapp(md: str) -> str:
    """Markdown from the model → WhatsApp formatting (*bold*, _italic_, • bullets)."""
    t = md.replace("\r\n", "\n")
    t = re.sub(r"^#{1,6}\s*(.+)$", r"*\1*", t, flags=re.M)               # headings → bold line
    t = re.sub(r"\*\*(.+?)\*\*", r"*\1*", t)                              # **bold** → *bold*
    t = re.sub(r"__(.+?)__", r"_\1_", t)
    t = re.sub(r"^\s*[-*]\s+", "• ", t, flags=re.M)                       # bullets
    t = re.sub(r"\[([^\]]+)\]\((https?://[^)]+)\)", r"\1 (\2)", t)         # links
    return re.sub(r"\n{3,}", "\n\n", t).strip()


def split(text: str, limit: int = MAX_BODY) -> list[str]:
    """Split at paragraph, then line, then word boundaries so nothing is cut mid-word."""
    parts: list[str] = []
    rest = text.strip()
    while len(rest) > limit:
        cut = max(rest.rfind("\n\n", 0, limit), rest.rfind("\n", 0, limit), rest.rfind(" ", 0, limit))
        if cut <= 0:
            cut = limit
        parts.append(rest[:cut].rstrip())
        rest = rest[cut:].lstrip()
    if rest:
        parts.append(rest)
    return parts


def _post(phone_number_id: str, body: dict) -> None:
    token = access_token()
    if not token:
        log.warning("whatsapp send skipped: WHATSAPP_ACCESS_TOKEN not set")
        return
    req = urllib.request.Request(
        f"{GRAPH}/{graph_version()}/{phone_number_id}/messages",
        data=json.dumps(body).encode(),
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        method="POST",
    )
    urllib.request.urlopen(req, timeout=10)


def send_text(phone_number_id: str, to: str, text: str) -> None:
    for part in split(text):
        _post(phone_number_id, {
            "messaging_product": "whatsapp", "recipient_type": "individual", "to": to,
            "type": "text", "text": {"preview_url": False, "body": part},
        })


def mark_read(phone_number_id: str, message_id: str) -> None:
    """Blue ticks plus a typing indicator while the answer is written. Best effort."""
    try:
        _post(phone_number_id, {
            "messaging_product": "whatsapp", "status": "read", "message_id": message_id,
            "typing_indicator": {"type": "text"},
        })
    except Exception as exc:  # older API versions reject typing_indicator; reads still matter less than the answer
        log.info("whatsapp mark_read failed: %s", exc)
