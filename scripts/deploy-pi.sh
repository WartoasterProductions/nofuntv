#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# deploy-pi.sh  –  Deploy NoFunTV to Raspberry Pi 3B
#
# Usage (from bash/WSL):
#   ./scripts/deploy-pi.sh [pi-host] [pi-user]
#
# Or set env vars:
#   PI_HOST=10.0.0.82 PI_USER=pi ./scripts/deploy-pi.sh
#
# Requires: ssh, scp available locally.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

PI_HOST="${1:-${PI_HOST:-10.0.0.82}}"
PI_USER="${2:-${PI_USER:-pi}}"
PI_TARGET="$PI_USER@$PI_HOST"
DEPLOY_DIR="/home/$PI_USER/nofuntv"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  NoFunTV → Pi 3B deploy"
echo "  Target : $PI_TARGET"
echo "  Deploy : $DEPLOY_DIR"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ── 1. Check SSH ─────────────────────────────────────────────────────────────
echo ""
echo "[1/4] Checking SSH connectivity..."
if ! ssh -o ConnectTimeout=8 "$PI_TARGET" true 2>/dev/null; then
  echo ""
  echo "  ✗ Cannot reach $PI_TARGET."
  exit 1
fi
echo "  ✓ SSH OK"

# ── 2. Copy project via scp ──────────────────────────────────────────────────
echo ""
echo "[2/4] Copying project files via scp..."

# Make target directory on Pi
ssh "$PI_TARGET" "mkdir -p $DEPLOY_DIR/assets $DEPLOY_DIR/public $DEPLOY_DIR/scripts"

# Copy each piece (scp -r doesn't support excludes, so we do it explicitly)
scp "$ROOT/server.js"            "$PI_TARGET:$DEPLOY_DIR/"
scp "$ROOT/package.json"         "$PI_TARGET:$DEPLOY_DIR/"
scp "$ROOT/ecosystem.config.js"  "$PI_TARGET:$DEPLOY_DIR/"
scp "$ROOT/stream-config.json"   "$PI_TARGET:$DEPLOY_DIR/"
scp "$ROOT/assets/NoFunLogo.png" "$PI_TARGET:$DEPLOY_DIR/assets/"
scp "$ROOT/public/index.html"    "$PI_TARGET:$DEPLOY_DIR/public/"
scp "$ROOT/public/app.js"        "$PI_TARGET:$DEPLOY_DIR/public/"
scp "$ROOT/public/style.css"     "$PI_TARGET:$DEPLOY_DIR/public/"
scp "$ROOT/scripts/"*.sh         "$PI_TARGET:$DEPLOY_DIR/scripts/"

# Copy standalone agent.js (can be run separately if needed)
if [[ -f "$ROOT/gst-frontend/agent.js" ]]; then
  scp "$ROOT/gst-frontend/agent.js" "$PI_TARGET:$DEPLOY_DIR/agent.js"
fi

echo "  ✓ Copy complete"

# ── 3. Remote provisioning ───────────────────────────────────────────────────
echo ""
echo "[3/4] Provisioning Pi..."
ssh "$PI_TARGET" "bash $DEPLOY_DIR/scripts/setup-pi-remote.sh $DEPLOY_DIR $PI_USER"

# ── 4. Done ──────────────────────────────────────────────────────────────────
echo ""
echo "[4/4] Done"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  NoFunTV is running on the Pi.  Control panel:"
echo "  http://$PI_HOST"
echo ""
echo "  WebSocket agent:  ws://$PI_HOST:80"
echo "  mDNS:             _nofuntv._tcp (auto-discovered by frontend)"
echo ""
echo "  Useful commands (SSH in first):"
echo "    pm2 logs           – live logs for all processes"
echo "    pm2 restart all    – restart everything"
echo "    pm2 list           – process status"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
