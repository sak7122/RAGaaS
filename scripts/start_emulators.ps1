# Start Firebase Auth + Firestore emulators with JDK 21
$env:JAVA_HOME = "C:\Program Files\Microsoft\jdk-21.0.11.10-hotspot"
$env:PATH = "$env:JAVA_HOME\bin;" + $env:PATH

if (-not (Get-Command firebase -ErrorAction SilentlyContinue)) {
    Write-Host "firebase-tools not found. Installing..." -ForegroundColor Yellow
    npm install -g firebase-tools
}

Write-Host "Starting Firebase emulators on Auth :9099, Firestore :8080, UI :4000" -ForegroundColor Green
firebase emulators:start --only auth,firestore
