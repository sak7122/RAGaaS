# ─────────────────────────────────────────────────────────────────────────────
# ONE-TIME BOOTSTRAP — run locally before the first `terraform init`.
#
# Solves the chicken-and-egg problem:
#   - Terraform remote state lives in a GCS bucket.
#   - That bucket must exist BEFORE `terraform init` can use it.
#   - The deployer SA + WIF (that GitHub Actions uses) are themselves created
#     by Terraform — so the FIRST apply must run locally by a project owner.
#
# After this script + the first local `terraform apply`, GitHub Actions can
# manage all infra via the Infrastructure pipeline (WIF, no keys).
#
# Prereq: gcloud auth login  +  you must be Owner/Editor on the project.
# ─────────────────────────────────────────────────────────────────────────────

$PROJECT = "snappy-mapper-498223-b2"
$BUCKET  = "ragaas-prod-tfstate"
$REGION  = "us-central1"

Write-Host "Setting active project to $PROJECT ..." -ForegroundColor Cyan
& gcloud config set project $PROJECT | Out-Null

Write-Host "Checking state bucket gs://$BUCKET ..." -ForegroundColor Cyan
& gcloud storage buckets describe "gs://$BUCKET" *>$null
$exists = $LASTEXITCODE -eq 0

if ($exists) {
    Write-Host "  SKIP: gs://$BUCKET already exists" -ForegroundColor Yellow
} else {
    Write-Host "  Creating gs://$BUCKET ..." -ForegroundColor Cyan
    & gcloud storage buckets create "gs://$BUCKET" `
        --project $PROJECT `
        --location $REGION `
        --uniform-bucket-level-access | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  ERROR: bucket create failed" -ForegroundColor Red; exit 1
    }
    # Versioning so state history is recoverable
    & gcloud storage buckets update "gs://$BUCKET" --versioning | Out-Null
    Write-Host "  OK: bucket created with versioning" -ForegroundColor Green
}

Write-Host ""
Write-Host "Next steps (run locally, ONE TIME):" -ForegroundColor Green
Write-Host "  gcloud auth application-default login"
Write-Host "  cd infra/terraform"
Write-Host "  terraform init"
Write-Host "  terraform apply        # creates deployer SA + WIF + all infra"
Write-Host "  terraform output github_secrets_summary   # paste into GitHub Secrets"
Write-Host ""
Write-Host "After that, GitHub Actions -> Infrastructure pipeline manages infra." -ForegroundColor Green
