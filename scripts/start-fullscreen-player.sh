#!/usr/bin/env bash
set -euo pipefail

# Single-process launcher: waits for the display server, then runs the
# GStreamer player. Works under both Wayland (labwc) and X11.

# ── Detect Wayland vs X11 ────────────────────────────────────────────────
IS_WAYLAND=0
if [ -n "${WAYLAND_DISPLAY:-}" ] || [ "${XDG_SESSION_TYPE:-}" = "wayland" ]; then
  IS_WAYLAND=1
fi

# If we don't have WAYLAND_DISPLAY but labwc is running, try to find it
if [ "$IS_WAYLAND" -eq 0 ] && pgrep -u "$USER" labwc >/dev/null 2>&1; then
  for sock in /run/user/$(id -u)/wayland-*; do
    if [ -e "$sock" ]; then
      export WAYLAND_DISPLAY="$(basename "$sock")"
      export XDG_RUNTIME_DIR="/run/user/$(id -u)"
      IS_WAYLAND=1
      break
    fi
  done
fi

# ── Pick the right video sink ────────────────────────────────────────────
if [ "$IS_WAYLAND" -eq 1 ]; then
  # sync=false → never drop frames waiting for clock (critical on Pi 3B)
  # fullscreen=true → covers entire display, no desktop bleed-through
  VIDEO_SINK=${VIDEO_SINK:-waylandsink sync=false fullscreen=true}
  # Fallback if waylandsink unavailable
  if ! gst-inspect-1.0 waylandsink >/dev/null 2>&1; then
    VIDEO_SINK="autovideosink sync=false"
  fi
  export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
  echo "[start-fullscreen-player] Wayland detected (WAYLAND_DISPLAY=$WAYLAND_DISPLAY)" >&2
else
  DISPLAY=${DISPLAY:-:0}
  XAUTHORITY=${XAUTHORITY:-$HOME/.Xauthority}
  VIDEO_SINK=${VIDEO_SINK:-xvimagesink sync=false}
  if ! gst-inspect-1.0 "${VIDEO_SINK%% *}" >/dev/null 2>&1; then
    VIDEO_SINK=autovideosink
  fi
  export DISPLAY XAUTHORITY
  echo "[start-fullscreen-player] X11 mode (DISPLAY=$DISPLAY)" >&2
fi

AUDIO_SINK=${AUDIO_SINK:-autoaudiosink}
export VIDEO_SINK AUDIO_SINK

# ── Wait for compositor/X to be ready ────────────────────────────────────
wait_for_display() {
  for _ in {1..20}; do
    if [ "$IS_WAYLAND" -eq 1 ]; then
      # Check that the wayland socket exists
      if [ -e "${XDG_RUNTIME_DIR}/${WAYLAND_DISPLAY}" ]; then return 0; fi
    else
      if xdpyinfo >/dev/null 2>&1; then return 0; fi
    fi
    sleep 1
  done
  echo "[start-fullscreen-player] display not ready after 20s wait" >&2
  return 1
}

disable_screensaver() {
  # X11 only
  if [ "$IS_WAYLAND" -eq 0 ]; then
    xset s off >/dev/null 2>&1 || true
    xset -dpms >/dev/null 2>&1 || true
    xset s noblank >/dev/null 2>&1 || true
  fi
}

wait_for_display
disable_screensaver

exec "$(dirname "$0")/run-player.sh"
