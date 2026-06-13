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

locals {
  image = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.backend.repository_id}/backend:latest"
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
      # First deploy: use a public hello image as placeholder.
      # CI/CD pipeline replaces this on each deploy via --source flag.
      image = local.image

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

      startup_probe {
        http_get {
          path = "/api/health"
          port = 8000
        }
        initial_delay_seconds = 5
        timeout_seconds       = 3
        period_seconds        = 10
        failure_threshold     = 3
      }

      liveness_probe {
        http_get {
          path = "/api/health"
          port = 8000
        }
        period_seconds    = 30
        timeout_seconds   = 5
        failure_threshold = 2
      }
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
