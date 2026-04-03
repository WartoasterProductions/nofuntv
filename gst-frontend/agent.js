#!/usr/bin/env node
/**
 * NoFun TV — Device Agent
 * Run this on every Pi / Orange Pi you want to control.
 *
 * Install deps once:  npm install
 * Start:             node agent.js
 * Start w/ options:  GST_BIN=gst-launch-1.0 AGENT_PORT=7700 node agent.js
 *
 * The agent:
 *   • Publishes _nofuntv._tcp mDNS record so the control app can find it
 *   • Accepts JSON messages over WebSocket
 *   • Manages one GStreamer receiver pipeline per stream slot
 *   • Streams stdout / stderr back to the control app in real-time
 */

'use strict';

const { spawn, execSync } = require('child_process');
const http   = require('http');
const os     = require('os');
const WebSocket = require('ws');

// ── Config ────────────────────────────────────────────────────────────────────
const AGENT_PORT  = Number(process.env.AGENT_PORT  || 7700);
const GST_BIN     = process.env.GST_BIN || 'gst-launch-1.0';
const DEVICE_NAME = process.env.DEVICE_NAME || os.hostname();

// Default caps for RTP H.264 over UDP
const DEFAULT_CAPS =
  'application/x-rtp,media=video,encoding-name=H264,payload=96';

// Auto-detect best decoder + sink for this hardware
function detectDecoder() {
  const tryEl = (name) => {
    try { execSync(`gst-inspect-1.0 ${name}`, { stdio: 'ignore' }); return true; }
    catch (_) { return false; }
  };
  if (tryEl('v4l2h264dec'))  return 'v4l2h264dec';   // Raspberry Pi
  if (tryEl('mppvideodec'))  return 'mppvideodec';   // Rockchip / Orange Pi
  if (tryEl('nvh264dec'))    return 'nvh264dec';      // NVIDIA
  return 'avdec_h264';                                // software fallback
}

function detectSink() {
  const tryEl = (name) => {
    try { execSync(`gst-inspect-1.0 ${name}`, { stdio: 'ignore' }); return true; }
    catch (_) { return false; }
  };
  if (tryEl('kmssink'))     return 'kmssink';
  if (tryEl('waylandsink')) return 'waylandsink';
  if (tryEl('xvimagesink')) return 'xvimagesink sync=false';
  return 'autovideosink';
}

const DEFAULT_DECODER = process.env.DECODER || detectDecoder();
const DEFAULT_SINK    = process.env.SINK    || detectSink();

console.log(`[agent] device="${DEVICE_NAME}" decoder=${DEFAULT_DECODER} sink=${DEFAULT_SINK}`);

// ── mDNS advertisement ────────────────────────────────────────────────────────
let bonjourInstance = null;
function advertiseMdns() {
  try {
    const { Bonjour } = require('bonjour-service');
    bonjourInstance = new Bonjour();
    bonjourInstance.publish({
      name: DEVICE_NAME,
      type: 'nofuntv',
      port: AGENT_PORT,
      txt: {
        decoder: DEFAULT_DECODER,
        sink:    DEFAULT_SINK,
        version: '2',
      },
    });
    console.log(`[agent] mDNS: advertising _nofuntv._tcp "${DEVICE_NAME}" on port ${AGENT_PORT}`);
  } catch (e) {
    // bonjour-service not installed — fall back to avahi-publish if available
    console.warn('[agent] bonjour-service not found; trying avahi-publish…');
    try {
      const args = ['-s', DEVICE_NAME, '_nofuntv._tcp', String(AGENT_PORT),
                    `decoder=${DEFAULT_DECODER}`, `sink=${DEFAULT_SINK}`, 'version=2'];
      const pub = spawn('avahi-publish', args, { stdio: 'inherit' });
      pub.on('error', () => console.warn('[agent] avahi-publish also unavailable — mDNS disabled'));
    } catch (_) {
      console.warn('[agent] mDNS advertisement disabled — install bonjour-service or avahi-publish');
    }
  }
}

// ── Per-stream process management ─────────────────────────────────────────────
// Map<streamId, ChildProcess>
const streamProcs = new Map();

function buildReceiverPipeline(opts) {
  const {
    port     = 5000,
    jitter   = 50,
    decoder  = DEFAULT_DECODER,
    sink     = DEFAULT_SINK,
    proto    = 'udp',
    srtUri   = null,
    srcUrl   = null,
    dropLate = true,
    sync     = false,
  } = opts;

  const syncFlag = sync ? '' : ' sync=false';

  // RTSP pull mode — device fetches from an RTSP source
  if (proto === 'rtsp' && srcUrl) {
    return `rtspsrc location="${srcUrl}" latency=${jitter} protocols=udp+tcp`
         + ` ! rtph264depay ! h264parse ! ${decoder}`
         + ` ! videoconvert ! ${sink}${syncFlag}`;
  }

  let src;
  if (proto === 'srt' && srtUri) {
    src = `srtsrc uri="${srtUri}" latency=120 `
        + `caps="${DEFAULT_CAPS}"`;
  } else {
    src = `udpsrc port=${port} caps="${DEFAULT_CAPS}"`;
  }

  const jbuf    = `rtpjitterbuffer latency=${jitter} drop-on-latency=${dropLate}`;
  const depay   = 'rtph264depay';
  const parse   = 'h264parse';
  const convert = 'videoconvert';
  const sinkEl  = sink + syncFlag;

  return [src, jbuf, depay, parse, decoder, convert, sinkEl].join(' ! ');
}

