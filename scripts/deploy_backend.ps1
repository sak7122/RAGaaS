# Deploy FastAPI backend to Google Cloud Run
$serviceName = "ragaas-backend"
$region      = "us-central1"
$projectId   = $env:GCP_PROJECT_ID ?? "genaiacademy-496218"

Write-Host "Deploying to Cloud Run — project=$projectId region=$region" -ForegroundColor Green
gcloud config set project $projectId
gcloud run deploy $serviceName `
    --source . `
    --region $region `
    --allow-unauthenticated `
    --min-instances 0 `
    --max-instances 5 `
    --set-env-vars "GCP_PROJECT_ID=$projectId,RAGAAS_ENV=production"

if ($LASTEXITCODE -eq 0) {
    Write-Host "Deployed successfully." -ForegroundColor Green
} else {
    Write-Error "Deployment failed."
}
