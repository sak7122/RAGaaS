terraform {
  required_version = ">= 1.6"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
    google-beta = {
      source  = "hashicorp/google-beta"
      version = "~> 6.0"
    }
  }

  # Remote state — bootstrap the state bucket first (see scripts/bootstrap_tf_state.ps1).
  # NOTE: backend block cannot use variables — bucket name is hardcoded.
  backend "gcs" {
    bucket = "ragaas-prod-tfstate"
    prefix = "terraform/state"
  }
}
