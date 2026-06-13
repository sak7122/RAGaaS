output "provider_name" {
  description = "Full WIF provider resource name — use as GCP_WORKLOAD_IDENTITY_PROVIDER GitHub Secret"
  value       = google_iam_workload_identity_pool_provider.github.name
}

output "pool_name" {
  value = google_iam_workload_identity_pool.github.name
}
