"""
Generate realistic company PDFs and seed local_data/index.json for tenant-demo.
Run from repo root: python scripts/seed_company_docs.py
"""
from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

from fpdf import FPDF

TENANT_ID  = "tenant-demo"
DATA_DIR   = Path("local_data")
UPLOAD_DIR = DATA_DIR / "uploads" / TENANT_ID
INDEX_FILE = DATA_DIR / "index.json"


# ── Chunker (mirrors backend logic) ──────────────────────────────────────────
def chunk_text(text: str, chunk_size: int = 512) -> list[str]:
    words = text.split()
    chunks, current, length = [], [], 0
    for word in words:
        if length + len(word) + 1 > chunk_size and current:
            chunks.append(" ".join(current))
            current, length = [], 0
        current.append(word)
        length += len(word) + 1
    if current:
        chunks.append(" ".join(current))
    return chunks or [""]


# ── Simple PDF writer ─────────────────────────────────────────────────────────
def make_pdf(file_path: Path, pages: list[tuple[int, str]]) -> None:
    pdf = FPDF()
    pdf.set_margins(18, 18, 18)
    pdf.set_auto_page_break(auto=True, margin=18)
    for _page_num, content in pages:
        pdf.add_page()
        # Title line (first line of content)
        lines = content.strip().splitlines()
        if lines:
            pdf.set_font("Helvetica", "B", 13)
            pdf.multi_cell(0, 8, lines[0])
            pdf.ln(3)
        if len(lines) > 1:
            pdf.set_font("Helvetica", "", 10)
            body = "\n".join(lines[1:])
            pdf.multi_cell(0, 6, body)
    pdf.output(str(file_path))


