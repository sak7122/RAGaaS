#!/bin/bash
# Installs/updates the RAGaaS demo sandbox on the VM, in place.
# scripts/sandbox_vm.ps1 deploy unpacks the release into /opt/ragaas/app
# (keeping .venv) and then runs: sudo bash /opt/ragaas/app/deploy/sandbox/install.sh
#
# Safety: RAGAAS_ENV=development + memory stores, no credentials — the sandbox
# cannot reach Supabase, Vertex AI, Firestore or GCS. All services listen on
# 127.0.0.1 only; reach them through the IAP SSH tunnel.
set -euo pipefail

APP=/opt/ragaas/app
[ -f /opt/ragaas/.base-ready ] || { echo "base packages not ready yet (startup script still running)"; exit 1; }

if [ ! -x "$APP/.venv/bin/python" ]; then
  python3 -m venv "$APP/.venv"
fi
"$APP/.venv/bin/pip" install --quiet --upgrade pip
"$APP/.venv/bin/pip" install --quiet -r "$APP/requirements.txt"

mkdir -p "$APP/local_data"
chown -R ragaas:ragaas /opt/ragaas

install -m 0644 "$APP/deploy/sandbox/ragaas-emulator.service" /etc/systemd/system/
install -m 0644 "$APP/deploy/sandbox/ragaas-backend.service"  /etc/systemd/system/
install -m 0644 "$APP/deploy/sandbox/nginx.conf" /etc/nginx/sites-available/ragaas
ln -sfn /etc/nginx/sites-available/ragaas /etc/nginx/sites-enabled/ragaas
rm -f /etc/nginx/sites-enabled/default
nginx -t

systemctl daemon-reload
systemctl enable ragaas-emulator ragaas-backend nginx
systemctl restart ragaas-emulator ragaas-backend nginx

for _ in $(seq 1 45); do
  curl -fsS http://127.0.0.1:8000/api/health >/dev/null 2>&1 && { echo "backend healthy"; break; }
  sleep 2
done
for s in ragaas-emulator ragaas-backend nginx; do echo "$s: $(systemctl is-active $s)"; done
