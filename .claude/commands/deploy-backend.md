---
description: Deploy the FastAPI backend to Google Cloud Run (project: genaiacademy-496218, region: us-central1)
---

Deploy RAGaaS FastAPI backend to Cloud Run:

```powershell
.\scripts\deploy_backend.ps1
```

Or via gcloud directly:
```powershell
$env:GCP_PROJECT_ID="genaiacademy-496218"
gcloud run deploy ragaas-backend --source . --region us-central1 --allow-unauthenticated --min-instances 0 --max-instances 5 --set-env-vars "GCP_PROJECT_ID=genaiacademy-496218,RAGAAS_ENV=production"
```

Prerequisites:
- `gcloud auth application-default login` completed
- `GOOGLE_APPLICATION_CREDENTIALS` set to ADC path
- `GCP_PROJECT_ID` set in `.env`

After deploy, verify: `GET /api/health` returns `{"ok":true}`.
