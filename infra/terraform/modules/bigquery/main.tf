variable "project_id" { type = string }
variable "region" { type = string }

# ── Ops/BI dataset ─────────────────────────────────────────────────────────────
# Shared across all tenants. Queried ONLY by trusted, hardcoded backend SQL
# (never LLM-generated) — a plain tenant_id column is safe here. Contrast with
# tenant structured-data datasets (tenant_{tenant_id}), which are created lazily
# by app code, NOT Terraform, because tenant IDs aren't known ahead of time.
resource "google_bigquery_dataset" "ops" {
  project    = var.project_id
  dataset_id = "ragaas_ops"
  location   = var.region

  description = "RAGaaS operational analytics — usage, billing, query telemetry across all tenants"
}

resource "google_bigquery_table" "query_log" {
  project             = var.project_id
  dataset_id          = google_bigquery_dataset.ops.dataset_id
  table_id            = "query_log"
  deletion_protection = false

  schema = jsonencode([
    { name = "tenant_id", type = "STRING", mode = "REQUIRED" },
    { name = "question", type = "STRING", mode = "NULLABLE" },
    { name = "score", type = "FLOAT", mode = "NULLABLE" },
    { name = "answered", type = "BOOLEAN", mode = "NULLABLE" },
    { name = "source", type = "STRING", mode = "NULLABLE" },
    { name = "at", type = "TIMESTAMP", mode = "REQUIRED" },
  ])
}

resource "google_bigquery_table" "tool_audit" {
  project             = var.project_id
  dataset_id          = google_bigquery_dataset.ops.dataset_id
  table_id            = "tool_audit"
  deletion_protection = false

  schema = jsonencode([
    { name = "tenant_id", type = "STRING", mode = "REQUIRED" },
    { name = "tool", type = "STRING", mode = "REQUIRED" },
    { name = "status", type = "STRING", mode = "REQUIRED" },
    { name = "actor_uid", type = "STRING", mode = "NULLABLE" },
    { name = "idempotency_key", type = "STRING", mode = "NULLABLE" },
    { name = "args_digest", type = "STRING", mode = "NULLABLE" },
    { name = "at", type = "TIMESTAMP", mode = "REQUIRED" },
  ])
}

resource "google_bigquery_table" "usage_daily" {
  project             = var.project_id
  dataset_id          = google_bigquery_dataset.ops.dataset_id
  table_id            = "usage_daily"
  deletion_protection = false

  schema = jsonencode([
    { name = "tenant_id", type = "STRING", mode = "REQUIRED" },
    { name = "day", type = "DATE", mode = "REQUIRED" },
    { name = "queries", type = "INTEGER", mode = "REQUIRED" },
    { name = "query_limit", type = "INTEGER", mode = "NULLABLE" },
  ])
}
