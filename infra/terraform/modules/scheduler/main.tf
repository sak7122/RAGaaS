variable "project_id" { type = string }
variable "region" { type = string }
variable "cloud_run_url" { type = string }
variable "cloud_run_service_name" { type = string }

# ── Scheduler identity ───────────────────────────────────────────────────────
# Least-privilege: this SA can invoke the Cloud Run service and nothing else.
# The backend verifies the OIDC token's email claim app-side (require_scheduler_auth)
# because the service must stay publicly reachable for widget/share paths, so
# platform-level Cloud Run IAM can't be the only gate.
resource "google_service_account" "scheduler" {
  project      = var.project_id
  account_id   = "ragaas-scheduler"
  display_name = "RAGaaS Cloud Scheduler"
  description  = "Identity Cloud Scheduler uses to invoke scheduled agent-pipeline endpoints"
}

resource "google_cloud_run_v2_service_iam_member" "scheduler_invoker" {
  project  = var.project_id
  location = var.region
  name     = var.cloud_run_service_name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.scheduler.email}"
}

# ── Scheduled jobs ────────────────────────────────────────────────────────────
resource "google_cloud_scheduler_job" "analytics_export" {
  project     = var.project_id
  region      = var.region
  name        = "ragaas-analytics-export"
  description = "Batch-loads Firestore usage/query/audit telemetry into ragaas_ops (BigQuery)"
  schedule    = "0 * * * *" # hourly
  time_zone   = "UTC"

  http_target {
    uri         = "${var.cloud_run_url}/api/internal/scheduled/analytics-export"
    http_method = "POST"
    oidc_token {
      service_account_email = google_service_account.scheduler.email
      audience              = var.cloud_run_url
    }
  }
}

resource "google_cloud_scheduler_job" "nightly_knowledge_gap_report" {
  project     = var.project_id
  region      = var.region
  name        = "ragaas-nightly-knowledge-gap-report"
  description = "Per-tenant nightly knowledge-gap summary, fanned out server-side"
  schedule    = "0 6 * * *" # 06:00 UTC daily
  time_zone   = "UTC"

  http_target {
    uri         = "${var.cloud_run_url}/api/internal/scheduled/nightly-report"
    http_method = "POST"
    oidc_token {
      service_account_email = google_service_account.scheduler.email
      audience              = var.cloud_run_url
    }
  }
}