# ── Document content (plain ASCII — safe for Latin-1 PDF encoding) ────────────
DOCUMENTS: dict[str, list[tuple[int, str]]] = {

    "employee_handbook.pdf": [
        (1, """\
ACME Corp Employee Handbook
Version 4.2 | Effective: January 1, 2025
Welcome to ACME Corp. This handbook outlines policies, benefits, and expectations that govern
employment at ACME Corp. All employees must read and acknowledge this document within their
first five business days. Questions: hr@acmecorp.com or extension 1200.
Company mission: ACME Corp builds enterprise software for small and mid-sized businesses.
Core values: transparency, customer obsession, continuous learning, and accountability."""),

        (2, """\
Paid Time Off (PTO) Policy
All full-time employees receive 15 days of paid time off (PTO) per calendar year.
PTO accrues at 1.25 days per month from the first day of employment.
Unused PTO up to 5 days rolls over to the following year; the rest is forfeited December 31.
Sick Leave: employees receive 10 sick days per year. Sick leave does not roll over.
A doctor note is required for absences longer than 3 consecutive days.
Personal Days: each employee receives 5 personal days per year for observances or family events.
Personal days require 24 hours advance notice except in emergencies."""),

        (3, """\
Remote Work and Home Office Policy
ACME Corp is a hybrid workplace. Employees may work remotely up to 3 days per week.
Core collaboration hours are 10:00 AM to 3:00 PM Eastern Time. All employees must be
reachable on Slack and available for video calls during core hours.
Fully remote arrangements require manager and HR approval and are reviewed quarterly.
Home Office Stipend: employees approved for hybrid or remote work receive a one-time
home office equipment stipend of USD 500. Eligible expenses: monitor, chair, desk,
keyboard, webcam, and headset. Receipts must be submitted through Expensify within 60 days."""),

        (4, """\
Health and Wellness Benefits
ACME Corp provides comprehensive medical, dental, and vision insurance through BlueCross BlueShield.
Coverage begins on the first day of the month following your start date.
The company pays 80% of the employee premium and 60% of dependent premiums.
401(k) Retirement Plan: employees are eligible immediately upon hire. ACME Corp matches
100% of contributions up to 4% of base salary. The employer match vests on a 3-year graded
schedule: 33% after year one, 66% after year two, 100% after year three.
Professional Development: each employee receives USD 1,500 annually for courses,
conferences, certifications, or books. Manager pre-approval required."""),

        (5, """\
Code of Conduct and Ethics
All employees must act with integrity, respect, and professionalism at all times.
Harassment, discrimination, or retaliation of any kind will not be tolerated and may
result in immediate termination. Report concerns to hr@acmecorp.com or the anonymous
ethics hotline at ethics@acmecorp.com.
Conflicts of Interest: employees must disclose personal financial interests, outside
employment, or relationships that could create a conflict of interest. Disclosures are
submitted to the Legal department annually and upon any change of circumstance."""),

        (6, """\
Performance Review Process
ACME Corp conducts quarterly performance check-ins and an annual comprehensive review in December.
Reviews use a 1-5 rating scale. Employees scoring 4 or higher for two consecutive quarters
are eligible for a merit salary increase. Employees scoring 2 or below for two consecutive
quarters enter a Performance Improvement Plan (PIP).
Goal Setting: at the start of each quarter, employees and managers agree on 3 to 5 SMART goals.
Progress is tracked in Lattice, our performance management platform.
Mid-quarter check-ins occur in week 6 of each quarter."""),

        (7, """\
Equipment Policy
All full-time employees receive a company-issued laptop on their first day.
Standard configuration: MacBook Pro 14-inch (M3) or Lenovo ThinkPad X1 Carbon.
Employees must enroll their device in Kandji MDM within 24 hours of receipt.
Equipment must be returned within 5 business days of separation from the company.
Software Licenses: licensed software including Adobe Creative Suite, JetBrains IDEs, and Figma
are available through IT. Submit a software request ticket in Jira under the IT project.
Approval turnaround is 1 to 2 business days."""),

        (8, """\
Key Contacts and Emergency Procedures
Human Resources: hr@acmecorp.com, extension 1200
IT Helpdesk: it@acmecorp.com, extension 1100, helpdesk.acmecorp.com
Payroll: payroll@acmecorp.com, extension 1210
Ethics Hotline: ethics@acmecorp.com (anonymous)
Security Emergency: security@acmecorp.com, extension 911
Office Manager: facilities@acmecorp.com, extension 1050
Emergency Evacuation: in a fire or emergency proceed to the nearest stairwell exit.
Do not use elevators. Assembly point is the parking lot on the north side of Building A.
Floor wardens are identified by orange vests. Call 911 first, then notify Security."""),
    ],

    "it_security_policy.pdf": [
        (1, """\
IT Security Policy
Version 3.1 | Effective: March 1, 2025 | Owner: IT Security Team
Password Policy: all employee passwords must meet the following requirements.
Minimum length: 12 characters. Must include at least one uppercase letter, one lowercase letter,
one digit, and one special character such as !@#$%. Passwords must be changed every 90 days.
The last 10 passwords cannot be reused. Password sharing between employees is prohibited.
Multi-Factor Authentication (MFA): MFA is mandatory for all corporate accounts including
Google Workspace, GitHub, AWS, and the VPN. Approved MFA methods: Google Authenticator,
Authy, or a hardware security key (YubiKey). SMS-based MFA is not permitted."""),

        (2, """\
Device Management Policy
All devices accessing company resources must be enrolled in Kandji MDM before use.
Devices must auto-lock after 5 minutes of inactivity and require a PIN or biometric to unlock.
Full-disk encryption is mandatory: FileVault on macOS, BitLocker on Windows.
Personal devices (BYOD) may only access company resources through the approved VPN
and must comply with all security policies in this document.
VPN Usage: employees must connect to the company VPN when accessing internal systems
or cloud resources outside of the office network. The approved VPN client is Tailscale.
VPN credentials are provisioned by IT and must not be shared with others."""),

        (3, """\
Data Classification and Retention
All company data is classified into one of three tiers.
Confidential: customer PII, contracts, financial records, source code. Must be stored in
approved encrypted systems only. Must not be transmitted via personal email or unencrypted channels.
Internal: internal documentation, employee records, strategy documents.
Public: marketing materials, published blog posts.
Data Retention: customer data is retained for the contract duration plus 2 years.
Financial records are retained for 7 years per regulatory requirements.
Employee records are retained for 7 years after separation.
Email and Slack messages older than 3 years are automatically archived."""),

        (4, """\
Incident Response Plan
Any suspected security incident including phishing attempts, malware, unauthorized access,
or data breach must be reported to security@acmecorp.com within 1 hour of discovery.
Do not attempt to investigate or remediate independently.
The IT Security team will initiate the Incident Response Plan (IRP) within 15 minutes.
Phishing Response: if you receive a suspicious email, do not click any links or download
attachments. Forward the email as an attachment to phishing@acmecorp.com then delete it.
Never provide credentials in response to an email request, even if it appears to come
from a colleague or manager. Report all phishing attempts to IT immediately."""),

        (5, """\
Acceptable Use Policy
Company devices and network resources are for business use. Limited personal use is permitted
provided it does not interfere with job responsibilities or company security.
Strictly prohibited: accessing illegal content, installing unlicensed software, mining
cryptocurrency, bypassing security controls, storing company data on personal cloud storage
such as personal Google Drive, Dropbox, or iCloud.
Monitoring: employees should have no expectation of privacy on company devices or networks.
ACME Corp reserves the right to monitor network traffic, device activity, and corporate email
in accordance with applicable law. Monitoring is conducted to protect company assets."""),
    ],

    "onboarding_guide.pdf": [
        (1, """\
New Employee Onboarding Guide
Welcome to ACME Corp. This guide covers your first 30 days on the job.
Before Day One: you will receive a welcome email from hr@acmecorp.com three business days
before your start date. The email contains your first-day schedule, office location,
parking instructions, and a link to complete new hire paperwork through BambooHR.
Please complete all paperwork at least 24 hours before your start date.
Your manager will also reach out via email or phone to confirm your first day schedule
and answer any questions you have before starting."""),

        (2, """\
Required Tools and Software Setup
On your first day, IT will provision access to the following core tools.
Setup instructions are in the IT portal at helpdesk.acmecorp.com.
Slack: primary team communication, workspace is acmecorp.slack.com.
Notion: documentation, wikis, and meeting notes for the whole company.
GitHub: source code repository, organization is github.com/acmecorp.
Jira: project and task tracking at project.acmecorp.com.
Google Workspace: email (Gmail), calendar, Drive, Docs, and Sheets.
Zoom: video conferencing at meetings.acmecorp.com.
1Password: company password manager (teams plan, provisioned by IT).
Lattice: performance reviews and quarterly goal tracking."""),

        (3, """\
Day One Account Setup Checklist
Log in to your ACME Corp Google account (firstname.lastname@acmecorp.com).
Enable MFA on your Google Workspace account immediately.
Install Slack and join channels: general, announcements, and your team channel.
Install 1Password and save your new employee credentials.
Accept the GitHub organization invitation sent to your personal email.
Enroll your laptop in Kandji MDM (IT will walk you through this step).
Install Tailscale VPN and connect to the company network.
Complete I-9 and W-4 forms in BambooHR by end of day three.
Upload a profile photo to your Google and Slack accounts.
Schedule a 30-minute introduction meeting with your direct manager."""),

        (4, """\
First Week and First 30 Days Schedule
Day 1: HR orientation, IT setup session, manager introduction, office tour if in-person.
Day 2: Product overview presentation with the Product team, watch company intro videos in Notion.
Day 3: Shadow a team member for one full day, complete mandatory compliance training in TalentLMS.
Day 4: Engineering environment setup review for technical roles, attend first team standup.
Day 5: 30-day goal-setting session with your manager in Lattice, end-of-week retrospective.
By end of week 2: understand the team current sprint goals and backlog priorities.
By end of week 4: complete at least one small task, bug fix, or documentation contribution.
Your 30-day check-in with HR occurs at the end of your first month."""),

        (5, """\
Key Contacts for New Employees
Manager: see your offer letter for name and email address.
HR Business Partner: hr@acmecorp.com, extension 1200.
IT Helpdesk: it@acmecorp.com, extension 1100, helpdesk.acmecorp.com.
Payroll Questions: payroll@acmecorp.com, extension 1210.
Office Manager: facilities@acmecorp.com, extension 1050.
Security Issues: security@acmecorp.com, extension 911.
Benefits Enrollment: benefits@acmecorp.com.
Slack channels for questions: #ask-hr for HR questions, #ask-it for IT questions.
Buddy Program: every new hire is paired with an onboarding buddy for the first 60 days.
Your buddy is a peer who will reach out to you on Slack on your first day."""),

        (6, """\
Company Culture and Communication Norms
Core values: Customer Obsession (customer success is our success), Transparency (default
to sharing information openly), Continuous Learning (experiment, fail fast, improve),
and Accountability (own your outcomes, escalate blockers early and often).
Communication Norms: Slack is the primary communication channel for internal messages.
Email is used for external communication and formal HR correspondence.
Default to async communication and expect a response within 4 business hours.
Meetings must have a written agenda in Notion before the call. All decisions should be
documented in Notion with context and rationale for future reference."""),
    ],

    "vendor_contract_template.pdf": [
        (1, """\
Vendor Services Agreement Template
ACME Corp Legal Department | Version 2.4 | January 2025
This Vendor Services Agreement is entered into between ACME Corp, a Delaware corporation
(Client), and the vendor identified in the Order Form (Vendor). This Agreement governs
the provision of professional services, software, or goods by Vendor to Client as
described in each Statement of Work (SOW).
Scope of Work: each engagement is governed by a separate SOW mutually signed by both
parties. The SOW must include description of deliverables, timeline, acceptance criteria,
pricing, and point of contact. Work outside the agreed SOW requires a written change order
before commencement of additional work."""),

        (2, """\
Payment Terms and Pricing
Payment is due Net 30 days from the date of invoice receipt by ACME Corp.
Invoices must include purchase order number, SOW reference, itemized services rendered,
and banking details. Invoices should be emailed to ap@acmecorp.com.
Late payments accrue interest at a rate of 1.5% per month on the outstanding balance
from the payment due date until paid in full.
All fees are fixed as stated in the SOW unless a written change order is executed.
ACME Corp does not reimburse travel expenses unless pre-approved in writing by the
authorized ACME Corp representative. Approved expenses must include original receipts
and must be submitted within 30 days of incurrence.
International vendors must provide a completed W-8BEN or W-8BEN-E form before payment."""),

        (3, """\
Service Level Agreement (SLA) and Deliverable Acceptance
For software or SaaS vendors the following SLA applies unless superseded by the SOW.
Uptime guarantee: 99.9% monthly uptime excluding scheduled maintenance windows.
Incident response time: Critical (P1) issues - 4 hours. High (P2) issues - 8 hours.
Medium (P3) issues - 24 hours. Low (P4) issues - 72 hours.
Vendor must provide a public status page URL and subscribe ACME Corp to incident notifications.
Deliverable Acceptance: Client has 10 business days to review and accept or reject each
deliverable after receipt. Rejection must include written feedback specifying defects.
Vendor has 5 business days to remediate and resubmit rejected deliverables.
Deliverables not rejected in writing within 10 business days are deemed accepted."""),

        (4, """\
Term, Termination, Confidentiality, and Liability
Term: this Agreement commences on the Effective Date and continues for one year,
renewing automatically unless either party provides 30 days written notice of non-renewal.
Termination for cause: either party may terminate with 15 days written notice if the other
party materially breaches and fails to cure within the notice period.
Termination for convenience: ACME Corp may terminate with 30 days written notice at any time.
Confidentiality: all work product produced under this Agreement is work-for-hire and becomes
the sole property of ACME Corp upon payment. Vendor must sign a non-disclosure agreement (NDA)
covering all Confidential Information. NDA obligations survive termination for 3 years.
Liability cap: Vendor total liability is capped at fees paid in the 12 months before the claim.
Vendor must maintain general liability insurance of at least USD 1,000,000 per occurrence."""),
    ],
}


