#!/usr/bin/env bash
# Ensure wlan0 comes up after boot.
# Retries up to 10 times, restarting NetworkManager each attempt.
set -u

for i in $(seq 1 10); do
  if ip link show wlan0 2>/dev/null | grep -q 'state UP'; then
    echo "[wifi-ensure] wlan0 is UP on attempt $i"
    exit 0
  fi
  echo "[wifi-ensure] wlan0 not UP, attempt $i — restarting NetworkManager"
  systemctl restart NetworkManager
  sleep 5
done

echo "[wifi-ensure] wlan0 still not UP after 10 attempts"
exit 1
