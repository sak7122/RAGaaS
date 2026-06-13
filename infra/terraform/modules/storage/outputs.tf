output "pdf_bucket_name" {
  description = "Name of the GCS bucket holding tenant PDF uploads"
  value       = google_storage_bucket.pdfs.name
}

output "pdf_bucket_url" {
  description = "gs:// URL of the PDF uploads bucket"
  value       = "gs://${google_storage_bucket.pdfs.name}"
}

output "tf_state_bucket_name" {
  description = "Name of the GCS bucket holding Terraform remote state"
  value       = google_storage_bucket.tf_state.name
}
