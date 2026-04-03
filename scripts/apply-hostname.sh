#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_FILE="$ROOT/stream-config.json"
AVAHI_CONF="/etc/avahi/avahi-daemon.conf"

read_values() {
  node - <<'NODE'
    const fs = require('fs');
    const path = process.env.CONFIG_FILE;
    try {
      const raw = fs.readFileSync(path, 'utf8');
      const json = JSON.parse(raw);
      const hostName = (json.hostName || '').trim();
      const mdnsName = (json.mdnsName || '').trim();
      console.log(JSON.stringify({ hostName, mdnsName }));
    } catch (err) {
      console.error('Failed to read config:', err.message);
      process.exit(1);
    }
  NODE
}

update_hosts() {
  local hn="$1"
  if [[ -f /etc/hosts ]]; then
    if grep -Eq '^127\.0\.1\.1\s' /etc/hosts; then
      sudo sed -i "s/^127\\.0\\.1\\.1.*/127.0.1.1 ${hn}/" /etc/hosts
    else
      echo "127.0.1.1 ${hn}" | sudo tee -a /etc/hosts >/dev/null
    fi
  fi
}

update_avahi() {
  local mdns="$1"
  local domain="local"
  if [[ ! -f "$AVAHI_CONF" ]]; then
    echo "[apply-hostname] Avahi config not found at $AVAHI_CONF; skipping"
    return 0
  fi

  sudo sed -i \
    -e "s/^host-name=.*/host-name=${mdns}/" \
    -e "s/^#*host-name=.*/host-name=${mdns}/" \
    -e "s/^domain-name=.*/domain-name=${domain}/" \
    "$AVAHI_CONF"

  if ! grep -Eq '^host-name=' "$AVAHI_CONF"; then
    echo "host-name=${mdns}" | sudo tee -a "$AVAHI_CONF" >/dev/null
  fi
  if ! grep -Eq '^domain-name=' "$AVAHI_CONF"; then
    echo "domain-name=${domain}" | sudo tee -a "$AVAHI_CONF" >/dev/null
  fi

  if command -v systemctl >/dev/null 2>&1; then
    sudo systemctl restart avahi-daemon || true
  else
    sudo service avahi-daemon restart || true
  fi
}

main() {
  export CONFIG_FILE
  local payload
  payload="$(read_values)"
  local hostName mdnsName
  hostName="$(echo "$payload" | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8'));console.log(d.hostName||'');")"
  mdnsName="$(echo "$payload" | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8'));console.log(d.mdnsName||'');")"

  if [[ -z "$hostName" ]]; then
    echo "[apply-hostname] hostName empty in config; nothing to apply"
    exit 0
  fi

  echo "[apply-hostname] setting hostname to $hostName"
  if command -v hostnamectl >/dev/null 2>&1; then
    sudo hostnamectl set-hostname "$hostName"
  else
    echo "$hostName" | sudo tee /etc/hostname >/dev/null
    sudo hostname "$hostName"
  fi

  update_hosts "$hostName"

  local mdns_to_use="$mdnsName"
  if [[ -z "$mdns_to_use" ]]; then
    mdns_to_use="$hostName"
  fi
  echo "[apply-hostname] setting mDNS name to ${mdns_to_use}.local"
  update_avahi "$mdns_to_use"

  echo "[apply-hostname] done"
}

main "$@"
