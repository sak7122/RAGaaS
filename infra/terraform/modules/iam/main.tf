variable "project_id" { type = string }

# ── GitHub Actions deployer SA ────────────────────────────────────────────────
resource "google_service_account" "deployer" {
  project      = var.project_id
  account_id   = "ragaas-deployer"
  display_name = "RAGaaS GitHub Actions Deployer"
  description  = "Used by GitHub Actions CI/CD to deploy Cloud Run and manage GCS"
}

locals {
  deployer_roles = [
    "roles/run.admin",
    "roles/storage.admin",
    "roles/datastore.user",
    "roles/iam.serviceAccountUser",
    "roles/cloudbuild.builds.editor",
    "roles/artifactregistry.writer",
    "roles/firebase.admin",
  ]
}

resource "google_project_iam_member" "deployer" {
  for_each = toset(local.deployer_roles)

  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.deployer.email}"
}

# ── Cloud Run runtime SA ──────────────────────────────────────────────────────
resource "google_service_account" "runtime" {
  project      = var.project_id
  account_id   = "ragaas-runtime"
  display_name = "RAGaaS Cloud Run Runtime"
  description  = "Runtime identity for the Cloud Run backend service"
}

locals {
  runtime_roles = [
    "roles/datastore.user",
    "roles/storage.objectAdmin",
    "roles/firebase.sdkAdminServiceAgent",
  ]
}

resource "google_project_iam_member" "runtime" {
  for_each = toset(local.runtime_roles)

  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.runtime.email}"
}
