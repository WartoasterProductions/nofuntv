#!/usr/bin/env bash
set -euo pipefail

# Forces GStreamer windows fullscreen/above and hides the cursor.
# Run under the desktop session (X) as the same user that runs the player.

DISPLAY=${DISPLAY:-:0}
XAUTHORITY=${XAUTHORITY:-/home/nofuntv/.Xauthority}
export DISPLAY XAUTHORITY

start_unclutter() {
  if ! pgrep -u "${USER}" unclutter >/dev/null 2>&1; then
    unclutter -idle 0 -root >/dev/null 2>&1 &
  fi
}

fullscreen_loop() {
  while true; do
    # Find GStreamer windows by name/class
    wmctrl -l | awk '/GStreamer|gst-launch/ {print $1}' | while read -r wid; do
      wmctrl -ir "$wid" -b add,fullscreen,above,skip_taskbar,skip_pager || true
    done
    sleep 3
  done
}

start_unclutter
fullscreen_loop
