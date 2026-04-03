# NoFunTV Orange Pi helper

Small setup to run a dark-mode web UI on port 80 where you can set an RTSP/HTTP stream, plus a player loop that keeps GStreamer fullscreen on boot. Designed to be run under PM2 so it restarts automatically.

## What’s here
- `server.js` – Express server on `0.0.0.0:80`, serving the config UI and `stream-config.json` API.
- `public/` – Dark high-contrast UI with red accents and NF wordmark; lets you set/clear the stream URL plus hostname/mDNS names.
- `scripts/run-player.sh` – Loop that reads the saved URL and runs `gst-launch-1.0 playbin ...`, falling back to on-screen text when unset/unavailable.
- `scripts/apply-hostname.sh` – Applies the saved `hostName` and `mdnsName` to the OS (needs sudo; edits hostnamectl, /etc/hosts, and avahi-daemon.conf).
- `ecosystem.config.js` – PM2 definition to keep the server and player alive on boot.

## Setup (once on the Orange Pi)
1. Install dependencies:
   - Node.js 18+ and npm
   - PM2: `npm install -g pm2`
   - GStreamer with codecs and sinks. For Debian/Ubuntu-based images:
     ```bash
     sudo apt update
     sudo apt install -y gstreamer1.0-tools gstreamer1.0-plugins-base gstreamer1.0-plugins-good gstreamer1.0-plugins-bad gstreamer1.0-plugins-ugly gstreamer1.0-libav
     ```
2. Copy this folder to the device (e.g., `scp -r nofuntv orangepi:/home/pi/nofuntv`).
3. Install node deps in the folder:
   ```bash
   cd /home/pi/nofuntv
   npm install
   ```
4. Make the player script executable:
   ```bash
   chmod +x scripts/run-player.sh
   ```
5. Make the hostname helper executable (optional, only if you will change host/mDNS via UI):
   ```bash
   chmod +x scripts/apply-hostname.sh
   ```

## Run with PM2 (recommended)
From the project directory:
```bash
pm2 start ecosystem.config.js
pm2 save          # remember across reboots
pm2 startup       # shows a command; run it to enable boot start
```

## Manual run (without PM2)
In one terminal start the web UI:
```bash
PORT=80 HOST=0.0.0.0 npm start
```
In another terminal start the player loop:
```bash
VIDEO_SINK=autovideosink AUDIO_SINK=autoaudiosink scripts/run-player.sh
```

## Selecting and using streams
- Browse to `http://nofuntv.local` (mDNS) or the device IP on your network.
- Enter an RTSP/HTTP URL (anything GStreamer can play) and optionally set `Device hostname` + `mDNS name` (without .local), then click **Save**. This updates `stream-config.json`.
- The player loop rereads the file each cycle; if the stream dies, it falls back to a message and retries.

## Applying hostname / mDNS changes
The UI only writes the desired names into `stream-config.json`. To apply them to the OS (requires sudo):
```bash
sudo scripts/apply-hostname.sh
```
- Applies `hostName` via `hostnamectl set-hostname` (or `hostname` fallback).
- Updates `/etc/hosts` `127.0.1.1` entry.
- Writes `host-name` and `domain-name` into `/etc/avahi/avahi-daemon.conf` and restarts Avahi.
- If `mdnsName` is blank, uses `hostName` for both.
Reboot after applying if you want to be certain every service picks up the new host.

## Overriding sinks / behavior
- `VIDEO_SINK`: pick a sink that suits the Orange Pi build. Examples: `glimagesink` (X11/Wayland), `kmssink` (DRM/KMS framebuffer), `fbdevsink` (older framebuffer). Default is `autovideosink`.
- `AUDIO_SINK`: default `autoaudiosink`; set `alsasink` or others if needed.
- `OVERLAY_FONT`: change the placeholder font (default `VT323 42`).

## Fallback states
- No stream saved: shows a black background with “Select a stream”.
- Stream configured but fails: shows “Stream unavailable”.
- To use the No Fun logo as a background, place a PNG at `assets/no-fun-logo.png` and adjust the GStreamer pipeline inside `scripts/run-player.sh` to overlay it (e.g., `pngdec` + `imagefreeze` + `compositor`).

## Notes
- The UI sticks to the No Fun dark/red palette. Feel free to swap the wordmark with the real logo in `public/index.html` if you have an asset URL.
- If you need HTTPS, put nginx in front and proxy to `localhost:80`; the app itself is HTTP only.
