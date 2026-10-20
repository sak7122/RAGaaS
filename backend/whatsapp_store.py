"""State for the WhatsApp channel.

- numbers:  business phone_number_id → workspace (one number per workspace)
- links:    a member's WhatsApp ID (wa_id) → workspace + member, proven by a code
            shown in the signed-in app and sent from that phone
- seen:     message IDs already handled (Meta retries webhooks)
- history:  last few turns per sender, so follow-up questions work
"""
from __future__ import annotations

import logging
import os
import secrets
import threading
from datetime import datetime, timedelta, timezone
from typing import Protocol

log = logging.getLogger("ragaas")

CODE_TTL = timedelta(minutes=15)
HISTORY_TTL = timedelta(minutes=30)
HISTORY_TURNS = 4


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(ts) -> str:
    return ts.isoformat() if hasattr(ts, "isoformat") else (ts or "")


def _new_code() -> str:
    return f"{secrets.randbelow(900000) + 100000}"


class WhatsAppStore(Protocol):
    def connect(self, phone_number_id: str, display_phone: str, tenant_id: str) -> None: ...
    def get_number(self, phone_number_id: str) -> dict | None: ...
    def list_numbers(self, tenant_id: str) -> list[dict]: ...
    def disconnect(self, phone_number_id: str, tenant_id: str) -> bool: ...
    def create_code(self, tenant_id: str, uid: str, email: str, phone: str) -> tuple[str, datetime]: ...
    def redeem_code(self, code: str, wa_id: str) -> dict | None: ...
    def get_link(self, wa_id: str) -> dict | None: ...
    def link_for_member(self, tenant_id: str, uid: str) -> dict | None: ...
    def unlink(self, wa_id: str) -> None: ...
    def claim_message(self, message_id: str) -> bool: ...
    def history(self, wa_id: str) -> list[dict]: ...
    def remember(self, wa_id: str, question: str, answer: str) -> None: ...
    def forget(self, wa_id: str) -> None: ...


class MemoryWhatsAppStore:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.numbers: dict[str, dict] = {}
        self.codes: dict[str, dict] = {}
        self.links: dict[str, dict] = {}
        self.seen: set[str] = set()
        self.turns: dict[str, dict] = {}

    def connect(self, phone_number_id: str, display_phone: str, tenant_id: str) -> None:
        self.numbers[phone_number_id] = {"phone_number_id": phone_number_id, "display_phone": display_phone,
                                         "tenant_id": tenant_id, "connected_at": _now().isoformat()}

    def get_number(self, phone_number_id: str) -> dict | None:
        return self.numbers.get(phone_number_id)

    def list_numbers(self, tenant_id: str) -> list[dict]:
        return [n for n in self.numbers.values() if n["tenant_id"] == tenant_id]

    def disconnect(self, phone_number_id: str, tenant_id: str) -> bool:
        n = self.numbers.get(phone_number_id)
        if not n or n["tenant_id"] != tenant_id:
            return False
        del self.numbers[phone_number_id]
        return True

    def create_code(self, tenant_id: str, uid: str, email: str, phone: str) -> tuple[str, datetime]:
        with self._lock:
            # One live code per member: a new request replaces the old one.
            for c in [c for c, v in self.codes.items() if v["tenant_id"] == tenant_id and v["uid"] == uid]:
                del self.codes[c]
            code = _new_code()
            while code in self.codes:
                code = _new_code()
            expires = _now() + CODE_TTL
            self.codes[code] = {"tenant_id": tenant_id, "uid": uid, "email": email, "phone": phone, "expires": expires}
            return code, expires

    def redeem_code(self, code: str, wa_id: str) -> dict | None:
        with self._lock:
            c = self.codes.get(code)
            if not c or c["expires"] < _now() or c["phone"] != wa_id:
                return None
            del self.codes[code]
            # A member has one linked phone; a phone belongs to one member.
            for w in [w for w, v in self.links.items() if v["tenant_id"] == c["tenant_id"] and v["uid"] == c["uid"]]:
                del self.links[w]
            link = {"wa_id": wa_id, "tenant_id": c["tenant_id"], "uid": c["uid"], "email": c["email"],
                    "linked_at": _now().isoformat()}
            self.links[wa_id] = link
            return link

    def get_link(self, wa_id: str) -> dict | None:
        return self.links.get(wa_id)

    def link_for_member(self, tenant_id: str, uid: str) -> dict | None:
        return next((v for v in self.links.values() if v["tenant_id"] == tenant_id and v["uid"] == uid), None)

    def unlink(self, wa_id: str) -> None:
        self.links.pop(wa_id, None)
        self.turns.pop(wa_id, None)

    def claim_message(self, message_id: str) -> bool:
        with self._lock:
            if message_id in self.seen:
                return False
            self.seen.add(message_id)
            return True

    def history(self, wa_id: str) -> list[dict]:
        h = self.turns.get(wa_id)
        if not h or h["at"] < _now() - HISTORY_TTL:
            return []
        return list(h["turns"])

    def remember(self, wa_id: str, question: str, answer: str) -> None:
        turns = self.history(wa_id) + [{"role": "user", "text": question[:2000]},
                                       {"role": "assistant", "text": answer[:2000]}]
        self.turns[wa_id] = {"turns": turns[-HISTORY_TURNS:], "at": _now()}

    def forget(self, wa_id: str) -> None:
        self.turns.pop(wa_id, None)


