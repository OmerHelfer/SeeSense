#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

echo "==> Repo: $REPO_DIR"

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

echo "==> Checking GPU"
nvidia-smi --query-gpu=name,memory.total --format=csv,noheader

EXTERNAL_IP="$(curl -s -H 'Metadata-Flavor: Google' \
  http://metadata.google.internal/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip)"
DOMAIN="${EXTERNAL_IP//./-}.nip.io"
echo "==> External IP: $EXTERNAL_IP"
echo "==> Domain:      $DOMAIN"

echo "==> Installing system packages"
sudo apt-get update -qq
sudo apt-get install -y -qq certbot python3-pip libgl1 libglib2.0-0

if ! command -v node >/dev/null 2>&1; then
  echo "==> Installing Node.js 20"
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y -qq nodejs
fi
echo "    node $(node --version), npm $(npm --version)"

echo "==> Installing PyTorch (CUDA build)"
python3 -m pip install --quiet --break-system-packages torch==2.5.0 torchvision==0.20.0 \
  --index-url https://download.pytorch.org/whl/cu121

echo "==> Installing remaining Python dependencies"
python3 -m pip install --quiet --break-system-packages -r Server/requirements.txt

echo "==> Verifying CUDA is available to PyTorch"
python3 -c "import torch; assert torch.cuda.is_available(), 'CUDA NOT available — torch is the CPU build'; print(f'    OK: torch {torch.__version__} on {torch.cuda.get_device_name(0)}')"

echo "==> Building frontend"
cd Client
npm ci --silent 2>/dev/null || npm install --silent
npm run build -- --mode gcp
cd "$REPO_DIR"
echo "    built: $(du -sh Client/dist | cut -f1)"

if [ ! -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]; then
  echo "==> Requesting Let's Encrypt certificate for $DOMAIN"
  sudo certbot certonly --standalone --non-interactive --agree-tos \
    --register-unsafely-without-email -d "$DOMAIN"
else
  echo "==> Certificate for $DOMAIN already present, skipping"
fi

sudo chgrp -R ssl-cert /etc/letsencrypt/live /etc/letsencrypt/archive 2>/dev/null || {
  sudo groupadd -f ssl-cert
  sudo chgrp -R ssl-cert /etc/letsencrypt/live /etc/letsencrypt/archive
}
sudo chmod -R g+rX /etc/letsencrypt/live /etc/letsencrypt/archive
sudo usermod -aG ssl-cert "$USER"

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
  --timeout-keep-alive 75 \\
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

if ! systemctl is-active --quiet seesense; then
  echo ""
  echo "!!! seesense.service failed to start. Recent logs: !!!"
  sudo journalctl -u seesense -n 40 --no-pager
  echo ""
  echo "Fix the error above, then run:  sudo systemctl restart seesense"
  exit 1
fi

sudo systemctl --no-pager --lines=20 status seesense

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
