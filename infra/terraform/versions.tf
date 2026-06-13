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
  #   gcloud storage buckets create gs://ragaas-tf-state \
  #     --project=ragaas-af876 --location=us-central1 \
  #     --uniform-bucket-level-access
  # Then: terraform init
  backend "gcs" {
    bucket = "ragaas-tf-state"
    prefix = "terraform/state"
  }
}
