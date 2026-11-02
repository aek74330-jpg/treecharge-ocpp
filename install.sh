#!/bin/bash
# TREE CHARGE OCPP server — install / update on Ubuntu 22.04 or 24.04
#   git clone https://github.com/<you>/treecharge-ocpp && cd treecharge-ocpp && sudo bash install.sh
set -e
[ "$(id -u)" = 0 ] || { echo "Run with sudo"; exit 1; }
cd "$(dirname "$0")"
echo "== 1/5 Node.js"
command -v node >/dev/null || { apt-get update -y && apt-get install -y nodejs; }
node -v
echo "== 2/5 Files → /opt/treecharge-ocpp"
id treecharge >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin treecharge
mkdir -p /opt/treecharge-ocpp /var/lib/treecharge-ocpp
cp -r server.js package.json node_modules tools /opt/treecharge-ocpp/
chown -R treecharge:treecharge /var/lib/treecharge-ocpp
echo "== 3/5 Settings (/etc/treecharge-ocpp.env)"
if [ ! -f /etc/treecharge-ocpp.env ]; then
  KEY=$(openssl rand -hex 24)
  echo; echo "Paste the Apps Script web app link (ends with /exec):"; read -r HOOK_URL
  echo "Paste hookKey (Google Sheet → tab Config → row hookKey → column value):"; read -r HOOK_KEY
  cat > /etc/treecharge-ocpp.env <<EOT
PORT=9000
API_KEY=$KEY
HOOK_URL=$HOOK_URL
HOOK_KEY=$HOOK_KEY
DATA_DIR=/var/lib/treecharge-ocpp
CP_IDS=
EOT
  chmod 600 /etc/treecharge-ocpp.env
else
  echo "(kept the existing settings)"
fi
echo "== 4/5 Service"
cat > /etc/systemd/system/treecharge-ocpp.service <<'EOT'
[Unit]
Description=TREE CHARGE OCPP 1.6J server
After=network-online.target
Wants=network-online.target
[Service]
EnvironmentFile=/etc/treecharge-ocpp.env
WorkingDirectory=/opt/treecharge-ocpp
ExecStart=/usr/bin/node /opt/treecharge-ocpp/server.js
User=treecharge
Restart=always
RestartSec=3
[Install]
WantedBy=multi-user.target
EOT
systemctl daemon-reload
systemctl enable treecharge-ocpp >/dev/null
systemctl restart treecharge-ocpp
echo "== 5/5 Firewall (SSH 22 + OCPP 9000)"
if command -v ufw >/dev/null; then ufw allow 22/tcp >/dev/null; ufw allow 9000/tcp >/dev/null; ufw --force enable >/dev/null; fi
sleep 2
IP=$(curl -s -4 https://ifconfig.me || hostname -I | awk '{print $1}')
. /etc/treecharge-ocpp.env
echo
echo "================ DONE ================"
curl -s http://127.0.0.1:9000/health && echo
echo
echo "Send to the charger factory:"
echo "   OCPP server address : ws://$IP:9000/ocpp/"
echo "   Charge Point ID     : (the ID you set in the admin page, e.g. TCTEST01)"
echo "   Protocol            : OCPP 1.6J, no password"
echo
echo "Put in Apps Script → Project Settings → Script Properties (do NOT send these in chat):"
echo "   OCPP_URL = http://$IP:9000"
echo "   OCPP_KEY = $API_KEY"
echo
echo "Live log:  journalctl -u treecharge-ocpp -f"
