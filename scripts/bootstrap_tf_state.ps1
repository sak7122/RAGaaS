# Run ONCE before `terraform init`.
# Creates the GCS bucket that stores Terraform remote state.
# Safe to re-run -- skips if bucket already exists.

$PROJECT  = "ragaas-af876"
$BUCKET   = "ragaas-tf-state"
$REGION   = "us-central1"

Write-Host "Checking state bucket gs://$BUCKET ..." -ForegroundColor Cyan
$exists = & gcloud storage buckets describe "gs://$BUCKET" *>$null; $LASTEXITCODE -eq 0

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

    # Enable versioning so state history is preserved
    & gcloud storage buckets update "gs://$BUCKET" --versioning | Out-Null
    Write-Host "  OK: bucket created with versioning" -ForegroundColor Green
}

Write-Host ""
Write-Host "Now run:" -ForegroundColor Green
Write-Host "  cd infra/terraform"
Write-Host "  terraform init"
Write-Host "  terraform plan"
Write-Host "  terraform apply"
