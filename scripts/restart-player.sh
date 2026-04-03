#!/usr/bin/env bash
# restart-player.sh — called by the server after stream-config.json is saved.
#
# run-player.sh watches stream-config.json via inotifywait and restarts the
# GStreamer pipeline automatically when the file changes.  That mechanism is
# race-free and preserves the Wayland environment.
#
# If inotifywait is NOT installed (rare), we fall back to killing gst-launch
# so the sleep-2 polling loop picks up the new URL immediately.

if ! command -v inotifywait >/dev/null 2>&1; then
  pkill -f 'gst-launch-1.0' >/dev/null 2>&1 || true
fi
exit 0
