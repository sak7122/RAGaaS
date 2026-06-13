variable "project_id" {
  type        = string
  description = "GCP project ID"
  default     = "ragaas-af876"
}

variable "region" {
  type        = string
  description = "GCP region for all resources"
  default     = "us-central1"
}

variable "firebase_project_id" {
  type        = string
  description = "Firebase project ID (usually same as GCP project ID)"
  default     = "ragaas-af876"
}

variable "github_repo" {
  type        = string
  description = "GitHub repo in owner/repo format for WIF binding"
  default     = "sak7122/RAGaaS"
}

variable "gcs_pdf_bucket" {
  type        = string
  description = "GCS bucket name for tenant PDF uploads"
  default     = "genaiacademy-ragaas-pdfs"
}

variable "tf_state_bucket" {
  type        = string
  description = "GCS bucket that holds Terraform remote state (created before terraform init)"
  default     = "ragaas-tf-state"
}

variable "cors_origin_regex" {
  type        = string
  description = "CORS origin regex passed to Cloud Run"
  default     = "https://ragaas-af876\\.web\\.app"
}

variable "cloud_run_min_instances" {
  type        = number
  description = "Minimum Cloud Run instances (0 = scale to zero)"
  default     = 0
}

variable "cloud_run_max_instances" {
  type    = number
  default = 10
}

variable "cloud_run_memory" {
  type    = string
  default = "512Mi"
}

variable "cloud_run_cpu" {
  type    = string
  default = "1"
}
