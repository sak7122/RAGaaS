"""Certificate of completion PDF (Academy M4), rendered with fpdf2."""
from __future__ import annotations

import hashlib
from datetime import datetime

from fpdf import FPDF


def certificate_id(tenant_id: str, uid: str, path_id: str, certified_at: str) -> str:
    """Stable, unguessable reference printed on the certificate."""
    digest = hashlib.sha256(f"{tenant_id}|{uid}|{path_id}|{certified_at}".encode()).hexdigest()
    return f"{digest[:4]}-{digest[4:8]}-{digest[8:12]}".upper()


def _latin1(text: str) -> str:
    # Core PDF fonts are Latin-1; swap common typography, replace the rest.
    for a, b in (("‘", "'"), ("’", "'"), ("“", '"'), ("”", '"'),
                 ("–", "-"), ("—", "-"), ("…", "...")):
        text = text.replace(a, b)
    return text.encode("latin-1", "replace").decode("latin-1")


def _date(iso: str | None) -> str:
    if not iso:
        return ""
    try:
        return datetime.fromisoformat(str(iso).replace("Z", "+00:00")).strftime("%d %B %Y").lstrip("0")
    except ValueError:
        return ""


def render_certificate(*, company: str, learner: str, path_title: str, score: float | None,
                       completed_at: str | None, certified_at: str, certified_by: str | None,
                       cert_id: str) -> bytes:
    pdf = FPDF(orientation="L", unit="mm", format="A4")
    pdf.set_auto_page_break(False)
    pdf.set_title(_latin1(f"Certificate - {path_title}"))
    pdf.set_author("RAGaaS Academy")
    pdf.set_margins(30, 30, 30)
    pdf.add_page()
    w, h = pdf.w, pdf.h

    pdf.set_draw_color(0, 102, 204)
    pdf.set_line_width(1.2)
    pdf.rect(12, 12, w - 24, h - 24)
    pdf.set_line_width(0.3)
    pdf.rect(16, 16, w - 32, h - 32)

    def line(text: str, size: float, style: str = "", color: tuple[int, int, int] = (29, 29, 31),
             gap: float = 4) -> None:
        pdf.set_font("Helvetica", style, size)
        pdf.set_text_color(*color)
        pdf.multi_cell(w - 60, size * 0.5, _latin1(text), align="C", new_x="LMARGIN", new_y="NEXT")
        pdf.ln(gap)

    pdf.set_xy(30, 38)
    line(company.upper(), 12, "B", (0, 102, 204), 10)
    line("Certificate of Completion", 34, "B", gap=12)
    line("This certifies that", 13, color=(110, 110, 115), gap=4)
    line(learner, 26, "B", gap=8)
    line("has successfully completed", 13, color=(110, 110, 115), gap=4)
    line(path_title, 20, "B", gap=12)

    details = [d for d in (
        f"Score {round(score * 100)}%" if score is not None else "",
        f"Completed {_date(completed_at)}" if completed_at else "",
        f"Certified {_date(certified_at)}",
        f"Signed off by {certified_by}" if certified_by else "",
    ) if d]
    line("  |  ".join(details), 11, color=(110, 110, 115), gap=0)

    pdf.set_xy(30, h - 34)
    pdf.set_font("Helvetica", "", 9)
    pdf.set_text_color(110, 110, 115)
    pdf.cell(w - 60, 5, _latin1(f"Certificate ID {cert_id}  |  Issued by {company} with RAGaaS Academy"),
             align="C")
    return bytes(pdf.output())
