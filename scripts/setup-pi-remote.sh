#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# setup-pi-remote.sh  –  Runs ON the Pi after files are copied over.
# Called by deploy-pi.sh via ssh. Do not run manually unless you know what
# you're doing.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

DEPLOY_DIR="${1:-/home/pi/nofuntv}"
PI_USER="${2:-pi}"
LOGO_PATH="$DEPLOY_DIR/assets/NoFunLogo.png"

section() { echo ""; echo "  ── $*"; }

# ── System packages ──────────────────────────────────────────────────────────
section "System packages"
export DEBIAN_FRONTEND=noninteractive
sudo apt-get update -qq

PKGS_NEEDED=()
for pkg in \
    nodejs npm \
    gstreamer1.0-tools \
    gstreamer1.0-plugins-base \
    gstreamer1.0-plugins-good \
    gstreamer1.0-plugins-bad \
    gstreamer1.0-plugins-ugly \
    gstreamer1.0-libav \
    gstreamer1.0-x \
    gstreamer1.0-alsa \
    libgstreamer-plugins-bad1.0-dev \
    libsrt1.5-openssl-dev \
    avahi-utils \
    unclutter \
    wmctrl \
    inotify-tools \
    x11-xserver-utils \
    feh; do
  if ! dpkg -s "$pkg" >/dev/null 2>&1; then
    PKGS_NEEDED+=("$pkg")
  fi
done

if [[ ${#PKGS_NEEDED[@]} -gt 0 ]]; then
  echo "    Installing: ${PKGS_NEEDED[*]}"
  sudo apt-get install -y -qq "${PKGS_NEEDED[@]}"
else
  echo "    All system packages already installed."
fi

# ── Node / npm deps ──────────────────────────────────────────────────────────
section "npm install"
cd "$DEPLOY_DIR"
npm install --omit=dev 2>&1 | tail -5

# ── pm2 ──────────────────────────────────────────────────────────────────────
section "pm2"
if ! command -v pm2 >/dev/null 2>&1; then
  echo "    Installing pm2 globally..."
  sudo npm install -g pm2 2>&1 | tail -3
else
  echo "    pm2 $(pm2 --version) already installed"
fi

# ── Script permissions ───────────────────────────────────────────────────────
section "Script permissions"
chmod +x "$DEPLOY_DIR"/scripts/*.sh

# ── DRM / KMS access (required for kmssink) ──────────────────────────────────
section "DRM group membership"
if ! groups "$PI_USER" | grep -qw video; then
  sudo usermod -aG video,render "$PI_USER"
  echo "    Added $PI_USER to video,render groups (reboot required to take effect)"
else
  echo "    $PI_USER already in video group"
fi

# ── WiFi power-save off (prevents Pi dropping off network under CPU load) ─────
section "WiFi power-save"
NM_CONF=/etc/NetworkManager/conf.d/wifi-powersave-off.conf
if [[ ! -f "$NM_CONF" ]] || ! grep -q 'wifi.powersave = 2' "$NM_CONF" 2>/dev/null; then
  printf '[connection]\nwifi.powersave = 2\n' | sudo tee "$NM_CONF" > /dev/null
  echo "    WiFi power-save disabled via NetworkManager config"
else
  echo "    WiFi power-save already disabled"
fi

# ── Desktop wallpaper ────────────────────────────────────────────────────────
section "Desktop wallpaper"
if [[ -f "$LOGO_PATH" ]]; then
  # ── LXDE / pcmanfm (Raspberry Pi OS default) ──
  PCMANFM_CFG="$HOME/.config/pcmanfm/LXDE-pi"
  mkdir -p "$PCMANFM_CFG"
  cat > "$PCMANFM_CFG/desktop-items-0.conf" <<EOF
[*]
wallpaper_mode=fit
wallpaper_common=1
wallpaper=$LOGO_PATH
EOF
  # Set it live if X is already running
  if DISPLAY="${DISPLAY:-:0}" pcmanfm --set-wallpaper "$LOGO_PATH" --wallpaper-mode=fit 2>/dev/null; then
    echo "    Wallpaper set live via pcmanfm"
  else
    echo "    Wallpaper config written (will apply on next desktop login)"
  fi

  # ── feh fallback in LXDE autostart ──────────────────────────────────────
  AUTOSTART_DIR="$HOME/.config/lxsession/LXDE-pi"
  mkdir -p "$AUTOSTART_DIR"
  AUTOSTART_FILE="$AUTOSTART_DIR/autostart"
  if [[ -f "$AUTOSTART_FILE" ]]; then
    sed -i '/feh.*--bg/d' "$AUTOSTART_FILE"
  fi
  echo "@feh --bg-fill $LOGO_PATH" >> "$AUTOSTART_FILE"
  echo "    feh autostart entry added"
else
  echo "    Logo not found at $LOGO_PATH — skipping wallpaper"
fi

# ── pm2 systemd startup ──────────────────────────────────────────────────────
section "pm2 systemd startup"
STARTUP_CMD=$(pm2 startup systemd -u "$PI_USER" --hp "$HOME" 2>&1 | grep 'sudo env' | head -1 || true)
if [[ -n "$STARTUP_CMD" ]]; then
  echo "    Running: $STARTUP_CMD"
  eval "$STARTUP_CMD"
else
  sudo env PATH="$PATH:/usr/bin:/usr/local/bin" \
    "$(command -v pm2)" startup systemd -u "$PI_USER" --hp "$HOME" 2>/dev/null || true
fi

# ── Start / restart ecosystem ────────────────────────────────────────────────
section "pm2 ecosystem"
cd "$DEPLOY_DIR"
pm2 delete ecosystem.config.js 2>/dev/null || true
pm2 start ecosystem.config.js
pm2 save --force
echo "    pm2 ecosystem started and saved"

echo ""
pm2 list
echo ""
echo "  ✓ Setup complete"