function startReceiver(streamId, opts, sendFn) {
  stopReceiver(streamId, sendFn);

  const pipeline = opts.pipeline || buildReceiverPipeline(opts);
  const args     = ['-e', ...pipeline.split(/\s+/).filter(Boolean)];

  console.log(`[agent] stream ${streamId} starting: ${GST_BIN} ${args.join(' ')}`);
  sendFn({ type: 'ack', streamId, status: 'starting', pipeline });

  const proc = spawn(GST_BIN, args, { shell: false });
  streamProcs.set(streamId, proc);

  const fwd = (lvl, data) => {
    sendFn({ type: 'output', streamId, level: lvl, data: data.toString() });
  };

  proc.stdout.on('data', (d) => fwd('out', d));
  proc.stderr.on('data', (d) => fwd('err', d));
  proc.on('error', (e) => {
    fwd('sys', `[error] ${e.message}\n`);
    streamProcs.delete(streamId);
    sendFn({ type: 'ack', streamId, status: 'error', message: e.message });
  });
  proc.on('close', (code) => {
    fwd('sys', `[exit code ${code}]\n`);
    streamProcs.delete(streamId);
    sendFn({ type: 'ack', streamId, status: 'stopped', code });
  });
}

function stopReceiver(streamId, sendFn) {
  const proc = streamProcs.get(streamId);
  if (!proc) return;
  try { process.kill(proc.pid, 'SIGTERM'); } catch (_) {}
  streamProcs.delete(streamId);
  if (sendFn) sendFn({ type: 'ack', streamId, status: 'stopped' });
}

function stopAll(sendFn) {
  for (const [id] of streamProcs) stopReceiver(id, sendFn);
}

// ── WebSocket server ──────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  // Tiny HTTP health endpoint
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok:           true,
      device:       DEVICE_NAME,
      decoder:      DEFAULT_DECODER,
      sink:         DEFAULT_SINK,
      activeStreams: [...streamProcs.keys()],
    }));
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocket.Server({ server });

wss.on('connection', (ws, req) => {
  const remote = req.socket.remoteAddress;
  console.log(`[agent] control connected from ${remote}`);

  // Helper — send JSON safely
  const send = (obj) => {
    if (ws.readyState === WebSocket.OPEN)
      ws.send(JSON.stringify(obj));
  };

  // Greet with device info
  send({
    type:         'hello',
    device:       DEVICE_NAME,
    decoder:      DEFAULT_DECODER,
    sink:         DEFAULT_SINK,
    platform:     process.platform,
    activeStreams: [...streamProcs.keys()],
  });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); }
    catch (_) { send({ type: 'error', message: 'invalid JSON' }); return; }

    switch (msg.type) {
      case 'ping':
        send({ type: 'pong', ts: Date.now() });
        break;

      case 'start':
        // msg: { streamId, port, jitter, decoder, sink, proto, srtUri, dropLate, sync, pipeline }
        startReceiver(msg.streamId, msg, send);
        break;

      case 'stop':
        stopReceiver(msg.streamId, send);
        break;

      case 'stop-all':
        stopAll(send);
        break;

      case 'status':
        send({
          type:         'status',
          device:       DEVICE_NAME,
          decoder:      DEFAULT_DECODER,
          sink:         DEFAULT_SINK,
          activeStreams: [...streamProcs.keys()],
        });
        break;

      default:
        send({ type: 'error', message: `unknown message type: ${msg.type}` });
    }
  });

  ws.on('close', () => {
    console.log(`[agent] control disconnected from ${remote}`);
  });

  ws.on('error', (e) => {
    console.error(`[agent] ws error: ${e.message}`);
  });
});

server.listen(AGENT_PORT, '0.0.0.0', () => {
  console.log(`[agent] listening on ws://0.0.0.0:${AGENT_PORT}`);
  advertiseMdns();
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────
process.on('SIGTERM', () => {
  console.log('[agent] SIGTERM — stopping all streams');
  stopAll(null);
  if (bonjourInstance) bonjourInstance.destroy();
  server.close();
  process.exit(0);
});

process.on('SIGINT', () => {
  stopAll(null);
  if (bonjourInstance) bonjourInstance.destroy();
  server.close();
  process.exit(0);
});
