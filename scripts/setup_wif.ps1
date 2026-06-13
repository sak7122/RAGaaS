# WIF + Service Account setup for GitHub Actions CI/CD
# Run once. Safe to re-run -- skips already-existing resources.

Set-StrictMode -Version Latest
# NOTE: Do NOT set ErrorActionPreference=Stop -- gcloud writes to stderr even on success

$PROJECT_ID  = "ragaas-af876"
$SA_NAME     = "ragaas-deployer"
$SA_EMAIL    = "$SA_NAME@$PROJECT_ID.iam.gserviceaccount.com"
$POOL_ID     = "github-pool"
$PROVIDER_ID = "github-provider"
$REPO        = "sak7122/RAGaaS"
$BUCKET      = "genaiacademy-ragaas-pdfs"
$REGION      = "us-central1"

function Step([string]$msg) { Write-Host "`n[$msg]" -ForegroundColor Cyan }
function OK([string]$msg)   { Write-Host "  OK: $msg" -ForegroundColor Green }
function SKIP([string]$msg) { Write-Host "  SKIP: $msg" -ForegroundColor Yellow }
function FAIL([string]$msg) { Write-Host "  ERROR: $msg" -ForegroundColor Red; exit 1 }

# In PS5.1, 2>$null on native exes can swallow stdout too.
# GCloud  = run, discard all output, return exit code only
# GCloudQ = run quietly (stdout+stderr to null), return exit code (for describe/exists checks)
# GCloudOut = capture stdout only (stderr visible in terminal), return string

function GCloud {
    $a = $args
    & gcloud @a | Out-Null
    return $LASTEXITCODE
}

function GCloudQ {
    $a = $args
    & gcloud @a *>$null
    return $LASTEXITCODE
}

function GCloudOut {
    $a = $args
    $lines = & gcloud @a 2>$null
    return ($lines -join "`n").Trim()
}

# --- [0] Auth check -----------------------------------------------------------
Step "0/7 Checking gcloud auth"
$account = GCloudOut config get-value account
if (-not $account -or $account -match "unset") {
    FAIL "No active gcloud account. Run: gcloud auth login"
}
OK "Authenticated as: $account"

# --- [0b] Project access check ------------------------------------------------
Step "0b/7 Verifying project access: $PROJECT_ID"
$PROJECT_NUM = GCloudOut projects describe $PROJECT_ID --format="value(projectNumber)"
if (-not $PROJECT_NUM) { FAIL "Cannot access project $PROJECT_ID -- check your permissions" }
OK "Project number: $PROJECT_NUM"

# --- [1] Enable APIs ----------------------------------------------------------
Step "1/7 Enabling GCP APIs (may take ~60s on first run)"
$ec = GCloud services enable `
    run.googleapis.com `
    storage.googleapis.com `
    firestore.googleapis.com `
    cloudbuild.googleapis.com `
    iam.googleapis.com `
    iamcredentials.googleapis.com `
    --project $PROJECT_ID
if ($ec -ne 0) { FAIL "API enable failed (exit $ec)" }
OK "APIs enabled"

# --- [2] Service account ------------------------------------------------------
Step "2/7 Service account: $SA_EMAIL"
$existing = GCloudOut iam service-accounts list `
    --project $PROJECT_ID `
    --filter="email:$SA_EMAIL" `
    --format="value(email)"
if ($existing) {
    SKIP $SA_EMAIL
} else {
    $ec = GCloud iam service-accounts create $SA_NAME `
        --display-name "RAGaaS GitHub Actions Deployer" `
        --project $PROJECT_ID
    if ($ec -ne 0) { FAIL "SA create failed (exit $ec)" }
    OK "Created $SA_EMAIL"
}

# --- [3] IAM roles ----------------------------------------------------------
Step "3/7 Granting IAM roles"
$roles = @(
    "roles/run.admin",
    "roles/storage.admin",
    "roles/datastore.user",
    "roles/iam.serviceAccountUser",
    "roles/cloudbuild.builds.editor"
)
foreach ($role in $roles) {
    $ec = GCloud projects add-iam-policy-binding $PROJECT_ID `
        --member "serviceAccount:$SA_EMAIL" `
        --role $role `
        --condition None `
        --quiet
    if ($ec -ne 0) { FAIL "Failed to grant $role (exit $ec)" }
    OK $role
}

