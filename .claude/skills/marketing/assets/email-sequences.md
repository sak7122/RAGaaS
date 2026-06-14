# Email sequences (DRAFT templates)

Rules baked in: one ask per email, real personalization token, plain
text, short, unsubscribe line. `{{...}}` = fill per lead. Never send
without editing the `{{why_them}}` line — that's what makes it not spam.

App link: https://snappy-mapper-498223-b2.web.app

---

## A. 1:1 cold B2B (defensible — named role, real reason)

**Subject:** the questions your docs don't answer

Hi {{first_name}},

{{why_them}}  <!-- e.g. "Saw Acme's help center has 200+ articles —
that's a lot to keep current." REQUIRED, specific, true. -->

Quick idea: I built RAGaaS — your team asks your docs in plain English
and gets **cited** answers. The part people don't expect: it shows you
the **questions your docs keep failing to answer**, ranked. So you know
which article to write next instead of guessing.

Worth a 10-min look? Live demo: {{app_link}}

If not useful, just reply "no" and I'll leave it there.

{{your_name}}
{{unsubscribe_line}}  <!-- "Reply STOP to opt out." -->

---

## B. Warm / opt-in (signed up, downloaded, met you)

**Subject:** thanks for trying RAGaaS — one thing to try

Hi {{first_name}},

Thanks for {{context}} <!-- "signing up", "stopping by the booth" -->.
One feature worth 30 seconds: open the **Knowledge Gaps** tab after a
few questions — it surfaces what your docs can't answer yet.

Want me to seed your workspace with your real docs so you can see it on
your own content? Just reply and send a couple PDFs/Word files.

{{your_name}}

---

## C. Follow-up #1 (4 days, no reply)

**Subject:** re: the questions your docs don't answer

Hi {{first_name}}, floating this back up. The gap report is the bit most
{{role}} teams find genuinely new — happy to record a 2-min Loom on
your use case if easier than a call.

{{your_name}}
{{unsubscribe_line}}

---

## D. Follow-up #2 (4 more days — last one)

**Subject:** last note

No worries if the timing's off, {{first_name}} — I'll stop here. If
"what our docs fail to answer, ranked" ever gets useful, the door's
open: {{app_link}}.

{{your_name}}
{{unsubscribe_line}}

---

## E. Demo-booked confirmation

**Subject:** RAGaaS demo — {{date}}

Confirmed for {{date}}. Send 2–3 of your real docs beforehand and I'll
have your workspace + a live gap report ready. Link: {{app_link}}.

---

## Deliverability checklist (when sending goes live)
- Domain has SPF + DKIM + DMARC.
- < 50 sends/day from a new domain; warm up.
- Plain text or light HTML; one link.
- Real unsubscribe that works.
- Never buy a list.
