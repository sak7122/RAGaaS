# Deploy FastAPI backend to Google Cloud Run
$serviceName     = "ragaas-backend"
$region          = "us-central1"
$projectId       = if ($env:GCP_PROJECT_ID) { $env:GCP_PROJECT_ID } else { "snappy-mapper-498223-b2" }
$firebaseProject = if ($env:FIREBASE_PROJECT_ID) { $env:FIREBASE_PROJECT_ID } else { $projectId }
$gcsBucket       = if ($env:GCS_BUCKET) { $env:GCS_BUCKET } else { "ragaas-prod-pdfs" }
$corsRegex       = if ($env:CORS_ORIGIN_REGEX) { $env:CORS_ORIGIN_REGEX } else { "https://$firebaseProject\.web\.app" }

Write-Host "Deploying to Cloud Run — project=$projectId region=$region" -ForegroundColor Green
gcloud run deploy $serviceName `
    --source . `
    --project $projectId `
    --region $region `
    --allow-unauthenticated `
    --min-instances 0 `
    --max-instances 10 `
    --memory 512Mi `
    --cpu 1 `
    --set-env-vars "GCP_PROJECT_ID=$projectId,RAGAAS_ENV=production,FIREBASE_PROJECT_ID=$firebaseProject,GCS_BUCKET=$gcsBucket,CORS_ORIGIN_REGEX=$corsRegex"

if ($LASTEXITCODE -eq 0) {
    Write-Host "Deployed successfully." -ForegroundColor Green
} else {
    Write-Error "Deployment failed."
}
