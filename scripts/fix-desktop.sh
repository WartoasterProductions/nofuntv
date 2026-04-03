#!/usr/bin/env bash
set -euo pipefail

LOGO=/home/nofuntv/nofuntv/assets/NoFunLogo.png
PLAYER=/home/nofuntv/nofuntv/scripts/start-fullscreen-player.sh

# ═══════════════════════════════════════════════════════════════════════════
# This Pi runs labwc (Wayland). Desktop config is totally different from
# LXDE/X11. The key files:
#   ~/.config/labwc/autostart        ← replaces system /etc/xdg/labwc/autostart
#   ~/.config/pcmanfm/default/       ← pcmanfm desktop config (default profile)
# ═══════════════════════════════════════════════════════════════════════════

# ── 1. labwc autostart: pcmanfm desktop (wallpaper), player, NO panel ─────
echo "[1/2] Writing labwc autostart..."
mkdir -p ~/.config/labwc
cat > ~/.config/labwc/autostart << AUTOSTART
# Desktop wallpaper/icons via pcmanfm (no --profile = uses "default")
/usr/bin/lwrespawn /usr/bin/pcmanfm-pi &

# Hide mouse cursor
unclutter -idle 0 -root &

# GStreamer player
bash $PLAYER &

# kanshi for display hotplug
/usr/bin/kanshi &

# XDG autostart entries (polkit etc)
/usr/bin/lxsession-xdg-autostart
AUTOSTART
echo "  Written: ~/.config/labwc/autostart"
echo "  NOTE: wf-panel-pi (taskbar) is NOT started = no taskbar"

# ── 2. pcmanfm "default" profile: black bg, no icons, logo wallpaper ─────
echo "[2/2] Writing pcmanfm default desktop config..."
mkdir -p ~/.config/pcmanfm/default
cat > ~/.config/pcmanfm/default/desktop-items-0.conf << PCMAN
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
echo "  Written: ~/.config/pcmanfm/default/desktop-items-0.conf"

echo ""
echo "Done. Reboot to apply."
