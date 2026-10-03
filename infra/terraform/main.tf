provider "google" {
  project = var.project_id
  region  = var.region
}

provider "google-beta" {
  project = var.project_id
  region  = var.region
}

data "google_project" "project" {}

module "apis" {
  source     = "./modules/apis"
  project_id = var.project_id
}

module "iam" {
  source     = "./modules/iam"
  project_id = var.project_id
  depends_on = [module.apis]
}

module "wif" {
  source           = "./modules/wif"
  project_id       = var.project_id
  project_number   = data.google_project.project.number
  github_repo      = var.github_repo
  deployer_sa_name = module.iam.deployer_sa_name
  depends_on       = [module.iam]
}

module "billing_killswitch" {
  source         = "./modules/billing_killswitch"
  project_id     = var.project_id
  project_number = data.google_project.project.number
  region         = var.region
  dry_run        = var.killswitch_dry_run
  depends_on     = [module.apis]
}

module "budget" {
  source          = "./modules/budget"
  project_id      = var.project_id
  billing_account = var.billing_account
  alert_email     = var.alert_email
  amount          = var.budget_amount
  currency_code   = var.budget_currency
  pubsub_topic    = module.billing_killswitch.topic_id
  depends_on      = [module.apis]
}

module "firebase" {
  source               = "./modules/firebase"
  project_id           = var.project_id
  firestore_location   = var.region
  firestore_rules_file = "${path.module}/../../firestore.rules"
  depends_on           = [module.apis]
}

module "storage" {
  source           = "./modules/storage"
  project_id       = var.project_id
  region           = var.region
  pdf_bucket_name  = var.gcs_pdf_bucket
  runtime_sa_email = module.iam.runtime_sa_email
  firebase_domain  = "${var.firebase_project_id}.web.app"
  depends_on       = [module.apis]
}

module "cloud_run" {
  source              = "./modules/cloud_run"
  project_id          = var.project_id
  region              = var.region
  runtime_sa_email    = module.iam.runtime_sa_email
  gcs_bucket          = module.storage.pdf_bucket_name
  firebase_project_id = var.firebase_project_id
  cors_origin_regex   = var.cors_origin_regex
  min_instances       = var.cloud_run_min_instances
  max_instances       = var.cloud_run_max_instances
  memory              = var.cloud_run_memory
  cpu                 = var.cloud_run_cpu
  depends_on          = [module.apis, module.iam, module.storage]
}

module "bigquery" {
  source     = "./modules/bigquery"
  project_id = var.project_id
  region     = var.region
  depends_on = [module.apis]
}

module "scheduler" {
  source                 = "./modules/scheduler"
  project_id             = var.project_id
  region                 = var.region
  cloud_run_url          = module.cloud_run.service_url
  cloud_run_service_name = module.cloud_run.service_name
  depends_on             = [module.apis, module.cloud_run]
}

module "academy" {
  source     = "./modules/academy"
  project_id = var.project_id
  # Built from the id (not module.iam) so a targeted apply doesn't drag in IAM drift.
  runtime_sa_email = "ragaas-runtime@${var.project_id}.iam.gserviceaccount.com"
  tenants          = var.academy_tenants
  depends_on       = [module.apis]
}

module "sandbox_vm" {
  source         = "./modules/sandbox_vm"
  project_id     = var.project_id
  project_number = data.google_project.project.number
  depends_on     = [module.apis]
}
