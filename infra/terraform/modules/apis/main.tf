variable "project_id" { type = string }

locals {
  apis = [
    "run.googleapis.com",
    "storage.googleapis.com",
    "firestore.googleapis.com",
    "cloudbuild.googleapis.com",
    "iam.googleapis.com",
    "iamcredentials.googleapis.com",
    "firebase.googleapis.com",
    "firebaserules.googleapis.com",
    "firebasehosting.googleapis.com",
    "identitytoolkit.googleapis.com",
    "serviceusage.googleapis.com",
    "cloudresourcemanager.googleapis.com",
    "artifactregistry.googleapis.com",
    "billingbudgets.googleapis.com",
    "cloudbilling.googleapis.com",   # kill switch unlinks billing
    "cloudfunctions.googleapis.com", # kill switch function
    "eventarc.googleapis.com",
    "pubsub.googleapis.com",
    "monitoring.googleapis.com",
    "aiplatform.googleapis.com",      # Vertex AI: embeddings + Gemini generation
    "bigquery.googleapis.com",        # structured tenant data + ops analytics
    "cloudscheduler.googleapis.com",  # scheduled per-tenant agent pipelines
    "discoveryengine.googleapis.com", # Vertex AI Search (Academy; trial-credit covered)
    "secretmanager.googleapis.com",
    "compute.googleapis.com", # sandbox VM (free-tier e2-micro)
    "iap.googleapis.com",     # SSH/port tunnelling to the sandbox, no public ports
  ]
}

resource "google_project_service" "apis" {
  for_each = toset(local.apis)

  project = var.project_id
  service = each.value

  # Do not disable APIs on destroy — other resources may depend on them
  disable_on_destroy = false
}
