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
  source            = "./modules/wif"
  project_id        = var.project_id
  project_number    = data.google_project.project.number
  github_repo       = var.github_repo
  deployer_sa_email = module.iam.deployer_sa_email
  deployer_sa_name  = module.iam.deployer_sa_name
  depends_on        = [module.iam]
}

module "storage" {
  source           = "./modules/storage"
  project_id       = var.project_id
  region           = var.region
  pdf_bucket_name  = var.gcs_pdf_bucket
  tf_state_bucket  = var.tf_state_bucket
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
