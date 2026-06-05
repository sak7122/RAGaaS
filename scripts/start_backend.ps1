# Start FastAPI backend in development mode (requires emulators running)
Set-Location $PSScriptRoot\..

# Load dev env vars
Get-Content .env.dev | Where-Object { $_ -match "^[^#]" } | ForEach-Object {
    $k, $v = $_ -split "=", 2
    [System.Environment]::SetEnvironmentVariable($k.Trim(), $v.Trim(), "Process")
}

Write-Host "Starting FastAPI backend on http://127.0.0.1:8000 [ENV=$env:RAGAAS_ENV]..." -ForegroundColor Green
.\.venv\Scripts\uvicorn.exe backend.main:app --reload --host 127.0.0.1 --port 8000
