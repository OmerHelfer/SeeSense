#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

FORCE_BUILD=false
[ "${1:-}" = "--build" ] && FORCE_BUILD=true

BEFORE="$(git rev-parse HEAD)"

echo "==> Pulling"
git pull --ff-only

AFTER="$(git rev-parse HEAD)"

if [ "$BEFORE" = "$AFTER" ] && [ "$FORCE_BUILD" = false ]; then
  echo "==> Already up to date; restarting anyway"
else
  if [ "$FORCE_BUILD" = true ] || ! git diff --quiet "$BEFORE" "$AFTER" -- Client/; then
    echo "==> Client changed — rebuilding frontend"
    cd Client
    npm install --silent
    npm run build -- --mode gcp
    cd "$REPO_DIR"
  else
    echo "==> No client changes — skipping frontend build"
  fi

  if ! git diff --quiet "$BEFORE" "$AFTER" -- Server/requirements.txt; then
    echo "==> requirements.txt changed — installing"
    python3 -m pip install --quiet --break-system-packages -r Server/requirements.txt
  fi
fi

echo "==> Restarting service"
sudo systemctl restart seesense
sleep 2
sudo systemctl --no-pager --lines=15 status seesense || true

echo
echo "==> Done. Logs:  sudo journalctl -u seesense -f"
