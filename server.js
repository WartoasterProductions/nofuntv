/**
 * NoFun TV — Unified Pi-side daemon
 *
 * Combines:
 *   • Express HTTP server (port 80) — web config UI + REST API
 *   • WebSocket server (same port)  — control channel for Electron frontend
 *   • mDNS advertisement            — _nofuntv._tcp so the frontend finds us
 *   • Agent stream management        — spawn/kill GStreamer receiver pipelines
 *
 * Environment:
 *   PORT           — HTTP listen port (default 80)
 *   HOST           — Bind address (default 0.0.0.0)
 *   DEVICE_NAME    — mDNS / display name (default: hostname)
 *   DECODER        — Force decoder element (auto-detected if empty)
 *   SINK           — Force video sink (auto-detected if empty)
 *   RESTART_ON_SAVE — Restart player on config save (default true)
 */

'use strict';

const fs           = require('fs');
const os           = require('os');
const http         = require('http');
const path         = require('path');
const { exec, spawn, execSync } = require('child_process');
const express      = require('express');
const morgan       = require('morgan');
const WebSocket    = require('ws');

// ── Paths / constants ────────────────────────────────────────────────────────
const PORT            = Number(process.env.PORT || 80);
const HOST            = process.env.HOST || '0.0.0.0';
const DEVICE_NAME     = process.env.DEVICE_NAME || os.hostname();
const CONFIG_PATH     = path.join(__dirname, 'stream-config.json');
const PUBLIC_DIR      = path.join(__dirname, 'public');
const ASSETS_DIR      = path.join(__dirname, 'assets');
const GST_BIN         = process.env.GST_BIN || 'gst-launch-1.0';
const SCAN_TIMEOUT_MS = Number(process.env.SCAN_TIMEOUT_MS || 12000);
const RESTART_ON_SAVE = process.env.RESTART_ON_SAVE !== 'false';
const RESTART_CMD     = process.env.PLAYER_RESTART_CMD
                      || path.join(__dirname, 'scripts', 'restart-player.sh');

const DEFAULT_CAPS = 'application/x-rtp,media=video,encoding-name=H264,payload=96';

// ── Hardware detection ───────────────────────────────────────────────────────
function detect(names) {
  for (const n of names) {
    try { execSync('gst-inspect-1.0 ' + n.split(' ')[0], { stdio: 'ignore' }); return n; }
    catch (_) { /* next */ }
  }
  return names[names.length - 1];
}

const DEFAULT_DECODER = process.env.DECODER || detect([
  'v4l2h264dec', 'mppvideodec', 'nvh264dec', 'avdec_h264',
]);
const DEFAULT_SINK = process.env.SINK || detect([
  'kmssink', 'waylandsink', 'xvimagesink sync=false', 'autovideosink',
]);

console.log(`[server] device="${DEVICE_NAME}" decoder=${DEFAULT_DECODER} sink=${DEFAULT_SINK}`);

// ── Config file helpers ──────────────────────────────────────────────────────
function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (_) {
    return {};
  }
}

function saveConfig(updates) {
  const prev = loadConfig();
  const next = Object.assign(prev, updates, { updatedAt: new Date().toISOString() });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2));
  return next;
}

// ── Express app ──────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(morgan('dev'));
app.use(express.static(PUBLIC_DIR));
app.use('/assets', express.static(ASSETS_DIR));

// --- REST: config ---
app.get('/api/config', (_req, res) => {
  const config = loadConfig();
  res.json(Object.assign({}, config, {
    currentHost: os.hostname(),
    decoder:     DEFAULT_DECODER,
    sink:        DEFAULT_SINK,
    deviceName:  DEVICE_NAME,
  }));
});

