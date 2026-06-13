output "pdf_bucket_name" {
  value = google_storage_bucket.pdfs.name
}

output "pdf_bucket_url" {
  value = "gs://${google_storage_bucket.pdfs.name}"
}

output "tf_state_bucket_name" {
  value = google_storage_bucket.tf_state.name
}
