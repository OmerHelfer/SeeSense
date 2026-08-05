#!/usr/bin/env bash
# ============================================================================
# Redeploy after pushing to main.
#
# A plain VM has no git integration — pushing to GitHub does not touch it. Run
# this on the VM to pull the new code and restart:
#
#   cd ~/SeeSense && bash deploy/update.sh
#
# The frontend is only rebuilt when something under Client/ actually changed,
# since `npm run build` is the slow part and most pushes are server-side.
# Force it with:  bash deploy/update.sh --build
# ============================================================================
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
  # Rebuild the bundle only if the client actually changed between the two
  # commits — a server-only push does not need a two-minute npm build.
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
    # torch stays on the CUDA build already installed: it is unpinned in
    # requirements.txt, so pip treats the existing CUDA wheel as satisfying it.
    python3 -m pip install --quiet --break-system-packages -r Server/requirements.txt
  fi
fi

echo "==> Restarting service"
sudo systemctl restart seesense
sleep 2
sudo systemctl --no-pager --lines=15 status seesense || true

echo
echo "==> Done. Logs:  sudo journalctl -u seesense -f"
