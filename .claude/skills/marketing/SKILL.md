---
name: marketing
description: Sell and market RAGaaS. Use when asked to write outreach emails, landing/launch copy, find or track leads, build a campaign or go-to-market plan, draft cold/warm email sequences, write positioning or ICP, or prepare a Product Hunt / LinkedIn / Reddit launch. Drafts only — a human reviews and sends.
---

Marketing + sales workspace for RAGaaS. This skill turns the product's
real differentiator — **Knowledge Gap Detection** ("the knowledge base
that answers your team *and* tells you what they couldn't find") — into
positioning, copy, lead tracking, and personalized outreach **drafts**.

App link (current): https://snappy-mapper-498223-b2.web.app

## Hard rules (read first — these are legal, not style)

1. **I draft, you send.** I never send email to a real person. I queue
   drafts in `outbox/`; you review and send manually until a compliant
   ESP is wired.
2. **No spam.** Only contact people who (a) opted in, or (b) are a named
   role at a company where 1:1 B2B with a real, specific reason is
   defensible. No scraped lists, no bulk-blasting strangers. CAN-SPAM /
   GDPR / CASL apply.
3. **Every email has** a real reason it's personalized, a single ask,
   and an unsubscribe / "reply STOP" line.
4. **No fake identities, no auto-created Gmail accounts, no inflating
   social proof.** Claims in copy must be true.

## Files

| Path | What |
|---|---|
| `assets/positioning.md` | ICP, the differentiator, one-liners, objection handling |
| `assets/landing-copy.md` | Hero / features / CTA copy for the site |
| `assets/email-sequences.md` | Warm + 1:1 cold templates (intro → value → ask → 2 follow-ups) |
| `assets/launch-playbook.md` | Product Hunt / LinkedIn / Reddit / indie channels |
| `leads.csv` | File CRM: name, company, role, email, source, status, last_touch, notes |
| `outbox/` | Per-lead drafts I generate, awaiting your manual send |

## How to drive me

- **"write the launch post for X"** → I pull from `assets/` and draft it.
- **"add lead: Jane Doe, Head of Support @ Acme, jane@acme.com, from LinkedIn"**
  → I append a row to `leads.csv` (status=`new`).
- **"draft outreach to the new leads"** → for each `status=new` lead I
  write a personalized draft to `outbox/<company>-<name>.md`, set status
  `drafted`. You read, edit, send, then tell me "sent Acme" → I set
  `status=sent`, stamp `last_touch`.
- **"who needs a follow-up?"** → I scan `leads.csv` for `sent` rows whose
  `last_touch` is >4 days old and draft follow-up #1/#2.

## Lead status flow

`new` → `drafted` → `sent` → `replied` | `no-reply` → `follow-up` →
`demo` → `won` | `lost` | `unsubscribed` (terminal — never contact again)

## What stays manual (you, not me)

Buying a domain, creating the inbox, importing *consented* contacts,
hitting send, anything touching payment or signing people up.

## When you're ready to actually send

Pick an ESP (Resend free tier = good default), verify a domain (DKIM +
SPF + DMARC), then this skill graduates: drafts in `outbox/` get sent via
the ESP's API/MCP **after your per-batch approval**, each with a working
unsubscribe link. Until then: drafts only.
