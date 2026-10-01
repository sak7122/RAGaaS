output "scheduler_sa_email" {
  description = "Email of the Cloud Scheduler invoker service account — backend verifies this in require_scheduler_auth"
  value       = google_service_account.scheduler.email
}
