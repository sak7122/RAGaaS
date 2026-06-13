output "budget_enabled" {
  description = "Whether the budget was created (billing_account was provided)"
  value       = local.enabled
}
