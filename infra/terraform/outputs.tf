output "cloud_run_url" {
  description = "Cloud Run service URL — set as VITE_API_URL in GitHub Secrets"
  value       = module.cloud_run.service_url
}

output "gcs_pdf_bucket" {
  description = "GCS bucket for PDF uploads — set as GCS_BUCKET in GitHub Secrets"
  value       = module.storage.pdf_bucket_name
}

output "deployer_sa_email" {
  description = "GitHub Actions SA email — set as GCP_SERVICE_ACCOUNT in GitHub Secrets"
  value       = module.iam.deployer_sa_email
}

output "wif_provider" {
  description = "WIF provider resource name — set as GCP_WORKLOAD_IDENTITY_PROVIDER in GitHub Secrets"
  value       = module.wif.provider_name
}

output "github_secrets_summary" {
  description = "All values needed as GitHub Actions secrets"
  value = {
    GCP_PROJECT_ID                   = var.project_id
    FIREBASE_PROJECT_ID              = var.firebase_project_id
    GCP_SERVICE_ACCOUNT              = module.iam.deployer_sa_email
    GCP_WORKLOAD_IDENTITY_PROVIDER   = module.wif.provider_name
    GCS_BUCKET                       = module.storage.pdf_bucket_name
    CORS_ORIGIN_REGEX                = var.cors_origin_regex
    VITE_API_URL                     = module.cloud_run.service_url
  }
}
