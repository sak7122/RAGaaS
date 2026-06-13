config {
  format           = "compact"
  call_module_type = "local"
}

plugin "google" {
  enabled = true
  version = "0.29.0"
  source  = "github.com/terraform-linters/tflint-ruleset-google"
}

# Enforce best practices
rule "terraform_deprecated_interpolation" { enabled = true }
rule "terraform_unused_declarations"      { enabled = true }
rule "terraform_comment_syntax"           { enabled = true }
rule "terraform_documented_outputs"       { enabled = true }
rule "terraform_documented_variables"     { enabled = true }
rule "terraform_typed_variables"          { enabled = true }
rule "terraform_module_pinned_source"     { enabled = true }
rule "terraform_naming_convention"        { enabled = true }
rule "terraform_required_version"         { enabled = true }
rule "terraform_required_providers"       { enabled = true }