class FirestoreWhatsAppStore:
    def __init__(self, db) -> None:
        self._db = db

    def _c(self, name: str):
        return self._db.collection(name)

    def connect(self, phone_number_id: str, display_phone: str, tenant_id: str) -> None:
        self._c("whatsapp_numbers").document(phone_number_id).set(
            {"display_phone": display_phone, "tenant_id": tenant_id, "connected_at": _now()})

    def get_number(self, phone_number_id: str) -> dict | None:
        snap = self._c("whatsapp_numbers").document(phone_number_id).get()
        if not snap.exists:
            return None
        d = snap.to_dict() or {}
        return {"phone_number_id": snap.id, "display_phone": d.get("display_phone", ""),
                "tenant_id": d.get("tenant_id"), "connected_at": _iso(d.get("connected_at"))}

    def list_numbers(self, tenant_id: str) -> list[dict]:
        out = []
        for snap in self._c("whatsapp_numbers").where("tenant_id", "==", tenant_id).stream():
            d = snap.to_dict() or {}
            out.append({"phone_number_id": snap.id, "display_phone": d.get("display_phone", ""),
                        "connected_at": _iso(d.get("connected_at"))})
        return out

    def disconnect(self, phone_number_id: str, tenant_id: str) -> bool:
        ref = self._c("whatsapp_numbers").document(phone_number_id)
        snap = ref.get()
        if not snap.exists or (snap.to_dict() or {}).get("tenant_id") != tenant_id:
            return False
        ref.delete()
        return True

    def create_code(self, tenant_id: str, uid: str, email: str, phone: str) -> tuple[str, datetime]:
        col = self._c("whatsapp_codes")
        for snap in col.where("uid", "==", uid).stream():
            if (snap.to_dict() or {}).get("tenant_id") == tenant_id:
                snap.reference.delete()
        expires = _now() + CODE_TTL
        for _ in range(5):
            code = _new_code()
            try:
                col.document(code).create({"tenant_id": tenant_id, "uid": uid, "email": email,
                                           "phone": phone, "expires": expires})
                return code, expires
            except Exception:  # AlreadyExists: try another code
                continue
        raise RuntimeError("could not allocate a link code")

    def redeem_code(self, code: str, wa_id: str) -> dict | None:
        ref = self._c("whatsapp_codes").document(code)
        snap = ref.get()
        if not snap.exists:
            return None
        c = snap.to_dict() or {}
        exp = c.get("expires")
        if c.get("phone") != wa_id or (exp is not None and exp < _now()):
            return None
        ref.delete()
        links = self._c("whatsapp_links")
        for old in links.where("uid", "==", c["uid"]).stream():
            if (old.to_dict() or {}).get("tenant_id") == c["tenant_id"]:
                old.reference.delete()
        link = {"tenant_id": c["tenant_id"], "uid": c["uid"], "email": c.get("email", ""), "linked_at": _now()}
        links.document(wa_id).set(link)
        return {**link, "wa_id": wa_id, "linked_at": link["linked_at"].isoformat()}

    def get_link(self, wa_id: str) -> dict | None:
        snap = self._c("whatsapp_links").document(wa_id).get()
        if not snap.exists:
            return None
        d = snap.to_dict() or {}
        return {"wa_id": wa_id, "tenant_id": d.get("tenant_id"), "uid": d.get("uid"), "email": d.get("email", ""),
                "linked_at": _iso(d.get("linked_at"))}

    def link_for_member(self, tenant_id: str, uid: str) -> dict | None:
        for snap in self._c("whatsapp_links").where("uid", "==", uid).stream():
            d = snap.to_dict() or {}
            if d.get("tenant_id") == tenant_id:
                return {"wa_id": snap.id, "tenant_id": tenant_id, "uid": uid, "email": d.get("email", ""),
                        "linked_at": _iso(d.get("linked_at"))}
        return None

    def unlink(self, wa_id: str) -> None:
        self._c("whatsapp_links").document(wa_id).delete()
        self._c("whatsapp_history").document(wa_id).delete()

    def claim_message(self, message_id: str) -> bool:
        try:
            self._c("whatsapp_seen").document(message_id).create({"at": _now()})
            return True
        except Exception:   # AlreadyExists → a retry of a message we've handled
            return False

    def history(self, wa_id: str) -> list[dict]:
        snap = self._c("whatsapp_history").document(wa_id).get()
        if not snap.exists:
            return []
        d = snap.to_dict() or {}
        at = d.get("at")
        if at is None or at < _now() - HISTORY_TTL:
            return []
        return list(d.get("turns", []))

    def remember(self, wa_id: str, question: str, answer: str) -> None:
        turns = self.history(wa_id) + [{"role": "user", "text": question[:2000]},
                                       {"role": "assistant", "text": answer[:2000]}]
        self._c("whatsapp_history").document(wa_id).set({"turns": turns[-HISTORY_TURNS:], "at": _now()})

    def forget(self, wa_id: str) -> None:
        self._c("whatsapp_history").document(wa_id).delete()


def create_whatsapp_store(env: str) -> WhatsAppStore:
    if os.getenv("RAGAAS_USE_MEMORY_STORE") == "1":
        return MemoryWhatsAppStore()
    if env == "production":
        try:
            from firebase_admin import firestore as fa_firestore
            return FirestoreWhatsAppStore(fa_firestore.client())
        except Exception as exc:
            log.warning("Firestore whatsapp init failed (%s); using memory", exc)
    return MemoryWhatsAppStore()
