# RAGaaS demo sandbox VM helper (free-tier e2-micro, IAP-only access).
#
#   .\scripts\sandbox_vm.ps1 status    # VM state
#   .\scripts\sandbox_vm.ps1 start     # start VM (auto-stops 23:00 IST)
#   .\scripts\sandbox_vm.ps1 deploy    # build frontend, push code, (re)install services
#   .\scripts\sandbox_vm.ps1 tunnel    # forward 5173/8000/9099 to localhost (Ctrl+C to end)
#   .\scripts\sandbox_vm.ps1 seed      # load synthetic Academy demo data (needs tunnel open)
#   .\scripts\sandbox_vm.ps1 stop      # stop VM (stops compute + IP charges)
#   .\scripts\sandbox_vm.ps1 ssh       # shell on the VM
param([Parameter(Mandatory)][ValidateSet("status","start","stop","deploy","tunnel","seed","ssh")][string]$Action)

$ErrorActionPreference = "Stop"
$Project = "snappy-mapper-498223-b2"
$Zone    = "us-central1-a"
$Vm      = "ragaas-sandbox"
$Root    = Split-Path -Parent $PSScriptRoot
$Iap     = @("--project", $Project, "--zone", $Zone, "--tunnel-through-iap", "--quiet",
             "--strict-host-key-checking=no")

switch ($Action) {
  "status" { gcloud compute instances describe $Vm --project $Project --zone $Zone --format="value(status)" }
  "start"  { gcloud compute instances start $Vm --project $Project --zone $Zone }
  "stop"   { gcloud compute instances stop  $Vm --project $Project --zone $Zone }
  "ssh"    { gcloud compute ssh $Vm @Iap }

  "deploy" {
    Push-Location $Root
    try {
      # Dev-mode build: talks to 127.0.0.1:8000 + auth emulator 127.0.0.1:9099 (via tunnel).
      npx vite build --mode development --outDir ../.sandbox-dist --emptyOutDir
      if ($LASTEXITCODE) { throw "frontend build failed" }
      $tar = Join-Path $env:TEMP "ragaas-sandbox.tgz"
      tar -czf $tar --exclude "__pycache__" backend requirements.txt deploy scripts/academy_demo_seed.py .sandbox-dist
      if ($LASTEXITCODE) { throw "packaging failed" }
      gcloud compute scp $tar "${Vm}:/tmp/ragaas-sandbox.tgz" @Iap
      $remote = "set -e; sudo mkdir -p /opt/ragaas/app; " +
                "sudo find /opt/ragaas/app -mindepth 1 -maxdepth 1 ! -name .venv ! -name local_data -exec rm -rf {} +; " +
                "sudo tar -xzf /tmp/ragaas-sandbox.tgz -C /opt/ragaas/app; " +
                "sudo sed -i 's/\r$//' /opt/ragaas/app/deploy/sandbox/*; " +
                "sudo bash /opt/ragaas/app/deploy/sandbox/install.sh"
      gcloud compute ssh $Vm @Iap --command $remote
    } finally { Pop-Location }
  }

  "tunnel" {
    Write-Host "UI http://localhost:5173  API http://localhost:8000/docs  (Ctrl+C to close)"
    # --ssh-flag (not `-- -L ...`): PowerShell drops a bare `--` before native args.
    gcloud compute ssh $Vm @Iap --ssh-flag="-N" `
      --ssh-flag="-L 5173:127.0.0.1:5173" --ssh-flag="-L 8000:127.0.0.1:8000" --ssh-flag="-L 9099:127.0.0.1:9099"
  }

  "seed" { python (Join-Path $Root "scripts\academy_demo_seed.py") --api http://127.0.0.1:8000 }
}
