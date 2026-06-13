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

variable "amount_usd" {
  type        = number
  description = "Monthly budget amount in USD"
  default     = 5
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
  display_name    = "RAGaaS monthly budget ($${var.amount_usd})"

  budget_filter {
    projects               = ["projects/${var.project_id}"]
    calendar_period        = "MONTH"
    credit_types_treatment = "INCLUDE_ALL_CREDITS"
  }

  amount {
    specified_amount {
      currency_code = "USD"
      units         = tostring(var.amount_usd)
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
  }
}