app.post('/api/config', (req, res) => {
  const body = req.body || {};
  if (typeof body !== 'object') return res.status(400).json({ error: 'Invalid body' });

  const updates = {};

  // Stream URL (for pull mode)
  if (body.streamUrl !== undefined) {
    if (typeof body.streamUrl !== 'string')
      return res.status(400).json({ error: 'streamUrl must be a string' });
    updates.streamUrl = body.streamUrl.trim();
  }

  // Mode: pull | push
  if (body.mode !== undefined) {
    if (!['pull', 'push'].includes(body.mode))
      return res.status(400).json({ error: 'mode must be "pull" or "push"' });
    updates.mode = body.mode;
  }

  // Protocol for push mode: udp | srt
  if (body.protocol !== undefined) {
    if (!['udp', 'srt'].includes(body.protocol))
      return res.status(400).json({ error: 'protocol must be "udp" or "srt"' });
    updates.protocol = body.protocol;
  }

  // Receive port for push mode
  if (body.receivePort !== undefined) {
    const p = Number(body.receivePort);
    if (!p || p < 1024 || p > 65535)
      return res.status(400).json({ error: 'receivePort must be 1024-65535' });
    updates.receivePort = p;
  }

  // Hostname
  if (body.hostName !== undefined) {
    if (typeof body.hostName !== 'string')
      return res.status(400).json({ error: 'hostName must be a string' });
    const candidate = body.hostName.trim();
    if (candidate && !/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(candidate))
      return res.status(400).json({ error: 'Invalid hostname format' });
    updates.hostName = candidate;
  }

  // mDNS name
  if (body.mdnsName !== undefined) {
    if (typeof body.mdnsName !== 'string')
      return res.status(400).json({ error: 'mdnsName must be a string' });
    const candidate = body.mdnsName.trim();
    if (candidate && !/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(candidate))
      return res.status(400).json({ error: 'Invalid mDNS name format' });
    updates.mdnsName = candidate;
  }

  const saved = saveConfig(updates);
  res.json(Object.assign({}, saved, { currentHost: os.hostname() }));

  // Trigger run-player.sh reload
  if (RESTART_ON_SAVE) {
    exec(`"${RESTART_CMD}"`, { cwd: __dirname }, (err) => {
      if (err) console.error('[api] restart command failed:', err.message);
    });
  }
});

// --- REST: health / status ---
app.get('/api/health', (_req, res) => {
  res.json({
    ok:           true,
    device:       DEVICE_NAME,
    decoder:      DEFAULT_DECODER,
    sink:         DEFAULT_SINK,
    platform:     process.platform,
    activeStreams: [...streamProcs.keys()],
    uptime:       process.uptime(),
  });
});

// --- REST: network scan ---

function parseAvahiBrowse(output) {
  const services = [];
  let current = null;
  const extract = (line, key) => {
    const match = line.match(new RegExp(`^${key} = \\[(.*)\\]$`));
    return match ? match[1] : '';
  };
  output.split('\n').forEach((raw) => {
    const line = raw.trim();
    if (!line) return;
    if (line.startsWith('=')) {
      if (current) services.push(current);
      current = {};
      return;
    }
    if (!current) return;
    const name     = extract(line, 'name');
    const type     = extract(line, 'type');
    const hostname = extract(line, 'hostname');
    const address  = extract(line, 'address');
    const portStr  = extract(line, 'port');
    if (name)     current.name = name;
    if (type)     current.type = type;
    if (hostname) current.hostname = hostname;
    if (address)  current.address = address;
    if (portStr && !Number.isNaN(Number(portStr))) current.port = Number(portStr);
  });
  if (current) services.push(current);
  return services.filter((s) => s.name || s.address || s.hostname);
}

