#!/usr/bin/env bash
set -euo pipefail

INSTANCE_NAME="${INSTANCE_NAME:-seesense}"
ZONE="${ZONE:-europe-central2-c}"
REMOTE_REPO_DIR="${REMOTE_REPO_DIR:-~/SeeSense}"

if ! command -v gcloud >/dev/null 2>&1; then
  cat <<'MISSING'
ERROR: gcloud CLI is not installed on this machine.

Install it (one-time, ~5 minutes):
  https://cloud.google.com/sdk/docs/install

Then authenticate (one-time):
  gcloud auth login
  gcloud config set project <YOUR_PROJECT_ID>

Then rerun this script.
MISSING
  exit 1
fi

echo "==> Deploying to '$INSTANCE_NAME' ($ZONE)..."
echo ""

gcloud compute ssh "$INSTANCE_NAME" --zone="$ZONE" \
  --command="cd $REMOTE_REPO_DIR && bash deploy/update.sh"