def build_doc_entry(file_name: str, pages: list[tuple[int, str]], file_path: Path) -> dict:
    from backend.rag import LocalEmbedder
    embedder = LocalEmbedder()
    chunks: list[dict] = []
    for page_num, text in pages:
        for idx, chunk in enumerate(chunk_text(text.strip())):
            chunks.append({
                "page": page_num,
                "chunk_index": idx,
                "text": chunk,
                "embedding": embedder.embed_query(chunk),
            })
    return {
        "tenant_id": TENANT_ID,
        "file_name": file_name,
        "path": str(file_path.resolve()),
        "chunks": chunks,
        "uploaded_at": datetime.now(timezone.utc).isoformat(),
    }


def main() -> None:
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

    if INDEX_FILE.exists():
        index = json.loads(INDEX_FILE.read_text(encoding="utf-8"))
    else:
        index = {"documents": []}

    # Remove old seed docs so we replace them cleanly
    seed_names = set(DOCUMENTS.keys())
    index["documents"] = [
        d for d in index["documents"]
        if not (d["tenant_id"] == TENANT_ID and d["file_name"] in seed_names)
    ]

    for file_name, pages in DOCUMENTS.items():
        file_path = UPLOAD_DIR / file_name
        make_pdf(file_path, pages)
        entry = build_doc_entry(file_name, pages, file_path)
        index["documents"].append(entry)
        print(f"  [OK] {file_name} — {len(pages)} pages, {len(entry['chunks'])} chunks")

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    INDEX_FILE.write_text(json.dumps(index, indent=2), encoding="utf-8")
    print(f"\nSeeded {len(DOCUMENTS)} documents into {INDEX_FILE}")
    print("\nTest queries:")
    print('  "How many PTO days do employees get?"')
    print('  "What is the minimum password length?"')
    print('  "What tools do I need on my first day?"')
    print('  "What are the payment terms for vendors?"')
    print('  "Who do I contact for IT issues?"')
    print('  "What is the 401k employer match?"')
    print('  "What is the late payment fee?"')
    print('  "What is the remote work policy?"')


if __name__ == "__main__":
    main()
