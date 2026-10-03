#!/bin/bash
# Runs on every boot; idempotent. Base packages only — the app is pushed and
# installed by scripts/sandbox_vm.ps1 deploy (deploy/sandbox/install.sh).
# No Docker: native services are lighter on a 1 GB e2-micro.
set -euo pipefail

# 2 GB swap — the Auth emulator (Java) + backend exceed 1 GB RAM at peak.
if [ ! -f /swapfile ]; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
swapon -a || true

if [ ! -f /opt/ragaas/.base-ready ]; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y --no-install-recommends \
    python3-venv python3-pip nginx openjdk-17-jre-headless curl ca-certificates xz-utils
  systemctl disable --now nginx || true   # install.sh enables it with our config

  # Node 20 (Debian 12 ships 18; firebase-tools needs >= 20)
  NODE_VER=v20.18.1
  curl -fsSL "https://nodejs.org/dist/${NODE_VER}/node-${NODE_VER}-linux-x64.tar.xz" \
    | tar -xJ -C /opt
  ln -sfn "/opt/node-${NODE_VER}-linux-x64" /opt/node
  ln -sf /opt/node/bin/node /usr/local/bin/node
  ln -sf /opt/node/bin/npm /usr/local/bin/npm
  ln -sf /opt/node/bin/npx /usr/local/bin/npx
  npm install -g firebase-tools@14
  ln -sf /opt/node/bin/firebase /usr/local/bin/firebase

  id ragaas >/dev/null 2>&1 || useradd --system --create-home --home-dir /opt/ragaas ragaas
  mkdir -p /opt/ragaas
  touch /opt/ragaas/.base-ready
fi
