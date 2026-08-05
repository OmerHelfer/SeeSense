#!/usr/bin/env bash
# ============================================================================
# One-command remote deploy — run from your OWN machine (not the VM).
# SSHes into the GCP VM and runs deploy/update.sh there: pulls the latest
# code, rebuilds only what changed, restarts the service. No need to open
# the browser SSH tab and type commands by hand.
#
# Usage (from the repo root, in VS Code's terminal — Git Bash / WSL / any
# bash-capable shell):
#
#     bash deploy/remote-update.sh
#
# ── One-time setup (anyone on the team, first time only) ───────────────────
#   1. Install the gcloud CLI:  https://cloud.google.com/sdk/docs/install
#   2. gcloud auth login
#   3. gcloud config set project <PROJECT_ID>
#      (find PROJECT_ID at console.cloud.google.com — top bar, project
#       selector — it's the "project-xxxxxxxx" id, not the display name)
#
# ── If your VM's name/zone differs from the defaults below ─────────────────
#   INSTANCE_NAME=my-vm ZONE=us-central1-a bash deploy/remote-update.sh
# ============================================================================
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

# gcloud compute ssh handles key generation/registration automatically — no
# manual SSH key setup needed, unlike plain `ssh`. First run for a new user
# may prompt to create an SSH key pair; just accept the defaults.
gcloud compute ssh "$INSTANCE_NAME" --zone="$ZONE" \
  --command="cd $REMOTE_REPO_DIR && bash deploy/update.sh"
