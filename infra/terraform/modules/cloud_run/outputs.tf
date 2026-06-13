output "service_url" {
  description = "Cloud Run service URL — use as VITE_API_URL"
  value       = google_cloud_run_v2_service.backend.uri
}

output "service_name" {
  value = google_cloud_run_v2_service.backend.name
}

output "artifact_registry_repo" {
  value = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.backend.repository_id}"
}
