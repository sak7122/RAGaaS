# RAGaaS — Positioning

## One-liner
The knowledge base that answers your team — and tells you what they couldn't find.

## The wedge (why not just ChatGPT?)
Anyone can paste a PDF into ChatGPT. They cannot:
- Keep a **private, multi-tenant** knowledge base their whole team queries.
- Get **cited answers** that point to the source doc + page.
- See **what their team keeps asking that the docs don't answer** —
  Knowledge Gap Detection. That's the insight a support lead / ops
  manager actually pays for: it tells them which doc to write next.

ChatGPT answers a question. RAGaaS runs a knowledge base **and reports
on its blind spots.**

## ICP (who buys)
Primary: **small teams drowning in their own docs.**
- Support / CX teams with a sprawling help-center + internal runbooks.
- Ops / People teams with handbooks, SOPs, policies (HR, onboarding).
- Agencies / consultancies answering the same client questions repeatedly.
- Founders/PMs who want "ask our docs" without standing up infra.

Size: 5–200 people. Has documents, no ML team, values privacy + low cost.
Not ICP (now): regulated enterprises needing SOC2/on-prem, or consumers.

## Differentiator features (true today)
- Upload PDF **and Word (.docx)**, multi-tenant isolation.
- Hybrid vector + keyword retrieval, **cited** answers (doc + page).
- **Knowledge Gaps dashboard** — aggregates low-confidence questions,
  flags the ones asked repeatedly with no good answer.
- Self-serve workspace per signup. Local-first dev, GCP prod.

## Pricing angle (cost story)
COGS ~$0.0004/query (Firestore vector + Gemini Flash-Lite) vs ~10x for
Vertex AI Search. Translation: we can offer a **generous free tier** and
still have margin. Lead with free, upsell on seats + gap analytics.

## Messaging by persona
- **Support lead:** "Stop answering the same ticket. See the top 10
  questions your help center fails to answer — ranked."
- **Ops/People:** "Your handbook, but it answers. And shows you the
  policy questions no doc covers yet."
- **Founder:** "Private ChatGPT over your docs in 5 minutes, with
  citations and an analytics layer."

## Objection handling
- *"Why not ChatGPT?"* → multi-user, private, cited, + the gap report.
- *"Is my data private?"* → per-tenant isolation, your GCP project.
- *"Setup pain?"* → upload a PDF, ask a question. No config.
- *"Accuracy?"* → answers cite the source; gaps surface what's weak
  instead of hallucinating confidently.

## Proof to build (don't fake — earn)
- 1 design-partner case study with a real gap-report screenshot.
- Public demo workspace seeded with sample docs.
- Short Loom: upload → ask → cited answer → open Gaps dashboard.