# --- [4] WIF pool -------------------------------------------------------------
Step "4/7 Workload Identity Pool: $POOL_ID"
$ec = GCloudQ iam workload-identity-pools describe $POOL_ID `
    --location global --project $PROJECT_ID
if ($ec -eq 0) {
    SKIP "Pool $POOL_ID"
} else {
    $ec = GCloud iam workload-identity-pools create $POOL_ID `
        --location global `
        --display-name "GitHub Actions Pool" `
        --project $PROJECT_ID
    if ($ec -ne 0) { FAIL "Pool create failed (exit $ec)" }
    OK "Pool created"
}

# --- [5] WIF provider ---------------------------------------------------------
Step "5/7 GitHub OIDC provider: $PROVIDER_ID"
$ec = GCloudQ iam workload-identity-pools providers describe $PROVIDER_ID `
    --workload-identity-pool $POOL_ID --location global --project $PROJECT_ID
if ($ec -eq 0) {
    SKIP "Provider $PROVIDER_ID"
} else {
    $attrMap  = "google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.actor=assertion.actor"
    $attrCond = "assertion.repository=='$REPO'"
    $ec = GCloud iam workload-identity-pools providers create-oidc $PROVIDER_ID `
        --location global `
        --workload-identity-pool $POOL_ID `
        --display-name "GitHub Provider" `
        --issuer-uri "https://token.actions.githubusercontent.com" `
        --attribute-mapping $attrMap `
        --attribute-condition $attrCond `
        --project $PROJECT_ID
    if ($ec -ne 0) { FAIL "Provider create failed (exit $ec)" }
    OK "Provider created"
}

# --- [6] SA <-> WIF binding ---------------------------------------------------
Step "6/7 Binding SA to WIF pool for repo $REPO"
$POOL_RESOURCE = "projects/$PROJECT_NUM/locations/global/workloadIdentityPools/$POOL_ID"
$member = "principalSet://iam.googleapis.com/$POOL_RESOURCE/attribute.repository/$REPO"
$ec = GCloud iam service-accounts add-iam-policy-binding $SA_EMAIL `
    --role "roles/iam.workloadIdentityUser" `
    --member $member `
    --project $PROJECT_ID
if ($ec -ne 0) { FAIL "WIF binding failed (exit $ec)" }
OK "Binding set"

# --- [7] GCS bucket -----------------------------------------------------------
Step "7/7 GCS bucket: gs://$BUCKET"
$ec = GCloudQ storage buckets describe "gs://$BUCKET"
if ($ec -eq 0) {
    SKIP "gs://$BUCKET"
} else {
    $ec = GCloud storage buckets create "gs://$BUCKET" `
        --location $REGION `
        --uniform-bucket-level-access `
        --project $PROJECT_ID
    if ($ec -ne 0) { FAIL "Bucket create failed (exit $ec)" }
    OK "Bucket created"
}

# --- Print GitHub secret values -----------------------------------------------
$WIF_PROVIDER = "$POOL_RESOURCE/providers/$PROVIDER_ID"

Write-Host ""
Write-Host "================================================================" -ForegroundColor Green
Write-Host " ALL DONE -- add these to GitHub Secrets:" -ForegroundColor Green
Write-Host "================================================================" -ForegroundColor Green
Write-Host ""
Write-Host "GCP_WORKLOAD_IDENTITY_PROVIDER" -ForegroundColor White
Write-Host "  $WIF_PROVIDER" -ForegroundColor Yellow
Write-Host ""
Write-Host "GCP_SERVICE_ACCOUNT" -ForegroundColor White
Write-Host "  $SA_EMAIL" -ForegroundColor Yellow
Write-Host ""
Write-Host "GCP_PROJECT_ID" -ForegroundColor White
Write-Host "  $PROJECT_ID" -ForegroundColor Yellow
Write-Host ""
Write-Host "GCS_BUCKET" -ForegroundColor White
Write-Host "  $BUCKET" -ForegroundColor Yellow
Write-Host ""
Write-Host "GitHub: Settings -> Secrets -> Actions -> New repository secret"
