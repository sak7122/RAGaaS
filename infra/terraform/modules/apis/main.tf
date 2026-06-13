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
    "identitytoolkit.googleapis.com",
    "cloudresourcemanager.googleapis.com",
    "artifactregistry.googleapis.com",
  ]
}

resource "google_project_service" "apis" {
  for_each = toset(local.apis)

  project = var.project_id
  service = each.value

  # Do not disable APIs on destroy — other resources may depend on them
  disable_on_destroy = false
}
