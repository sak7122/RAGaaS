output "ops_dataset_id" {
  description = "BigQuery dataset ID for cross-tenant ops/BI analytics"
  value       = google_bigquery_dataset.ops.dataset_id
}
