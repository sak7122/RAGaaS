variable "project_id" { type = string }

data "google_project" "project" {
  project_id = var.project_id
}

# ── GitHub Actions deployer SA ────────────────────────────────────────────────
resource "google_service_account" "deployer" {
  project      = var.project_id
  account_id   = "ragaas-deployer"
  display_name = "RAGaaS GitHub Actions Deployer"
  description  = "Used by GitHub Actions CI/CD to deploy Cloud Run and manage GCS"
}

locals {
  deployer_roles = [
    # ── App deploy (Cloud Run + frontend) ──
    "roles/run.admin",
    "roles/storage.admin",
    "roles/datastore.user",
    "roles/iam.serviceAccountUser",
    "roles/cloudbuild.builds.editor",
    "roles/artifactregistry.admin",
    "roles/firebase.admin",

    # ── Infra management (so CI can run terraform apply) ──
    "roles/serviceusage.serviceUsageAdmin",  # enable/disable APIs
    "roles/iam.serviceAccountAdmin",         # create/manage SAs
    "roles/resourcemanager.projectIamAdmin", # manage project IAM bindings
    "roles/iam.workloadIdentityPoolAdmin",   # manage WIF pools/providers
    "roles/datastore.owner",                 # create Firestore database
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
    "roles/firebaseauth.admin", # set tenant_id custom claims on invite accept
    "roles/aiplatform.user",    # Vertex AI embeddings + Gemini generation
  ]
}

resource "google_project_iam_member" "runtime" {
  for_each = toset(local.runtime_roles)

  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.runtime.email}"
}

# ── Default Compute SA (used by Cloud Build / gcloud run deploy --source .) ──
# Needs storage access to read/write the Cloud Build staging bucket.
resource "google_project_iam_member" "compute_sa_storage" {
  project = var.project_id
  role    = "roles/storage.objectAdmin"
  member  = "serviceAccount:${data.google_project.project.number}-compute@developer.gserviceaccount.com"
}
