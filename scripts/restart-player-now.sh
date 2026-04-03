#!/usr/bin/env bash
set -e

# Restart the player with the correct Wayland env
pkill -f run-player || true
pkill -f gst-launch || true
sleep 1

bash /home/nofuntv/nofuntv/scripts/start-fullscreen-player.sh > /tmp/nofuntv-player.log 2>&1 &
echo "[1/2] player restarted (PID $!)"

sleep 5
echo "[2/2] player log:"
cat /tmp/nofuntv-player.log
