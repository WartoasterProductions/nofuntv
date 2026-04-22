#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_FILE="$ROOT/stream-config.json"
# Fallbacks in case the config lives elsewhere on the device
if [[ ! -f "$CONFIG_FILE" ]]; then
  if [[ -f "$ROOT/../stream-config.json" ]]; then
    CONFIG_FILE="$ROOT/../stream-config.json"
  elif [[ -f "$HOME/stream-config.json" ]]; then
    CONFIG_FILE="$HOME/stream-config.json"
  fi
fi
CONFIG_DIR="$(dirname "$CONFIG_FILE")"
CONFIG_BASE="$(basename "$CONFIG_FILE")"

VIDEO_SINK="${VIDEO_SINK:-xvimagesink sync=false}"
AUDIO_SINK="${AUDIO_SINK:-autoaudiosink}"
OVERLAY_FONT="${OVERLAY_FONT:-VCR OSD Mono 42}" # CRT-style monospace
LOGO_PATH="${LOGO_PATH:-$ROOT/assets/NoFunLogo.png}"
CONFIG_SIG=""
VIDEO_WIDTH="${VIDEO_WIDTH:-1920}"
VIDEO_HEIGHT="${VIDEO_HEIGHT:-1080}"
PLACEHOLDER_DURATION="${PLACEHOLDER_DURATION:-5}"
RTSP_LATENCY="${RTSP_LATENCY:-200}"
RTSP_PROTOCOLS="${RTSP_PROTOCOLS:-udp+tcp}"
RETRY_DELAY="${RETRY_DELAY:-3}"
RTP_JITTER="${RTP_JITTER:-200}"
RTP_CAPS="application/x-rtp,media=video,encoding-name=H264,payload=96"

# ── Auto-detect best hardware decoder ────────────────────────────────────────
detect_decoder() {
  for dec in v4l2h264dec mppvideodec nvh264dec avdec_h264; do
    if gst-inspect-1.0 "$dec" >/dev/null 2>&1; then
      echo "$dec"
      return
    fi
  done
  echo "avdec_h264"
}
DECODER="${DECODER:-$(detect_decoder)}"
echo "[player] decoder: $DECODER" >&2
HAS_INOTIFY=0
if command -v inotifywait >/dev/null 2>&1; then
  HAS_INOTIFY=1
fi

# If the chosen sink is unavailable, fall back to autovideosink so we at least render.
if ! gst-inspect-1.0 "${VIDEO_SINK%% *}" >/dev/null 2>&1; then
  echo "[player] sink ${VIDEO_SINK%% *} not found; falling back to autovideosink" >&2
  VIDEO_SINK="autovideosink"
fi

# Launches a long-running placeholder (no timeout) and returns its PID so we can
# keep a static "Select a stream" screen alive until the config changes.
start_idle_placeholder() {
  local message="$1"
  local pid=""

  echo "[player] placeholder (idle): $message" >&2

  if [[ -f "$LOGO_PATH" ]]; then
    gst-launch-1.0 -e \
      filesrc location="$LOGO_PATH" ! pngdec ! imagefreeze ! video/x-raw,framerate=30/1 ! \
      videoconvert ! \
      textoverlay text="$message" font-desc="$OVERLAY_FONT" halignment=center valignment=top shaded-background=true \
      ! videoscale ! video/x-raw,width=$VIDEO_WIDTH,height=$VIDEO_HEIGHT,pixel-aspect-ratio=1/1 \
      ! videoconvert ! $VIDEO_SINK \
      2>/dev/null &
    pid=$!
    sleep 1
    if ! kill -0 "$pid" >/dev/null 2>&1; then
      echo "[player] logo placeholder exited; falling back to test pattern" >&2
      pid=""
    fi
  fi

  if [[ -z "$pid" ]]; then
    gst-launch-1.0 -e \
      videotestsrc pattern=smpte ! video/x-raw,framerate=30/1 ! \
      textoverlay text="$message" font-desc="$OVERLAY_FONT" halignment=center valignment=center shaded-background=true \
      ! videoscale ! video/x-raw,width=$VIDEO_WIDTH,height=$VIDEO_HEIGHT,pixel-aspect-ratio=1/1 \
      ! videoconvert ! $VIDEO_SINK \
      2>/dev/null &
    pid=$!
  fi

  echo "$pid"
}

