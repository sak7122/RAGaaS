terraform {
  required_version = ">= 1.6"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
    google-beta = {
      source  = "hashicorp/google-beta"
      version = "~> 5.0"
    }
  }

  # Remote state — bootstrap the state bucket first:
  #   gcloud storage buckets create gs://snappy-mapper-498223-b2-tf-state \
  #     --project=snappy-mapper-498223-b2 --location=us-central1 \
  #     --uniform-bucket-level-access
  # Then: terraform init
  # NOTE: backend block cannot use variables — bucket name is hardcoded.
  backend "gcs" {
    bucket = "snappy-mapper-498223-b2-tf-state"
    prefix = "terraform/state"
  }
}
