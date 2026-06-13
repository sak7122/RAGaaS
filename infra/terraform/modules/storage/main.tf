variable "project_id" { type = string }
variable "region" { type = string }
variable "pdf_bucket_name" { type = string }
variable "runtime_sa_email" { type = string }
variable "firebase_domain" { type = string }

# ── PDF uploads bucket ────────────────────────────────────────────────────────
resource "google_storage_bucket" "pdfs" {
  project       = var.project_id
  name          = var.pdf_bucket_name
  location      = var.region
  force_destroy = false

  uniform_bucket_level_access = true

  versioning {
    enabled = true
  }

  # Keep at most 3 non-current versions then delete
  lifecycle_rule {
    condition {
      num_newer_versions = 3
      with_state         = "ARCHIVED"
    }
    action {
      type = "Delete"
    }
  }

  # Auto-delete uploads older than 365 days (tenants should re-upload)
  lifecycle_rule {
    condition {
      age = 365
    }
    action {
      type = "Delete"
    }
  }

  cors {
    origin          = ["https://${var.firebase_domain}"]
    method          = ["GET", "HEAD", "OPTIONS"]
    response_header = ["Content-Type", "Access-Control-Allow-Origin"]
    max_age_seconds = 3600
  }
}

# Runtime SA needs object-level access to upload/download PDFs
resource "google_storage_bucket_iam_member" "runtime_pdf_access" {
  bucket = google_storage_bucket.pdfs.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${var.runtime_sa_email}"
}

# ── Terraform state bucket ────────────────────────────────────────────────────
# Deliberately NOT managed here. It is created out-of-band by
# scripts/bootstrap_tf_state.ps1 BEFORE the first `terraform init`, because the
# bucket must exist before Terraform can store its own state in it. Managing it
# here would risk a `terraform destroy` deleting the very state it depends on.
# var.tf_state_bucket is kept for documentation/reference only.
