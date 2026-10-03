# Demo sandbox VM — free-tier e2-micro running docker-compose.sandbox.yml.
#
# Cost posture (see docs/PRD-onboarding.md §10):
#   - e2-micro in us-central1 + 30 GB pd-standard = Compute Engine free tier.
#   - Ephemeral external IP only for outbound (image pulls); released when the
#     VM stops. Daily auto-stop keeps running hours (and any IP charge) bounded.
# Security posture:
#   - Own VPC: no default-network 0.0.0.0/0 SSH/RDP rules.
#   - Ingress: TCP 22 from Google IAP range only. App ports bind to 127.0.0.1
#     inside the VM and are reached through `gcloud compute ssh --tunnel-through-iap -L`.
#   - VM service account has NO roles; the sandbox runs on memory stores and
#     holds no credentials. OS Login + Shielded VM.

variable "project_id" { type = string }
variable "project_number" { type = string }

variable "zone" {
  type    = string
  default = "us-central1-a" # free tier: us-west1 / us-central1 / us-east1 only
}

variable "stop_schedule" {
  type        = string
  description = "Cron (in var.timezone) for the daily auto-stop"
  default     = "0 23 * * *"
}

variable "timezone" {
  type    = string
  default = "Asia/Kolkata"
}

locals {
  region = join("-", slice(split("-", var.zone), 0, 2))
}

resource "google_compute_network" "sandbox" {
  project                 = var.project_id
  name                    = "ragaas-sandbox"
  auto_create_subnetworks = false
}

resource "google_compute_subnetwork" "sandbox" {
  project       = var.project_id
  name          = "ragaas-sandbox-${local.region}"
  region        = local.region
  network       = google_compute_network.sandbox.id
  ip_cidr_range = "10.80.0.0/24"
}

resource "google_compute_firewall" "iap_ssh" {
  project       = var.project_id
  name          = "ragaas-sandbox-allow-iap-ssh"
  network       = google_compute_network.sandbox.id
  direction     = "INGRESS"
  source_ranges = ["35.235.240.0/20"] # Google IAP TCP forwarding
  target_tags   = ["ragaas-sandbox"]
  allow {
    protocol = "tcp"
    ports    = ["22"]
  }
}

resource "google_service_account" "sandbox" {
  project      = var.project_id
  account_id   = "ragaas-sandbox-vm"
  display_name = "RAGaaS sandbox VM (no roles)"
}

# Instance schedules run as the Compute Engine service agent, which needs
# permission to stop instances.
resource "google_project_iam_member" "schedule_agent" {
  project = var.project_id
  role    = "roles/compute.instanceAdmin.v1"
  member  = "serviceAccount:service-${var.project_number}@compute-system.iam.gserviceaccount.com"
}

resource "google_compute_resource_policy" "nightly_stop" {
  project = var.project_id
  name    = "ragaas-sandbox-nightly-stop"
  region  = local.region
  instance_schedule_policy {
    vm_stop_schedule {
      schedule = var.stop_schedule
    }
    time_zone = var.timezone
  }
}

resource "google_compute_instance" "sandbox" {
  project      = var.project_id
  name         = "ragaas-sandbox"
  zone         = var.zone
  machine_type = "e2-micro"
  tags         = ["ragaas-sandbox"]

  boot_disk {
    initialize_params {
      image = "debian-cloud/debian-12"
      size  = 30
      type  = "pd-standard" # pd-balanced is NOT free tier
    }
  }

  network_interface {
    subnetwork = google_compute_subnetwork.sandbox.id
    access_config {} # ephemeral IPv4 for outbound pulls; no inbound rules besides IAP
  }

  service_account {
    email  = google_service_account.sandbox.email
    scopes = ["cloud-platform"] # irrelevant: the SA has no IAM roles
  }

  shielded_instance_config {
    enable_secure_boot          = true
    enable_vtpm                 = true
    enable_integrity_monitoring = true
  }

  metadata = {
    enable-oslogin         = "TRUE"
    block-project-ssh-keys = "TRUE"
    startup-script         = file("${path.module}/startup.sh")
  }

  resource_policies = [google_compute_resource_policy.nightly_stop.id]

  # The schedule stops the VM; don't let TF fight it or rebuild on start/stop.
  lifecycle {
    ignore_changes = [desired_status]
  }

  depends_on = [google_project_iam_member.schedule_agent]
}

output "instance" {
  value = { name = google_compute_instance.sandbox.name, zone = google_compute_instance.sandbox.zone }
}
