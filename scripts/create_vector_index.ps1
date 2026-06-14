# Creates the Firestore vector index required for prod semantic search
# (index_store.FirestoreIndexStore.vector_search -> find_nearest).
# Without it, prod retrieval silently falls back to weak keyword matching.
#
# Dimension MUST match the embedder:
#   text-embedding-005 (Vertex, prod) -> 768
# Run once. Index build takes a few minutes after creation.

$PROJECT   = "snappy-mapper-498223-b2"
$DIMENSION = 768

Write-Host "Creating Firestore vector index on chunks.embedding (dim $DIMENSION)..." -ForegroundColor Cyan

& gcloud firestore indexes composite create `
    --collection-group=chunks `
    --query-scope=COLLECTION `
    --field-config="field-path=embedding,vector-config={`"dimension`":$DIMENSION,`"flat`":{}}" `
    --project=$PROJECT

if ($LASTEXITCODE -eq 0) {
    Write-Host "OK: index creation started. It builds in the background (a few minutes)." -ForegroundColor Green
    Write-Host "Check status: gcloud firestore indexes composite list --project=$PROJECT"
} else {
    Write-Host "Index create failed (it may already exist)." -ForegroundColor Yellow
}
