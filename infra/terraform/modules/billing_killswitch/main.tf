variable "project_id" { type = string }
variable "project_number" { type = string }
variable "region" { type = string }

variable "dry_run" {
  type        = bool
  description = "true = function logs but never disables billing (for testing the wiring)"
  default     = false
}

# ── Topic the budget publishes to ─────────────────────────────────────────────
resource "google_pubsub_topic" "budget_alerts" {
  project = var.project_id
  name    = "ragaas-budget-alerts"
}

# The Cloud Billing budget service publishes as this Google-managed identity.
resource "google_pubsub_topic_iam_member" "budget_publisher" {
  project = var.project_id
  topic   = google_pubsub_topic.budget_alerts.name
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:billing-budget-alert@system.gserviceaccount.com"
}

# ── Function identity: may unlink billing on THIS project only ────────────────
resource "google_service_account" "killswitch" {
  project      = var.project_id
  account_id   = "ragaas-billing-killswitch"
  display_name = "RAGaaS billing kill switch"
  description  = "Unlinks billing from the project when the budget is exceeded"
}

resource "google_project_iam_member" "killswitch_billing" {
  project = var.project_id
  role    = "roles/billing.projectManager"
  member  = "serviceAccount:${google_service_account.killswitch.email}"
}

# projectManager only has create/deleteBillingAssignment; reading the current
# billing info also needs resourcemanager.projects.get (read-only).
resource "google_project_iam_member" "killswitch_browser" {
  project = var.project_id
  role    = "roles/browser"
  member  = "serviceAccount:${google_service_account.killswitch.email}"
}

resource "google_project_iam_member" "killswitch_event_receiver" {
  project = var.project_id
  role    = "roles/eventarc.eventReceiver"
  member  = "serviceAccount:${google_service_account.killswitch.email}"
}

# Pub/Sub service agent mints OIDC tokens to push events to the function.
resource "google_project_iam_member" "pubsub_token_creator" {
  project = var.project_id
  role    = "roles/iam.serviceAccountTokenCreator"
  member  = "serviceAccount:service-${var.project_number}@gcp-sa-pubsub.iam.gserviceaccount.com"
}

# ── Function source ───────────────────────────────────────────────────────────
data "archive_file" "source" {
  type        = "zip"
  source_dir  = "${path.module}/function"
  output_path = "${path.module}/.build/killswitch.zip"
}

resource "google_storage_bucket" "source" {
  project                     = var.project_id
  name                        = "${var.project_id}-killswitch-src"
  location                    = var.region
  uniform_bucket_level_access = true
  force_destroy               = true
}

resource "google_storage_bucket_object" "source" {
  # Content hash in the name → source changes trigger a redeploy.
  name   = "killswitch-${data.archive_file.source.output_md5}.zip"
  bucket = google_storage_bucket.source.name
  source = data.archive_file.source.output_path
}

# ── Function ──────────────────────────────────────────────────────────────────
resource "google_cloudfunctions2_function" "killswitch" {
  project  = var.project_id
  location = var.region
  name     = "ragaas-billing-killswitch"

  build_config {
    runtime     = "python312"
    entry_point = "stop_billing"
    source {
      storage_source {
        bucket = google_storage_bucket.source.name
        object = google_storage_bucket_object.source.name
      }
    }
  }

  service_config {
    max_instance_count    = 1
    available_memory      = "256M"
    timeout_seconds       = 60
    service_account_email = google_service_account.killswitch.email
    environment_variables = {
      TARGET_PROJECT_ID = var.project_id
      DRY_RUN           = tostring(var.dry_run)
    }
  }

  event_trigger {
    trigger_region        = var.region
    event_type            = "google.cloud.pubsub.topic.v1.messagePublished"
    pubsub_topic          = google_pubsub_topic.budget_alerts.id
    retry_policy          = "RETRY_POLICY_RETRY"
    service_account_email = google_service_account.killswitch.email
  }

  depends_on = [
    google_project_iam_member.killswitch_event_receiver,
    google_project_iam_member.pubsub_token_creator,
  ]
}

resource "google_cloud_run_service_iam_member" "killswitch_invoker" {
  project  = var.project_id
  location = var.region
  service  = google_cloudfunctions2_function.killswitch.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.killswitch.email}"
}

output "topic_id" {
  value = google_pubsub_topic.budget_alerts.id
}
