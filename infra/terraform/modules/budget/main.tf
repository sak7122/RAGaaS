variable "project_id" {
  type        = string
  description = "GCP project the budget tracks spend for"
}

variable "billing_account" {
  type        = string
  description = "Billing account ID (XXXXXX-XXXXXX-XXXXXX). Empty disables the budget."
  default     = ""
}

variable "alert_email" {
  type        = string
  description = "Email address that receives budget threshold alerts"
}

variable "amount" {
  type        = number
  description = "Monthly budget amount (net of credits), in currency_code"
  default     = 100
}

variable "currency_code" {
  type        = string
  description = "Must match the billing account's currency (this account bills in INR)"
  default     = "INR"
}

variable "pubsub_topic" {
  type        = string
  description = "Pub/Sub topic id for programmatic notifications (kill switch). Empty = email only."
  default     = ""
}

locals {
  enabled = var.billing_account != ""
}

# ── Email notification channel ────────────────────────────────────────────────
resource "google_monitoring_notification_channel" "email" {
  count = local.enabled ? 1 : 0

  project      = var.project_id
  display_name = "RAGaaS budget alert email"
  type         = "email"

  labels = {
    email_address = var.alert_email
  }
}

# ── Budget with threshold alerts at 50% / 90% / 100% ─────────────────────────
resource "google_billing_budget" "monthly" {
  count = local.enabled ? 1 : 0

  billing_account = var.billing_account
  display_name    = "RAGaaS monthly budget (${var.amount} ${var.currency_code})"

  budget_filter {
    projects               = ["projects/${var.project_id}"]
    calendar_period        = "MONTH"
    credit_types_treatment = "INCLUDE_ALL_CREDITS"
  }

  amount {
    specified_amount {
      currency_code = var.currency_code
      units         = tostring(var.amount)
    }
  }

  threshold_rules {
    threshold_percent = 0.5
    spend_basis       = "CURRENT_SPEND"
  }
  threshold_rules {
    threshold_percent = 0.9
    spend_basis       = "CURRENT_SPEND"
  }
  threshold_rules {
    threshold_percent = 1.0
    spend_basis       = "CURRENT_SPEND"
  }
  # Forecasted to exceed 100% — early warning before money is spent
  threshold_rules {
    threshold_percent = 1.0
    spend_basis       = "FORECASTED_SPEND"
  }

  all_updates_rule {
    monitoring_notification_channels = [
      google_monitoring_notification_channel.email[0].id,
    ]
    # Also email the billing account admins/users by default
    disable_default_iam_recipients = false
    # Kill switch: every budget update (several/day) goes to Pub/Sub; the
    # function unlinks billing once net spend passes the budget amount.
    pubsub_topic   = var.pubsub_topic != "" ? var.pubsub_topic : null
    schema_version = "1.0"
  }
}
