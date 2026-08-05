# ============================================================================
# One-command remote deploy — run from your OWN machine (not the VM).
# SSHes into the GCP VM and runs deploy/update.sh there: pulls the latest
# code, rebuilds only what changed, restarts the service. No need to open
# the browser SSH tab and type commands by hand.
#
# Usage (from the repo root, in VS Code's PowerShell terminal):
#
#     .\deploy\remote-update.ps1
#
# -- One-time setup (anyone on the team, first time only) -------------------
#   1. Install the gcloud CLI:  https://cloud.google.com/sdk/docs/install
#   2. gcloud auth login
#   3. gcloud config set project <PROJECT_ID>
#      (find PROJECT_ID at console.cloud.google.com -- top bar, project
#       selector -- it's the "project-xxxxxxxx" id, not the display name)
#
# -- If your VM's name/zone differs from the defaults below -----------------
#   .\deploy\remote-update.ps1 -InstanceName my-vm -Zone us-central1-a
# ============================================================================
param(
    [string]$InstanceName = "seesense",
    [string]$Zone = "europe-central2-c",
    [string]$RemoteRepoDir = "~/SeeSense"
)

if (-not (Get-Command gcloud -ErrorAction SilentlyContinue)) {
    Write-Host "ERROR: gcloud CLI is not installed on this machine." -ForegroundColor Red
    Write-Host ""
    Write-Host "Install it (one-time, ~5 minutes):"
    Write-Host "  https://cloud.google.com/sdk/docs/install"
    Write-Host ""
    Write-Host "Then authenticate (one-time):"
    Write-Host "  gcloud auth login"
    Write-Host "  gcloud config set project <YOUR_PROJECT_ID>"
    Write-Host ""
    Write-Host "Then rerun this script."
    exit 1
}

Write-Host "==> Deploying to '$InstanceName' ($Zone)..." -ForegroundColor Cyan
Write-Host ""

# gcloud compute ssh handles key generation/registration automatically -- no
# manual SSH key setup needed. First run for a new user may prompt to create
# an SSH key pair; just accept the defaults.
gcloud compute ssh $InstanceName --zone=$Zone `
    --command="cd $RemoteRepoDir && bash deploy/update.sh"
