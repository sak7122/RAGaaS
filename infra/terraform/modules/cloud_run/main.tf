variable "project_id" {
  type = string
}

variable "region" {
  type = string
}

variable "runtime_sa_email" {
  type = string
}

variable "gcs_bucket" {
  type = string
}

variable "firebase_project_id" {
  type = string
}

variable "cors_origin_regex" {
  type = string
}

variable "min_instances" {
  type    = number
  default = 0
}

variable "max_instances" {
  type    = number
  default = 10
}

variable "memory" {
  type    = string
  default = "512Mi"
}

variable "cpu" {
  type    = string
  default = "1"
}

# ── Artifact Registry for Docker images ───────────────────────────────────────
resource "google_artifact_registry_repository" "backend" {
  project       = var.project_id
  location      = var.region
  repository_id = "ragaas"
  description   = "RAGaaS backend Docker images"
  format        = "DOCKER"
}

variable "bootstrap_image" {
  type        = string
  description = "Placeholder image for the initial create. CI replaces it via `gcloud run deploy --source`; ignore_changes keeps TF from reverting."
  default     = "us-docker.pkg.dev/cloudrun/container/hello"
}

locals {
  # Real app image path (after CI pushes). Exposed as an output for reference.
  app_image = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.backend.repository_id}/backend:latest"
}

# ── Cloud Run v2 service ──────────────────────────────────────────────────────
resource "google_cloud_run_v2_service" "backend" {
  project  = var.project_id
  name     = "ragaas-backend"
  location = var.region
  ingress  = "INGRESS_TRAFFIC_ALL"

  template {
    service_account = var.runtime_sa_email

    scaling {
      min_instance_count = var.min_instances
      max_instance_count = var.max_instances
    }

    containers {
      # Boot with a public placeholder; CI swaps in the real image (see
      # ignore_changes below). This lets `terraform apply` create the service
      # before any app image exists in Artifact Registry.
      image = var.bootstrap_image

      resources {
        limits = {
          cpu    = var.cpu
          memory = var.memory
        }
        # Scale to zero when idle; boost CPU during startup
        cpu_idle          = true
        startup_cpu_boost = true
      }

      env {
        name  = "RAGAAS_ENV"
        value = "production"
      }
      env {
        name  = "GCP_PROJECT_ID"
        value = var.project_id
      }
      env {
        name  = "FIREBASE_PROJECT_ID"
        value = var.firebase_project_id
      }
      env {
        name  = "GCS_BUCKET"
        value = var.gcs_bucket
      }
      env {
        name  = "CORS_ORIGIN_REGEX"
        value = var.cors_origin_regex
      }

      ports {
        container_port = 8000
      }

      # No custom HTTP probes here: the placeholder image used for the initial
      # create does not serve /api/health, so an HTTP probe would fail the first
      # apply. Cloud Run's default TCP startup check works for both placeholder
      # and the real app. Add HTTP health checks via the app pipeline later.
    }

    timeout = "60s"
  }

  lifecycle {
    # CI/CD pipeline updates the image on each deploy via gcloud run deploy --source
    # Prevent Terraform from reverting the image to the initial placeholder
    ignore_changes = [
      template[0].containers[0].image,
    ]
  }
}

# ── Allow unauthenticated invocations (public API) ────────────────────────────
resource "google_cloud_run_v2_service_iam_member" "public" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.backend.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}
