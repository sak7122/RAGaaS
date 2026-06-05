---
description: Seed local_data/index.json with test documents for all 3 dev tenants (no PDF upload needed)
---

Inject synthetic test documents into `local_data/index.json` for rapid local testing without uploading real PDFs.

Use the filesystem MCP or Write tool to create/overwrite `local_data/index.json` with this content:

```json
{
  "documents": [
    {
      "tenant_id": "tenant-demo",
      "file_name": "demo_doc.pdf",
      "path": "local_data/uploads/tenant-demo/demo_doc.pdf",
      "pages": [
        "RAGaaS demo tenant document. Contains information about the product features and onboarding guide.",
        "The RAGaaS platform supports multi-tenant PDF ingestion with quota-enforced chat."
      ],
      "uploaded_at": "2026-06-01T00:00:00Z"
    },
    {
      "tenant_id": "tenant-a",
      "file_name": "secret_a.pdf",
      "path": "local_data/uploads/tenant-a/secret_a.pdf",
      "pages": [
        "Tenant A lease agreement. Includes blue parking permits and elevator access for floors 1-5.",
        "Monthly payment schedule and terms for Tenant A contract renewal."
      ],
      "uploaded_at": "2026-06-01T00:00:00Z"
    },
    {
      "tenant_id": "tenant-b",
      "file_name": "secret_b.pdf",
      "path": "local_data/uploads/tenant-b/secret_b.pdf",
      "pages": [
        "Tenant B contract mentions red elevator access and rooftop amenities.",
        "Tenant B billing terms, SLA guarantees, and escalation procedures."
      ],
      "uploaded_at": "2026-06-01T00:00:00Z"
    }
  ]
}
```

After seeding, verify isolation: query `red elevator` as tenant-a — should get `cannot find`. Query as tenant-b — should get citation from `secret_b.pdf`.
