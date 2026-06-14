"""Minimal SMTP mailer for transactional invites.

Stdlib only (smtplib + email.message) — no extra deps. Designed for the
Gmail app-password path so it works without a domain or ESP:

    SMTP_HOST=smtp.gmail.com        # default
    SMTP_PORT=587                   # default (STARTTLS)
    SMTP_USER=you@gmail.com         # the Gmail address
    SMTP_PASSWORD=<16-char app pwd> # Google account → Security → App passwords
    SMTP_FROM="RAGaaS <you@gmail.com>"   # optional, defaults to SMTP_USER

If SMTP is not configured, send_invite_email() returns False instead of
raising, so the invite still records and the caller falls back to
returning the link for manual sharing. The password is read from the
environment at send time and never logged.

Gmail limits: ~500 recipients/day on a free account — fine for invites.
"""
from __future__ import annotations

import logging
import os
import smtplib
from email.message import EmailMessage
from email.utils import formataddr

log = logging.getLogger("ragaas")


def smtp_configured() -> bool:
    return bool(os.getenv("SMTP_USER") and os.getenv("SMTP_PASSWORD"))


def _build_invite(to_email: str, invite_link: str, tenant_name: str,
                  inviter: str, role: str) -> EmailMessage:
    user = os.getenv("SMTP_USER", "")
    sender = os.getenv("SMTP_FROM") or formataddr(("RAGaaS", user))

    msg = EmailMessage()
    msg["Subject"] = f"You're invited to {tenant_name} on RAGaaS"
    msg["From"] = sender
    msg["To"] = to_email

    msg.set_content(
        f"{inviter} invited you to join the '{tenant_name}' workspace on "
        f"RAGaaS as a {role}.\n\n"
        f"Accept your invite:\n{invite_link}\n\n"
        f"RAGaaS lets your team ask your documents and get cited answers.\n\n"
        f"If you weren't expecting this, you can ignore this email."
    )
    msg.add_alternative(
        f"""\
<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:480px">
  <h2 style="margin:0 0 12px">You're invited to <b>{tenant_name}</b></h2>
  <p style="color:#444;line-height:1.5">
    {inviter} invited you to join the <b>{tenant_name}</b> workspace on
    RAGaaS as a <b>{role}</b>.
  </p>
  <p>
    <a href="{invite_link}"
       style="display:inline-block;background:#0071e3;color:#fff;
              text-decoration:none;padding:10px 18px;border-radius:8px">
      Accept invite
    </a>
  </p>
  <p style="color:#888;font-size:13px">
    Or paste this link: <br><a href="{invite_link}">{invite_link}</a>
  </p>
  <p style="color:#aaa;font-size:12px">
    If you weren't expecting this, you can ignore this email.
  </p>
</div>""",
        subtype="html",
    )
    return msg


def send_invite_email(to_email: str, invite_link: str, tenant_name: str,
                      inviter: str, role: str) -> bool:
    """Send the invite. Returns True if sent, False if SMTP unconfigured
    or the send failed (caller falls back to returning the link)."""
    if not smtp_configured():
        log.info("SMTP not configured — invite email skipped (link returned)")
        return False

    host = os.getenv("SMTP_HOST") or "smtp.gmail.com"   # empty env -> default
    port = int(os.getenv("SMTP_PORT") or "587")
    user = os.getenv("SMTP_USER", "")
    password = os.getenv("SMTP_PASSWORD", "")

    msg = _build_invite(to_email, invite_link, tenant_name, inviter, role)
    try:
        with smtplib.SMTP(host, port, timeout=15) as server:
            server.starttls()
            server.login(user, password)
            server.send_message(msg)
        log.info("invite email sent to=%s tenant=%s", to_email, tenant_name)
        return True
    except Exception as exc:  # never leak creds; log type/message only
        log.warning("invite email send failed to=%s: %s", to_email, exc)
        return False
