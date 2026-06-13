variable "project_id" { type = string }
variable "project_number" { type = string }
variable "github_repo" { type = string }
variable "deployer_sa_email" { type = string }
variable "deployer_sa_name" { type = string }

# ── Workload Identity Pool ────────────────────────────────────────────────────
resource "google_iam_workload_identity_pool" "github" {
  provider = google-beta

  project                   = var.project_id
  workload_identity_pool_id = "github-pool"
  display_name              = "GitHub Actions Pool"
  description               = "OIDC pool for GitHub Actions keyless authentication"
}

# ── OIDC Provider (GitHub) ────────────────────────────────────────────────────
resource "google_iam_workload_identity_pool_provider" "github" {
  provider = google-beta

  project                            = var.project_id
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "github-provider"
  display_name                       = "GitHub Provider"

  attribute_mapping = {
    "google.subject"       = "assertion.sub"
    "attribute.repository" = "assertion.repository"
    "attribute.actor"      = "assertion.actor"
    "attribute.ref"        = "assertion.ref"
  }

  # Only tokens from this specific repo are accepted
  attribute_condition = "assertion.repository == '${var.github_repo}'"

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

# ── Bind WIF principal → deployer SA ─────────────────────────────────────────
resource "google_service_account_iam_member" "wif_binding" {
  service_account_id = var.deployer_sa_name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/projects/${var.project_number}/locations/global/workloadIdentityPools/${google_iam_workload_identity_pool.github.workload_identity_pool_id}/attribute.repository/${var.github_repo}"
}
