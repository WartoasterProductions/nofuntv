#!/usr/bin/env bash
set -euo pipefail

LOGO=/home/nofuntv/nofuntv/assets/NoFunLogo.png

# ── 1. Fix port 80: authbind ─────────────────────────────────────────────
echo "[1/4] authbind for port 80..."
sudo apt-get install -y -qq authbind
sudo touch /etc/authbind/byport/80
sudo chmod 777 /etc/authbind/byport/80

# ── 2. Authbind wrapper for the server ───────────────────────────────────
cat > /home/nofuntv/nofuntv/scripts/start-server.sh << 'SCRIPT'
#!/usr/bin/env bash
exec authbind --deep node /home/nofuntv/nofuntv/server.js
SCRIPT
chmod +x /home/nofuntv/nofuntv/scripts/start-server.sh

# Tear down all old pm2 processes, restart only server via authbind
pm2 delete all 2>/dev/null || true
pm2 start /home/nofuntv/nofuntv/scripts/start-server.sh \
  --name nofuntv-server \
  --interpreter bash \
  --cwd /home/nofuntv/nofuntv \
  --restart-delay 2000 \
  --max-restarts 20
pm2 save --force
echo "[1/4] Server started via authbind."

# ── 3. LXDE autostart: player + wallpaper ────────────────────────────────
echo "[3/4] Configuring LXDE autostart..."
mkdir -p /home/nofuntv/.config/lxsession/LXDE-pi
cat > /home/nofuntv/.config/lxsession/LXDE-pi/autostart << AUTOSTART
@feh --bg-fill $LOGO
@unclutter -idle 0 -root
@bash /home/nofuntv/nofuntv/scripts/start-fullscreen-player.sh
AUTOSTART

# ── 4. Desktop: black, no icons, logo wallpaper ───────────────────────────
echo "[4/4] Configuring desktop appearance..."
mkdir -p /home/nofuntv/.config/pcmanfm/LXDE-pi
cat > /home/nofuntv/.config/pcmanfm/LXDE-pi/desktop-items-0.conf << PCMAN
[*]
wallpaper_mode=fit
wallpaper_common=1
wallpaper=$LOGO
show_documents=0
show_trash=0
show_mounts=0
desktop_bg=#000000
desktop_fg=#000000
desktop_shadow=#000000
desktop_font=Sans 12
PCMAN

# ── 5. Hide the taskbar panel entirely ───────────────────────────────────
mkdir -p /home/nofuntv/.config/lxpanel/LXDE-pi/panels
cat > /home/nofuntv/.config/lxpanel/LXDE-pi/panels/panel << 'PANEL'
Global {
  edge=bottom
  allign=left
  margin=0
  widthtype=percent
  width=100
  height=0
  transparent=1
  autohide=1
  heightwhenhidden=0
  setdocktype=1
  setpartialstrut=0
  usefontcolor=0
  fontsize=10
  background=0
  backgroundfile=
  iconsize=24
}
PANEL

echo ""
pm2 list
echo ""
echo "All done. Reboot the Pi to apply all changes."