// Scan for both RTSP services and NoFunTV controllers
app.get('/api/scan-streams', (req, res) => {
  const scanType = req.query.type || 'all';
  const jobs = [];

  if (scanType === 'all' || scanType === 'rtsp') {
    jobs.push(new Promise((resolve) => {
      exec('avahi-browse -rt _rtsp._tcp', { timeout: SCAN_TIMEOUT_MS }, (err, stdout) => {
        if (err) return resolve([]);
        resolve(parseAvahiBrowse(stdout).map((s) => Object.assign(s, { serviceType: 'rtsp' })));
      });
    }));
  }

  if (scanType === 'all' || scanType === 'nofuntv') {
    jobs.push(new Promise((resolve) => {
      exec('avahi-browse -rt _nofuntv._tcp', { timeout: SCAN_TIMEOUT_MS }, (err, stdout) => {
        if (err) return resolve([]);
        resolve(parseAvahiBrowse(stdout).map((s) => Object.assign(s, { serviceType: 'nofuntv' })));
      });
    }));
  }

  Promise.all(jobs)
    .then((results) => {
      const services = results.flat();
      res.json({ services });
    })
    .catch((e) => res.status(500).json({ error: 'Scan failed', detail: e.message }));
});

app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

// ── HTTP + WebSocket server ──────────────────────────────────────────────────
const httpServer = http.createServer(app);
const wss = new WebSocket.Server({ server: httpServer });

// ── Agent: per-stream process management ─────────────────────────────────────
const streamProcs = new Map(); // streamId → ChildProcess

function buildReceiverPipeline(opts) {
  const port     = opts.port     || 5000;
  const jitter   = opts.jitter   || 50;
  const decoder  = opts.decoder  || DEFAULT_DECODER;
  const sink     = opts.sink     || DEFAULT_SINK;
  const proto    = opts.proto    || 'udp';
  const srtUri   = opts.srtUri   || null;
  const srcUrl   = opts.srcUrl   || null;
  const dropLate = opts.dropLate !== false;
  const sync     = opts.sync     || false;
  const syncFlag = sync ? '' : ' sync=false';

  // RTSP pull mode
  if (proto === 'rtsp' && srcUrl) {
    return 'rtspsrc location="' + srcUrl + '" latency=' + jitter
         + ' protocols=udp+tcp ! rtph264depay ! h264parse ! '
         + decoder + ' ! videoconvert ! ' + sink + syncFlag;
  }

  // SRT mode
  if (proto === 'srt' && srtUri) {
    return 'srtsrc uri="' + srtUri + '" latency=120 caps="' + DEFAULT_CAPS + '"'
         + ' ! rtpjitterbuffer latency=' + jitter + ' drop-on-latency=' + dropLate
         + ' ! rtph264depay ! h264parse ! ' + decoder
         + ' ! videoconvert ! ' + sink + syncFlag;
  }

  // Default: UDP/RTP push receive
  return 'udpsrc port=' + port + ' caps="' + DEFAULT_CAPS + '"'
       + ' ! rtpjitterbuffer latency=' + jitter + ' drop-on-latency=' + dropLate
       + ' ! rtph264depay ! h264parse ! ' + decoder
       + ' ! videoconvert ! ' + sink + syncFlag;
}

function startReceiver(streamId, opts, sendFn) {
  stopReceiver(streamId, sendFn);

  const pipeline = opts.pipeline || buildReceiverPipeline(opts);
  const args     = ['-e'].concat(pipeline.split(/\s+/).filter(Boolean));

  console.log('[agent] stream ' + streamId + ' starting: ' + GST_BIN + ' ' + args.join(' '));
  sendFn({ type: 'ack', streamId: streamId, status: 'starting', pipeline: pipeline });

  const proc = spawn(GST_BIN, args, { shell: false });
  streamProcs.set(streamId, proc);

  proc.stdout.on('data', function (d) {
    sendFn({ type: 'output', streamId: streamId, level: 'out', data: d.toString() });
  });
  proc.stderr.on('data', function (d) {
    sendFn({ type: 'output', streamId: streamId, level: 'err', data: d.toString() });
  });
  proc.on('error', function (e) {
    sendFn({ type: 'output', streamId: streamId, level: 'sys', data: '[error] ' + e.message + '\n' });
    streamProcs.delete(streamId);
    sendFn({ type: 'ack', streamId: streamId, status: 'error', message: e.message });
  });
  proc.on('close', function (code) {
    sendFn({ type: 'output', streamId: streamId, level: 'sys', data: '[exit code ' + code + ']\n' });
    streamProcs.delete(streamId);
    sendFn({ type: 'ack', streamId: streamId, status: 'stopped', code: code });
  });
}

