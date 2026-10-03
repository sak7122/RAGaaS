# RAGaaS Academy — GCP side (see docs/PRD-onboarding.md).
#
# Retrieval + grounded answers run on Vertex AI Search (Discovery Engine)
# because the "Trial credit for GenAI App Builder" only applies to Vertex AI
# Search SKUs. One data store + engine per tenant keeps isolation structural
# (no shared index to mis-filter). Supabase stays the system of record; its
# URL/key live in Secret Manager — values are added out-of-band, never in TF.

variable "project_id" { type = string }

variable "runtime_sa_email" {
  type        = string
  description = "Cloud Run runtime SA that queries search + reads the Supabase secrets"
}

variable "tenants" {
  type        = list(string)
  description = "Tenant ids that get their own Vertex AI Search data store + engine"
  default     = ["pilot"]
}

# ── Per-tenant knowledge base (unstructured docs, layout-aware chunking) ──────
resource "google_discovery_engine_data_store" "kb" {
  for_each = toset(var.tenants)

  project                     = var.project_id
  location                    = "global"
  data_store_id               = "academy-kb-${each.key}"
  display_name                = "Academy KB - ${each.key}"
  industry_vertical           = "GENERIC"
  content_config              = "CONTENT_REQUIRED"
  solution_types              = ["SOLUTION_TYPE_SEARCH"]
  create_advanced_site_search = false

  document_processing_config {
    chunking_config {
      layout_based_chunking_config {
        chunk_size                = 500
        include_ancestor_headings = true
      }
    }
    default_parsing_config {
      layout_parsing_config {}
    }
  }
}

# Enterprise tier + LLM add-on → search with generative answers (Answer API),
# billed under Vertex AI Search SKUs → covered by the trial credit.
resource "google_discovery_engine_search_engine" "kb" {
  for_each = toset(var.tenants)

  project           = var.project_id
  location          = "global"
  collection_id     = "default_collection"
  engine_id         = "academy-${each.key}"
  display_name      = "Academy - ${each.key}"
  industry_vertical = "GENERIC"
  data_store_ids    = [google_discovery_engine_data_store.kb[each.key].data_store_id]

  search_engine_config {
    search_tier    = "SEARCH_TIER_ENTERPRISE"
    search_add_ons = ["SEARCH_ADD_ON_LLM"]
  }
}

resource "google_project_iam_member" "runtime_search" {
  project = var.project_id
  role    = "roles/discoveryengine.editor" # query + import documents
  member  = "serviceAccount:${var.runtime_sa_email}"
}

# ── Supabase credentials (containers only; add versions with gcloud) ─────────
resource "google_secret_manager_secret" "supabase" {
  for_each = toset(["academy-supabase-url", "academy-supabase-service-key"])

  project   = var.project_id
  secret_id = each.key
  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_iam_member" "runtime_supabase" {
  for_each = google_secret_manager_secret.supabase

  project   = var.project_id
  secret_id = each.value.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${var.runtime_sa_email}"
}

output "search_engines" {
  value = { for t, e in google_discovery_engine_search_engine.kb : t => e.name }
}
