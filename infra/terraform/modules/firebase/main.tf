variable "project_id" {
  type        = string
  description = "GCP project ID to enable Firebase on"
}

variable "firestore_location" {
  type        = string
  description = "Firestore location (regional like us-central1, or multi-region like nam5)"
  default     = "us-central1"
}

variable "firestore_rules_file" {
  type        = string
  description = "Path to the firestore.rules file to deploy"
}

# ── Enable Firebase on the GCP project ────────────────────────────────────────
# Required for Firebase Auth (token verification) and Hosting.
resource "google_firebase_project" "default" {
  provider = google-beta
  project  = var.project_id
}

# ── Firestore database (Native mode) ──────────────────────────────────────────
# Backend FirestoreUsageStore (quota) + FirestoreIndexStore (doc metadata) use this.
resource "google_firestore_database" "default" {
  project     = var.project_id
  name        = "(default)"
  location_id = var.firestore_location
  type        = "FIRESTORE_NATIVE"

  # Prevent accidental deletion of the production database
  deletion_policy = "DELETE"

  depends_on = [google_firebase_project.default]
}

# ── Deploy Firestore security rules ───────────────────────────────────────────
resource "google_firebaserules_ruleset" "firestore" {
  provider = google-beta
  project  = var.project_id

  source {
    files {
      name    = "firestore.rules"
      content = file(var.firestore_rules_file)
    }
  }

  depends_on = [google_firestore_database.default]
}

resource "google_firebaserules_release" "firestore" {
  provider     = google-beta
  project      = var.project_id
  name         = "cloud.firestore"
  ruleset_name = "projects/${var.project_id}/rulesets/${google_firebaserules_ruleset.firestore.name}"
}