function stopReceiver(streamId, sendFn) {
  const proc = streamProcs.get(streamId);
  if (!proc) return;
  try { process.kill(proc.pid, 'SIGTERM'); } catch (_) {}
  streamProcs.delete(streamId);
  if (sendFn) sendFn({ type: 'ack', streamId: streamId, status: 'stopped' });
}

function stopAll(sendFn) {
  for (const [id] of streamProcs) stopReceiver(id, sendFn);
}

// ── WebSocket message handling ───────────────────────────────────────────────
wss.on('connection', function (ws, req) {
  const remote = req.socket.remoteAddress;
  console.log('[ws] control connected from ' + remote);

  var send = function (obj) {
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
    activeStreams: Array.from(streamProcs.keys()),
  });

  ws.on('message', function (raw) {
    var msg;
    try { msg = JSON.parse(raw.toString()); }
    catch (_) { send({ type: 'error', message: 'invalid JSON' }); return; }

    switch (msg.type) {
      case 'ping':
        send({ type: 'pong', ts: Date.now() });
        break;

      case 'start':
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
          activeStreams: Array.from(streamProcs.keys()),
        });
        break;

      case 'set-config':
        // Allow the frontend to update stream-config.json remotely
        try {
          const saved = saveConfig(msg.config || {});
          send({ type: 'config-updated', config: saved });
          if (RESTART_ON_SAVE) {
            exec('"' + RESTART_CMD + '"', { cwd: __dirname }, function () {});
          }
        } catch (e) {
          send({ type: 'error', message: 'config save failed: ' + e.message });
        }
        break;

      default:
        send({ type: 'error', message: 'unknown message type: ' + msg.type });
    }
  });

  ws.on('close', function () {
    console.log('[ws] control disconnected from ' + remote);
  });
  ws.on('error', function (e) {
    console.error('[ws] error:', e.message);
  });
});

// ── mDNS advertisement ───────────────────────────────────────────────────────
let bonjourInstance = null;

function advertiseMdns() {
  try {
    const { Bonjour } = require('bonjour-service');
    bonjourInstance = new Bonjour();
    bonjourInstance.publish({
      name: DEVICE_NAME,
      type: 'nofuntv',
      port: PORT,
      txt: {
        decoder: DEFAULT_DECODER,
        sink:    DEFAULT_SINK,
        version: '2',
        ws:      'true',
      },
    });
    console.log('[mdns] advertising _nofuntv._tcp "' + DEVICE_NAME + '" on port ' + PORT);
  } catch (e) {
    console.warn('[mdns] bonjour-service unavailable, trying avahi-publish…');
    try {
      spawn('avahi-publish', [
        '-s', DEVICE_NAME, '_nofuntv._tcp', String(PORT),
        'decoder=' + DEFAULT_DECODER, 'sink=' + DEFAULT_SINK, 'version=2', 'ws=true',
      ], { stdio: 'inherit' });
    } catch (_) {
      console.warn('[mdns] No mDNS publisher available — manual connection only');
    }
  }
}

// ── Start ────────────────────────────────────────────────────────────────────
httpServer.listen(PORT, HOST, function () {
  console.log('NoFunTV server running on http://' + HOST + ':' + PORT);
  console.log('WebSocket control on ws://' + HOST + ':' + PORT);
  advertiseMdns();
});

// ── Graceful shutdown ────────────────────────────────────────────────────────
function shutdown() {
  console.log('[server] shutting down — stopping all streams');
  stopAll(null);
  if (bonjourInstance) { try { bonjourInstance.destroy(); } catch (_) {} }
  httpServer.close();
}

process.on('SIGTERM', function () { shutdown(); process.exit(0); });
process.on('SIGINT',  function () { shutdown(); process.exit(0); });
