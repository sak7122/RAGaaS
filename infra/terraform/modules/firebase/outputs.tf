output "firestore_database" {
  description = "Firestore database name"
  value       = google_firestore_database.default.name
}

output "firebase_project_number" {
  description = "Project number of the Firebase-enabled project"
  value       = google_firebase_project.default.project_number
}
