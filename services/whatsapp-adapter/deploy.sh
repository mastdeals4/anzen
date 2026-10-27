#!/usr/bin/env bash
set -e

# ==============================================================================
# SAPJ Persistent WhatsApp Adapter Server Deployment Script
# Deploys OpenWA (Node + Chromium) with persistent storage and Cloudflare Named Tunnel
# ==============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "========================================================"
echo " Starting SAPJ WhatsApp Production Adapter Deployment"
echo "========================================================"

# 1. Check for required .env file
if [ ! -f .env ]; then
  if [ -f .env.production ]; then
    cp .env.production .env
    echo "[DEPLOY] Created .env from .env.production template."
  else
    echo "[ERROR] Missing .env file in $SCRIPT_DIR."
    echo "Please create .env with required keys (CLOUDFLARE_TUNNEL_TOKEN, ADAPTER_API_KEY, etc.)"
    exit 1
  fi
fi

# 2. Ensure persistent session directory exists
mkdir -p ./_sessions/sapj-business-whatsapp

# Clean up any stale Chromium locks before starting container
for lock in SingletonLock SingletonCookie SingletonSocket; do
  if [ -f "./_sessions/sapj-business-whatsapp/$lock" ]; then
    rm -f "./_sessions/sapj-business-whatsapp/$lock"
    echo "[DEPLOY] Cleaned stale lock file: $lock"
  fi
done

# 3. Build and launch Docker Compose stack
echo "[DEPLOY] Building and starting Docker containers..."
docker compose down || true
docker compose build --pull
docker compose up -d

# 4. Wait for healthy status
echo "[DEPLOY] Waiting for WhatsApp adapter container to become healthy..."
MAX_RETRIES=20
COUNT=0
HEALTHY=false

while [ $COUNT -lt $MAX_RETRIES ]; do
  if curl -sf http://127.0.0.1:3100/health >/dev/null 2>&1; then
    HEALTHY=true
    break
  fi
  echo -n "."
  sleep 2
  COUNT=$((COUNT + 1))
done

echo ""

if [ "$HEALTHY" = true ]; then
  echo "[SUCCESS] WhatsApp adapter container is HEALTHY and listening on 127.0.0.1:3100"
  curl -s http://127.0.0.1:3100/health
  echo ""
else
  echo "[WARNING] Health endpoint timed out. Dumping logs:"
  docker compose logs --tail=40 whatsapp-adapter
  exit 1
fi

echo "========================================================"
echo " SAPJ WhatsApp Adapter Persistent Deployment Complete"
echo "========================================================"
