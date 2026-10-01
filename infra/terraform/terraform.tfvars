project_id          = "snappy-mapper-498223-b2"
firebase_project_id = "snappy-mapper-498223-b2"
region              = "us-central1"
github_repo         = "sak7122/RAGaaS"
gcs_pdf_bucket      = "ragaas-prod-pdfs"
cors_origin_regex   = "https://snappy-mapper-498223-b2\\.web\\.app"

cloud_run_min_instances = 0
cloud_run_max_instances = 1
cloud_run_memory        = "512Mi"
cloud_run_cpu           = "1"

# Cost safeguards - budget is NET of credits (GenAI App Builder trial credit),
# so it only counts what would hit the card. Kill switch unlinks billing above it.
billing_account = "01BD78-62E1BC-B61700"
budget_amount   = 100
budget_currency = "INR"
