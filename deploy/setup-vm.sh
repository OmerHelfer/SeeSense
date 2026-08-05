#!/usr/bin/env bash
# ============================================================================
# One-time setup for a GCP Compute Engine VM (Deep Learning image, T4 GPU).
#
# Brings up the whole app as a single HTTPS service:
#   - CUDA build of PyTorch (the plain PyPI wheel is CPU-only — that mistake
#     silently costs ~10x on every frame, so it is installed explicitly first)
#   - React build served by FastAPI itself, so UI + API + WebSocket share one
#     origin, one port and one certificate
#   - A real Let's Encrypt certificate via nip.io, so any device trusts it with
#     no per-device setup
#   - systemd, so the server survives closing the SSH tab and restarts on boot
#
# Usage (on the VM):
#   cd ~/SeeSense && bash deploy/setup-vm.sh
# ============================================================================
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

echo "==> Repo: $REPO_DIR"

# ---------------------------------------------------------------------------
# 0. Secrets. Server/.env is gitignored, so a fresh clone never has one — and
#    without it the app silently falls back to a localhost Mongo that is not
#    running here. Fail now, with instructions, rather than at the first login.
# ---------------------------------------------------------------------------
if [ ! -f Server/.env ]; then
  cat <<'MISSING'

  ERROR: Server/.env is missing.

  It is gitignored (it holds secrets), so it does not arrive with the clone.
  Create it on the VM before running this script:

      nano Server/.env

  It needs at least:

      MONGODB_URI=<your MongoDB Atlas connection string>
      SECRET_KEY=<your JWT secret>
      EMAIL_ADDRESS=<...>
      EMAIL_PASSWORD=<...>

  Copy the values from your local Server/.env.

MISSING
  exit 1
fi

# ---------------------------------------------------------------------------
# 1. Confirm the GPU is actually visible before installing anything for it.
# ---------------------------------------------------------------------------
echo "==> Checking GPU"
nvidia-smi --query-gpu=name,memory.total --format=csv,noheader

# ---------------------------------------------------------------------------
# 2. Derive the public hostname from the VM's external IP.
#    nip.io resolves <dashed-ip>.nip.io straight back to that IP, which gives us
#    a real hostname for free — certificate authorities will not issue for a
#    bare IP address, so this is what makes trusted HTTPS possible without
#    buying a domain.
# ---------------------------------------------------------------------------
EXTERNAL_IP="$(curl -s -H 'Metadata-Flavor: Google' \
  http://metadata.google.internal/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip)"
DOMAIN="${EXTERNAL_IP//./-}.nip.io"
echo "==> External IP: $EXTERNAL_IP"
echo "==> Domain:      $DOMAIN"

# ---------------------------------------------------------------------------
# 3. System packages: Node (for the frontend build) and certbot (for TLS).
# ---------------------------------------------------------------------------
echo "==> Installing system packages"
sudo apt-get update -qq
sudo apt-get install -y -qq certbot

if ! command -v node >/dev/null 2>&1; then
  echo "==> Installing Node.js 20"
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y -qq nodejs
fi
echo "    node $(node --version), npm $(npm --version)"

# ---------------------------------------------------------------------------
# 4. Python deps. Order matters: the CUDA build of torch goes in FIRST, so the
#    unpinned `torch` in requirements.txt is already satisfied and pip does not
#    replace it with the CPU-only wheel from PyPI.
# ---------------------------------------------------------------------------
echo "==> Installing PyTorch (CUDA build)"
python3 -m pip install --quiet torch==2.5.0 torchvision==0.20.0 \
  --index-url https://download.pytorch.org/whl/cu121

echo "==> Installing remaining Python dependencies"
python3 -m pip install --quiet -r Server/requirements.txt

echo "==> Verifying CUDA is available to PyTorch"
python3 -c "import torch; assert torch.cuda.is_available(), 'CUDA NOT available — torch is the CPU build'; print(f'    OK: torch {torch.__version__} on {torch.cuda.get_device_name(0)}')"

# ---------------------------------------------------------------------------
# 5. Frontend build. --mode gcp bakes in no API host, so the bundle calls
#    whatever origin serves it (see Client/.env.gcp).
# ---------------------------------------------------------------------------
echo "==> Building frontend"
cd Client
npm ci --silent 2>/dev/null || npm install --silent
npm run build -- --mode gcp
cd "$REPO_DIR"
echo "    built: $(du -sh Client/dist | cut -f1)"

# ---------------------------------------------------------------------------
# 6. TLS certificate. certbot --standalone binds port 80 briefly to prove we
#    control the hostname, so port 80 must be open in the GCP firewall.
# ---------------------------------------------------------------------------
if [ ! -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]; then
  echo "==> Requesting Let's Encrypt certificate for $DOMAIN"
  sudo certbot certonly --standalone --non-interactive --agree-tos \
    --register-unsafely-without-email -d "$DOMAIN"
else
  echo "==> Certificate for $DOMAIN already present, skipping"
fi

# The service runs as a non-root user but must read the private key.
sudo chgrp -R ssl-cert /etc/letsencrypt/live /etc/letsencrypt/archive 2>/dev/null || {
  sudo groupadd -f ssl-cert
  sudo chgrp -R ssl-cert /etc/letsencrypt/live /etc/letsencrypt/archive
}
sudo chmod -R g+rX /etc/letsencrypt/live /etc/letsencrypt/archive
sudo usermod -aG ssl-cert "$USER"

# ---------------------------------------------------------------------------
# 7. systemd unit — keeps the server alive after the SSH tab closes, restarts
#    it on crash, and brings it back automatically when the VM is started again.
#    CAP_NET_BIND_SERVICE lets a non-root process bind 443, so the URL needs no
#    port number.
# ---------------------------------------------------------------------------
echo "==> Installing systemd service"
sudo tee /etc/systemd/system/seesense.service >/dev/null <<UNIT
[Unit]
Description=SeeSense server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$USER
Group=ssl-cert
WorkingDirectory=$REPO_DIR/Server
ExecStart=$(command -v python3) -m uvicorn main:app \\
  --host 0.0.0.0 --port 443 \\
  --ssl-keyfile /etc/letsencrypt/live/$DOMAIN/privkey.pem \\
  --ssl-certfile /etc/letsencrypt/live/$DOMAIN/fullchain.pem
Restart=always
RestartSec=5
AmbientCapabilities=CAP_NET_BIND_SERVICE

[Install]
WantedBy=multi-user.target
UNIT

sudo systemctl daemon-reload
sudo systemctl enable seesense
sudo systemctl restart seesense

sleep 3
sudo systemctl --no-pager --lines=20 status seesense || true

cat <<DONE

============================================================
  Setup complete.

  Your URL:  https://$DOMAIN

  Useful commands:
    sudo systemctl status seesense     # is it running?
    sudo journalctl -u seesense -f     # live logs
    sudo systemctl restart seesense    # restart
    bash deploy/update.sh              # pull + rebuild + restart

  If the page does not load, check the GCP firewall allows
  inbound TCP on ports 80 and 443.
============================================================
DONE