wait_for_config_event() {
  if [[ "$HAS_INOTIFY" -eq 1 ]]; then
    # -t 3: wake up every 3 seconds even without a file event so the stream-death
    # check (kill -0 $CHILD_PID) runs promptly when gst-launch exits.
    inotifywait -q -t 3 -e close_write,move,create,delete "$CONFIG_FILE" "$CONFIG_DIR" >/dev/null 2>&1 || true
  else
    sleep 2
  fi
}

config_sig() {
  if command -v sha1sum >/dev/null 2>&1; then
    sha1sum "$CONFIG_FILE" 2>/dev/null | awk '{print $1}' || echo "missing"
    return
  fi

  node - <<'NODE' || true
    const fs = require('fs');
    const crypto = require('crypto');
    const p = process.env.CONFIG_FILE;
    try {
      const b = fs.readFileSync(p);
      const h = crypto.createHash('sha1').update(b).digest('hex');
      console.log(h);
    } catch (e) {
      console.log('missing');
    }
NODE
}

read_stream_url() {
  node -e "
    const fs = require('fs');
    const p  = process.env.CONFIG_FILE;
    try {
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      const mode = (j.mode || 'pull').trim();
      if (mode === 'push') {
        const proto = (j.protocol || 'udp').trim();
        const port  = j.receivePort || 5000;
        if (proto === 'srt') { console.log('srt://0.0.0.0:' + port); }
        else                 { console.log('rtp://0.0.0.0:' + port); }
      } else {
        const u = (j.streamUrl || '').trim();
        if (u) console.log(u);
      }
    } catch (e) {
      console.error('[player] config read error:', e.message);
      process.exit(0);
    }
  " || true
}

