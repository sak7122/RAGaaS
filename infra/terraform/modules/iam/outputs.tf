output "deployer_sa_email" {
  value = google_service_account.deployer.email
}

output "deployer_sa_name" {
  value = google_service_account.deployer.name
}

output "runtime_sa_email" {
  value = google_service_account.runtime.email
}
