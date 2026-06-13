output "deployer_sa_email" {
  description = "Email of the GitHub Actions deployer service account"
  value       = google_service_account.deployer.email
}

output "deployer_sa_name" {
  description = "Fully-qualified resource name of the deployer service account"
  value       = google_service_account.deployer.name
}

output "runtime_sa_email" {
  description = "Email of the Cloud Run runtime service account"
  value       = google_service_account.runtime.email
}