get_device_ip() {
  local ip=""
  # Try hostname -I first (space-separated list of IPs)
  if command -v hostname >/dev/null 2>&1 && hostname -I >/dev/null 2>&1; then
    ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  fi

  # Fallback: ip route
  if [[ -z "$ip" ]] && command -v ip >/dev/null 2>&1; then
    ip="$(ip route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if ($i=="src"){print $(i+1); exit}}')"
  fi

  # Fallback: parse ip addr for first non-loopback IPv4
  if [[ -z "$ip" ]] && command -v ip >/dev/null 2>&1; then
    ip="$(ip -4 addr show scope global 2>/dev/null | awk '/inet /{gsub(/\/.*/, "", $2); print $2; exit}')"
  fi

  # Validate: must look like an IPv4 address (not a hostname)
  if [[ ! "$ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    ip=""
  fi

  echo "$ip"
}

# Block until we get a valid IPv4 address (max ~60 s)
wait_for_ip() {
  local ip="" attempts=0
  while [[ $attempts -lt 30 ]]; do
    ip="$(get_device_ip)"
    if [[ -n "$ip" ]]; then
      echo "$ip"
      return 0
    fi
    echo "[player] waiting for network… (attempt $((attempts+1)))" >&2
    sleep 2
    attempts=$((attempts + 1))
  done
  # If we still have nothing, try ifconfig as last resort
  if command -v ifconfig >/dev/null 2>&1; then
    ip="$(ifconfig 2>/dev/null | awk '/inet / && !/127\.0\.0\.1/{gsub(/addr:/, "", $2); print $2; exit}')"
    if [[ -n "$ip" ]]; then echo "$ip"; return 0; fi
  fi
  echo "?.?.?.?"
}

# Launch an appropriate pipeline for the URL type; sets CHILD_PID
start_stream() {
  local url="$1"

  # ── RTP/UDP push receive (rtp://0.0.0.0:5000 or rtp://:5000) ──────────────
  if [[ "$url" =~ ^rtp:// ]]; then
    local rtp_port
    rtp_port=$(echo "$url" | grep -oP ':\K[0-9]+' | head -1)
    rtp_port=${rtp_port:-5000}
    echo "[player] using RTP/UDP receiver on port $rtp_port (decoder=$DECODER)" >&2
    local ip overlay
    ip="$(wait_for_ip)"
    # Restore previous working overlay format (uppercase) to match logs
    overlay="$(printf 'LISTENING FOR STREAM AT %s (%s)' "$url" "${ip}")"
    gst-launch-1.0 -e \
      compositor name=comp sink_0::xpos=0 sink_0::ypos=0 sink_0::zorder=0 sink_1::xpos=0 sink_1::ypos=0 sink_1::zorder=1 sink_0::alpha=1.0 sink_1::alpha=1.0 ! \
      videoconvert ! $VIDEO_SINK \
      videotestsrc pattern=smpte is-live=true ! video/x-raw,framerate=30/1 ! \
      textoverlay text="$overlay" font-desc="$OVERLAY_FONT" halignment=center valignment=center deltay=0 shaded-background=true ! \
      videoscale ! video/x-raw,width=$VIDEO_WIDTH,height=$VIDEO_HEIGHT,pixel-aspect-ratio=1/1 ! \
      comp.sink_0 \
      udpsrc port="$rtp_port" caps="$RTP_CAPS" buffer-size=2097152 ! \
      rtpjitterbuffer latency="$RTP_JITTER" ! rtph264depay ! h264parse ! \
      $DECODER ! videoconvert ! videoscale ! video/x-raw,width=$VIDEO_WIDTH,height=$VIDEO_HEIGHT,pixel-aspect-ratio=1/1 ! \
      comp.sink_1 \
      2>/dev/null &
    CHILD_PID=$!
    return
  fi

  # ── SRT receive (srt://0.0.0.0:5000 or srt://sender:5000) ─────────────────
  if [[ "$url" =~ ^srt:// ]]; then
    echo "[player] using SRT receiver: $url (decoder=$DECODER)" >&2
    local ip overlay
    ip="$(wait_for_ip)"
    # Restore previous working overlay format (uppercase) to match logs
    overlay="$(printf 'LISTENING FOR STREAM AT %s (%s)' "$url" "${ip}")"
    gst-launch-1.0 -e \
      compositor name=comp sink_0::xpos=0 sink_0::ypos=0 sink_0::zorder=0 sink_1::xpos=0 sink_1::ypos=0 sink_1::zorder=1 sink_0::alpha=1.0 sink_1::alpha=1.0 ! \
      videoconvert ! $VIDEO_SINK \
      videotestsrc pattern=smpte is-live=true ! video/x-raw,framerate=30/1 ! \
      textoverlay text="$overlay" font-desc="$OVERLAY_FONT" halignment=center valignment=center deltay=0 shaded-background=true ! \
      videoscale ! video/x-raw,width=$VIDEO_WIDTH,height=$VIDEO_HEIGHT,pixel-aspect-ratio=1/1 ! \
      comp.sink_0 \
      srtsrc uri="$url" latency=120 caps="$RTP_CAPS" ! \
      rtpjitterbuffer latency="$RTP_JITTER" ! rtph264depay ! h264parse ! \
      $DECODER ! videoconvert ! videoscale ! video/x-raw,width=$VIDEO_WIDTH,height=$VIDEO_HEIGHT,pixel-aspect-ratio=1/1 ! \
      comp.sink_1 \
      2>/dev/null &
    CHILD_PID=$!
    return
  fi

  if [[ "$url" =~ ^rtsp:// ]]; then
    echo "[player] using RTSP pipeline via playbin (protocols=${RTSP_PROTOCOLS}, latency=${RTSP_LATENCY}ms)" >&2
    # playbin auto-selects the highest-ranked decoder (v4l2h264dec on Pi = hardware).
    # videoconvert handles format negotiation; skip videoscale — waylandsink fullscreen
    # mode fills the display without CPU-expensive software resize.
    gst-launch-1.0 -e playbin \
      uri="$url" \
      video-sink="videoconvert ! $VIDEO_SINK" \
      audio-sink="$AUDIO_SINK" \
      2>/dev/null &
    CHILD_PID=$!
    return
  fi

  if [[ "$url" =~ \.mjpg($|\?) || "$url" =~ \.mjpeg($|\?) || "$url" =~ action=stream || "$url" =~ mjpg ]]; then
    echo "[player] using MJPEG pipeline" >&2
    gst-launch-1.0 -e \
      souphttpsrc is-live=true do-timestamp=true location="$url" ! \
      multipartdemux ! jpegdec ! \
      videoconvert ! videoscale ! video/x-raw,width=$VIDEO_WIDTH,height=$VIDEO_HEIGHT,pixel-aspect-ratio=1/1 ! \
      $VIDEO_SINK \
      2>/dev/null &
    CHILD_PID=$!
    return
  fi

  echo "[player] using playbin" >&2
  gst-launch-1.0 -e playbin \
    uri="$url" \
    video-sink="videoconvert ! $VIDEO_SINK" \
    audio-sink="$AUDIO_SINK" \
    2>/dev/null &
  CHILD_PID=$!
}

show_placeholder() {
  local message="$1"
  echo "[player] placeholder: $message" >&2

  if [[ -f "$LOGO_PATH" ]]; then
    timeout "$PLACEHOLDER_DURATION" \
      gst-launch-1.0 -e \
      filesrc location="$LOGO_PATH" ! pngdec ! imagefreeze ! video/x-raw,framerate=30/1 ! \
      videoconvert ! \
      textoverlay text="$message" font-desc="$OVERLAY_FONT" halignment=center valignment=top shaded-background=true \
      ! videoscale ! video/x-raw,width=$VIDEO_WIDTH,height=$VIDEO_HEIGHT,pixel-aspect-ratio=1/1 \
      ! videoconvert ! $VIDEO_SINK \
      2>/dev/null && return 0
    echo "[player] logo pipeline failed; falling back to test pattern" >&2
  fi

  timeout "$PLACEHOLDER_DURATION" \
    gst-launch-1.0 -e \
    videotestsrc pattern=black ! video/x-raw,framerate=30/1 ! \
    textoverlay text="$message" font-desc="$OVERLAY_FONT" halignment=center valignment=center shaded-background=true \
    ! videoscale ! video/x-raw,width=$VIDEO_WIDTH,height=$VIDEO_HEIGHT,pixel-aspect-ratio=1/1 \
    ! videoconvert ! $VIDEO_SINK \
    2>/tmp/gst-timed-err.log || true
}

UNAVAILABLE_PLACEHOLDER_PID=""

start_unavailable_placeholder() {
  if [[ -n "${UNAVAILABLE_PLACEHOLDER_PID:-}" ]] && kill -0 "$UNAVAILABLE_PLACEHOLDER_PID" >/dev/null 2>&1; then
    return
  fi

  local ip line1 line2
  ip="$(wait_for_ip)"
  # Restore previous working unavailable overlay (single-line uppercase)
  overlay="$(printf 'STREAM UNAVAILABLE %s' "${ip}")"

  stop_unavailable_placeholder
  echo "[player] unavailable placeholder: ${overlay}" >&2

  gst-launch-1.0 -e \
    videotestsrc pattern=smpte ! video/x-raw,framerate=30/1 ! \
    textoverlay text="$overlay" font-desc="${OVERLAY_FONT}" \
      halignment=center valignment=center deltay=-30 shaded-background=true ! \
    videoscale ! video/x-raw,width=$VIDEO_WIDTH,height=$VIDEO_HEIGHT,pixel-aspect-ratio=1/1 ! \
    videoconvert ! $VIDEO_SINK \
    2>/dev/null &
  UNAVAILABLE_PLACEHOLDER_PID=$!
}

stop_unavailable_placeholder() {
  if [[ -n "$UNAVAILABLE_PLACEHOLDER_PID" ]]; then
    kill "$UNAVAILABLE_PLACEHOLDER_PID" >/dev/null 2>&1 || true
    wait "$UNAVAILABLE_PLACEHOLDER_PID" 2>/dev/null || true
    UNAVAILABLE_PLACEHOLDER_PID=""
  fi
}

# ── Listening placeholder: test pattern + "LISTENING FOR STREAM" text ─────────
LISTENING_PLACEHOLDER_PID=""

start_listening_placeholder() {
  local url="$1"
  local ip line1 line2
  ip="$(wait_for_ip)"
  # Restore previous working overlay format (uppercase, include URL)
  overlay="$(printf 'LISTENING FOR STREAM AT %s (%s)' "$url" "${ip}")"

  stop_listening_placeholder

  echo "[player] listening placeholder: ${overlay}" >&2

  gst-launch-1.0 -e \
    videotestsrc pattern=smpte is-live=true ! video/x-raw,framerate=30/1 ! \
    textoverlay text="$overlay" font-desc="${OVERLAY_FONT}" \
      halignment=center valignment=center deltay=-30 shaded-background=true ! \
    videoscale ! video/x-raw,width=$VIDEO_WIDTH,height=$VIDEO_HEIGHT,pixel-aspect-ratio=1/1 ! \
    videoconvert ! $VIDEO_SINK \
    2>/dev/null &
  LISTENING_PLACEHOLDER_PID=$!
  sleep 1
  if ! kill -0 "$LISTENING_PLACEHOLDER_PID" >/dev/null 2>&1; then
    echo "[player] listening placeholder pipeline failed; trying without videotestsrc" >&2
    gst-launch-1.0 -e \
      videotestsrc pattern=black ! video/x-raw,framerate=30/1 ! \
      textoverlay text="$(printf 'LISTENING FOR STREAM AT %s (%s)' "$url" "${ip}")" font-desc="${OVERLAY_FONT}" \
        halignment=center valignment=center deltay=-30 shaded-background=true ! \
      videoscale ! video/x-raw,width=$VIDEO_WIDTH,height=$VIDEO_HEIGHT,pixel-aspect-ratio=1/1 ! \
      videoconvert ! $VIDEO_SINK \
      2>/dev/null &
    LISTENING_PLACEHOLDER_PID=$!
  fi
}

stop_listening_placeholder() {
  if [[ -n "${LISTENING_PLACEHOLDER_PID:-}" ]]; then
    kill "$LISTENING_PLACEHOLDER_PID" >/dev/null 2>&1 || true
    wait "$LISTENING_PLACEHOLDER_PID" 2>/dev/null || true
    LISTENING_PLACEHOLDER_PID=""
  fi
}

is_push_receive_url() {
  [[ "$1" =~ ^rtp:// ]] || [[ "$1" =~ ^srt:// ]]
}

while true; do
  export CONFIG_FILE
  echo "[player] env DISPLAY=${DISPLAY:-<unset>} XAUTHORITY=${XAUTHORITY:-<unset>} VIDEO_SINK=$VIDEO_SINK" >&2
  CONFIG_SIG="$(config_sig)"
  STREAM_URL="$(read_stream_url || true)"

  echo "[player] using config: $CONFIG_FILE (sig: $CONFIG_SIG) url: ${STREAM_URL:-<empty>}" >&2

  if [[ -z "$STREAM_URL" ]]; then
    IDLE_IP="$(wait_for_ip)"
    PLACEHOLDER_PID="$(start_idle_placeholder "Select a stream @ ${IDLE_IP}")"

    # Wait here until a stream appears or the config file changes; keep the
    # placeholder alive rather than re-launching every few seconds.
    while true; do
      wait_for_config_event
      NEW_SIG="$(config_sig)"
      NEW_URL="$(read_stream_url || true)"

      if [[ "$NEW_SIG" != "$CONFIG_SIG" ]] || [[ -n "$NEW_URL" && "$NEW_URL" != "$STREAM_URL" ]]; then
        echo "[player] detected change (sig $CONFIG_SIG -> $NEW_SIG, url '${STREAM_URL:-<empty>}' -> '${NEW_URL:-<empty>}')" >&2
        if [[ -n "$PLACEHOLDER_PID" ]]; then
          kill "$PLACEHOLDER_PID" >/dev/null 2>&1 || true
          wait "$PLACEHOLDER_PID" 2>/dev/null || true
        fi
        STREAM_URL="$NEW_URL"
        CONFIG_SIG="$NEW_SIG"
        break
      fi

      if [[ -n "$PLACEHOLDER_PID" ]] && ! kill -0 "$PLACEHOLDER_PID" >/dev/null 2>&1; then
        IDLE_IP="$(wait_for_ip)"
        PLACEHOLDER_PID="$(start_idle_placeholder "Select a stream @ ${IDLE_IP}")"
      fi
    done
    continue
  fi

  stop_unavailable_placeholder
  stop_listening_placeholder
  echo "[player] starting stream: $STREAM_URL" >&2

  while true; do
    start_stream "$STREAM_URL"
    CONFIG_CHANGED=0

    while kill -0 "$CHILD_PID" >/dev/null 2>&1; do
      wait_for_config_event
      NEW_SIG="$(config_sig)"
      NEW_URL="$(read_stream_url || true)"

      if [[ "$NEW_SIG" != "$CONFIG_SIG" ]] || [[ "$NEW_URL" != "$STREAM_URL" ]]; then
        echo "[player] config changed; restarting stream" >&2
        echo "[player] change detail: sig $CONFIG_SIG -> $NEW_SIG, url '$STREAM_URL' -> '${NEW_URL:-<empty>}'" >&2
        kill "$CHILD_PID" >/dev/null 2>&1 || true
        wait "$CHILD_PID" 2>/dev/null || true
        CONFIG_CHANGED=1
        break
      fi
    done

    wait "$CHILD_PID" 2>/dev/null || true

    if [[ "$CONFIG_CHANGED" -eq 1 ]]; then
      stop_unavailable_placeholder
      stop_listening_placeholder
      break
    fi

    # Stream died unexpectedly — for push-receive show LISTENING, otherwise
    # show the generic "stream unavailable" placeholder.
    if is_push_receive_url "$STREAM_URL"; then
      start_listening_placeholder "$STREAM_URL"
    else
      start_unavailable_placeholder
    fi
    sleep "$RETRY_DELAY"
  done

done
