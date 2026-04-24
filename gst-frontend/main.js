'use strict';

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const { spawn, exec } = require('child_process');
const WebSocket       = require('ws');
const path            = require('path');
const os              = require('os');

function getLocalIp() {
  const nets = os.networkInterfaces();
  for (const iface of Object.values(nets)) {
    for (const addr of (iface || [])) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address;
    }
  }
  return '127.0.0.1';
}

// ─── Window ───────────────────────────────────────────────────────────────────

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400, height: 860, minWidth: 1060, minHeight: 640,
    frame: false, titleBarStyle: 'hidden', backgroundColor: '#080808',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
    },
    icon: path.join(__dirname, '..', 'assets', 'NoFunLogo.png'),
  });
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  if (process.argv.includes('--dev'))
    mainWindow.webContents.openDevTools({ mode: 'detach' });
}

// ─── Kill all senders on exit ────────────────────────────────────────────────
function killAllSenders() {
  for (const [, s] of senderStreams) {
    if (s.proc) {
      try {
        if (os.platform() === 'win32')
          exec('taskkill /pid ' + s.proc.pid + ' /f /t', () => {});
        else
          s.proc.kill('SIGTERM');
      } catch (_) {}
      s.proc = null;
    }
  }
  senderStreams.clear();
}

app.on('before-quit', killAllSenders);
process.on('exit',    killAllSenders);

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { shutdown(); app.quit(); });

function send(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed())
    mainWindow.webContents.send(channel, data);
}

// ─── Window controls ──────────────────────────────────────────────────────────

ipcMain.handle('window-minimize', () => mainWindow.minimize());
ipcMain.handle('window-maximize', () =>
  mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize());
ipcMain.handle('window-close',    () => mainWindow.close());
ipcMain.handle('get-platform',    () => os.platform());

// ─── File dialog ──────────────────────────────────────────────────────────────

ipcMain.handle('open-file', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    title: 'Select video file', properties: ['openFile'],
    filters: [
      { name: 'Video', extensions: ['mp4','mkv','avi','mov','ts','webm','flv','m2ts','wmv'] },
      { name: 'All',   extensions: ['*'] },
    ],
  });
  return r.canceled ? null : r.filePaths[0];
});

// ─── Device discovery ─────────────────────────────────────────────────────────

const http = require('http');
const dns  = require('dns');
const fs   = require('fs');

const discoveredDevices = new Map(); // id → device info
let bonjourBrowser  = null;
let bonjourInstance = null;
let subnetScanTimer = null;
let knownDeviceTimer = null;

const KNOWN_DEVICES_FILE = path.join(app.getPath('userData'), 'known-devices.json');
const SUBNET_TIMEOUT_MS  = 1500;   // generous for WiFi Pis
const KNOWN_TIMEOUT_MS   = 2000;   // even more generous for known IPs
const SUBNET_INTERVAL_MS = 15000;  // full subnet scan every 15 s
const KNOWN_INTERVAL_MS  = 5000;   // re-probe known IPs every 5 s

// ── Persistent known-device store ─────────────────────────────────────────────
function loadKnownDevices() {
  try {
    const raw = fs.readFileSync(KNOWN_DEVICES_FILE, 'utf8');
    const list = JSON.parse(raw);   // [ { ip, port, name }, … ]
    // Filter out any entries with non-IPv4 addresses (e.g. hostnames from old bugs)
    return list.filter((d) => isIPv4(d.ip));
  } catch (_) { return []; }
}

function saveKnownDevices() {
  const list = Array.from(discoveredDevices.values()).map((d) => ({
    ip: d.ip, port: d.port, name: d.name,
  }));
  try { fs.writeFileSync(KNOWN_DEVICES_FILE, JSON.stringify(list, null, 2)); } catch (_) {}
}

// Probe a single IP:port for /api/health. Resolves with health JSON or null.
function probeDevice(ip, port, timeoutMs) {
  return new Promise((resolve) => {
    const req = http.get(
      { hostname: ip, port, path: '/api/health', timeout: timeoutMs },
      (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          try {
            const j = JSON.parse(body);
            if (j && j.ok) return resolve(j);
          } catch (_) {}
          resolve(null);
        });
      }
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

// Quick IPv4 check — rejects hostnames, IPv6, garbage.
function isIPv4(str) { return /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(str); }

// Register a device found by any means (subnet scan or mDNS).
function registerDevice(ip, port, info) {
  if (!isIPv4(ip)) {
    console.warn('[discovery] rejected non-IPv4 address: ' + ip);
    return;
  }
  const id = ip + ':' + port;
  if (discoveredDevices.has(id)) {
    // Already known — just make sure we're connected
    if (!deviceClients.has(id)) connectToDevice(id, discoveredDevices.get(id));
    return;
  }
  const dev = {
    id,
    name:    info.device || ip,
    host:    ip,
    ip,
    port,
    decoder: info.decoder || 'avdec_h264',
    sink:    info.sink    || 'autovideosink',
    status:  'discovered',
  };
  discoveredDevices.set(id, dev);
  console.log('[discovery] found "' + dev.name + '" at ' + id);
  saveKnownDevices();
  connectToDevice(id, dev);
}

// Probe a list of known IPs quickly (targeted, not a full subnet sweep).
async function probeKnownDevices() {
  const known = loadKnownDevices();
  // Also include any devices currently registered but disconnected
  for (const dev of discoveredDevices.values()) {
    if (!known.find((k) => k.ip === dev.ip && k.port === dev.port))
      known.push({ ip: dev.ip, port: dev.port });
  }
  if (known.length === 0) return;
  const probes = known.map((k) =>
    probeDevice(k.ip, k.port, KNOWN_TIMEOUT_MS).then((health) => {
      if (health) registerDevice(k.ip, k.port, health);
    })
  );
  await Promise.all(probes);
  send('device-update', serializeDevices());
}

// Scan every host on all local /24 subnets in parallel.
async function scanSubnet() {
  const nets    = os.networkInterfaces();
  const subnets = new Set();
  for (const iface of Object.values(nets)) {
    for (const addr of (iface || [])) {
      if (addr.family === 'IPv4' && !addr.internal) {
        const parts = addr.address.split('.');
        subnets.add(parts[0] + '.' + parts[1] + '.' + parts[2] + '.');
      }
    }
  }
  if (subnets.size === 0) return;

  const probes = [];
  for (const prefix of subnets) {
    for (let i = 1; i <= 254; i++) {
      const ip = prefix + i;
      probes.push(
        probeDevice(ip, 80, SUBNET_TIMEOUT_MS).then((health) => {
          if (health) registerDevice(ip, 80, health);
        })
      );
    }
  }

  await Promise.all(probes);
  send('device-update', serializeDevices());
  console.log('[discovery] subnet scan complete, ' + discoveredDevices.size + ' device(s) known');
}

// Also try mDNS as a bonus — works when Bonjour is available on the host OS.
function startMdnsBrowser() {
  try {
    const { Bonjour } = require('bonjour-service');
    bonjourInstance = new Bonjour();
    bonjourBrowser  = bonjourInstance.find({ type: 'nofuntv' }, (service) => {
      const ip = (service.addresses || []).find((a) => isIPv4(a));
      const info = {
        device:  service.name,
        decoder: service.txt && service.txt.decoder,
        sink:    service.txt && service.txt.sink,
      };
      if (ip) {
        registerDevice(ip, service.port, info);
        send('device-update', serializeDevices());
      } else {
        // No IPv4 in addresses — resolve the hostname
        dns.lookup(service.host, { family: 4 }, (err, address) => {
          if (!err && address && isIPv4(address)) {
            registerDevice(address, service.port, info);
            send('device-update', serializeDevices());
          } else {
            console.warn('[discovery] mDNS service "' + service.name + '" has no resolvable IPv4 (host=' + service.host + ')');
          }
        });
      }
    });
    console.log('[discovery] mDNS browser started (_nofuntv._tcp)');
  } catch (e) {
    console.warn('[discovery] mDNS unavailable:', e.message);
  }
}

function startDiscovery() {
  startMdnsBrowser();

  // Immediately probe any previously-known devices (fast, targeted)
  probeKnownDevices();

  // Full subnet scan shortly after
  setTimeout(scanSubnet, 500);

  // Re-probe known devices every 5 s (cheap — only a few HTTP requests)
  if (!knownDeviceTimer) {
    knownDeviceTimer = setInterval(probeKnownDevices, KNOWN_INTERVAL_MS);
  }
  // Full subnet scan every 15 s to find brand-new devices
  if (!subnetScanTimer) {
    subnetScanTimer = setInterval(scanSubnet, SUBNET_INTERVAL_MS);
  }
}

ipcMain.handle('discovery-start', () => {
  if (!bonjourBrowser && !subnetScanTimer) startDiscovery();
  return { ok: true };
});

ipcMain.handle('discovery-scan', () => {
  // Ping already-connected devices immediately
  for (const [id] of deviceClients) wsSend(id, { type: 'status' });
  // Probe known devices right away (very fast)
  probeKnownDevices();
  // Run a fresh subnet scan right now
  scanSubnet();
  return { ok: true, devices: serializeDevices() };
});

ipcMain.handle('device-list', () => serializeDevices());

ipcMain.handle('device-add-manual', (_, opts) => {
  const { ip, port, name } = opts;
  const id = ip + ':' + (port || 80);
  if (!discoveredDevices.has(id)) {
    const info = {
      id, name: name || ip, host: ip, ip,
      port: port || 80,
      decoder: 'avdec_h264', sink: 'autovideosink', status: 'manual',
    };
    discoveredDevices.set(id, info);
    connectToDevice(id, info);
    send('device-update', serializeDevices());
  }
  return { ok: true, id };
});

ipcMain.handle('device-remove', (_, id) => {
  disconnectDevice(id);
  discoveredDevices.delete(id);
  return { ok: true };
});

ipcMain.handle('device-update-config', (_, opts) => {
  const { id, decoder, sink, name } = opts;
  const dev = discoveredDevices.get(id);
  if (!dev) return { ok: false };
  if (decoder) dev.decoder = decoder;
  if (sink)    dev.sink    = sink;
  if (name)    dev.name    = name;
  discoveredDevices.set(id, dev);
  send('device-update', serializeDevices());
  return { ok: true };
});

function serializeDevices() {
  return Array.from(discoveredDevices.values()).map((dev) => {
    const ws = deviceClients.get(dev.id);
    return Object.assign({}, dev, { connected: ws && ws.readyState === WebSocket.OPEN });
  });
}

// ─── Device WebSocket clients ─────────────────────────────────────────────────

const deviceClients = new Map(); // id → WebSocket

function connectToDevice(id, info) {
  if (deviceClients.has(id)) return;
  const url = 'ws://' + info.ip + ':' + info.port;
  const ws  = new WebSocket(url, { handshakeTimeout: 5000 });
  deviceClients.set(id, ws);

  ws.on('open', () => {
    const dev = discoveredDevices.get(id) || {};
    dev.status = 'connected';
    discoveredDevices.set(id, dev);
    saveKnownDevices();
    send('device-update', serializeDevices());
  });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (_) { return; }

    if (msg.type === 'hello') {
      const dev = discoveredDevices.get(id) || {};
      if (msg.device)  dev.name    = msg.device;
      if (msg.decoder) dev.decoder = msg.decoder;
      if (msg.sink)    dev.sink    = msg.sink;
      dev.status = 'connected';
      discoveredDevices.set(id, dev);

    } else if (msg.type === 'output') {
      send('device-stream-output', Object.assign({ deviceId: id }, msg));

    } else if (msg.type === 'ack') {
      send('device-ack', Object.assign({ deviceId: id }, msg));

    } else if (msg.type === 'pong') {
      const dev = discoveredDevices.get(id) || {};
      dev.latency = Date.now() - (msg.ts || 0);
      discoveredDevices.set(id, dev);
    }

    send('device-update', serializeDevices());
  });

  ws.on('close', () => {
    deviceClients.delete(id);
    const dev = discoveredDevices.get(id);
    if (dev) { dev.status = 'disconnected'; discoveredDevices.set(id, dev); }
    send('device-update', serializeDevices());
    // Retry after 5 s if device is still in the registry
    setTimeout(() => {
      if (discoveredDevices.has(id)) connectToDevice(id, discoveredDevices.get(id));
    }, 5000);
  });

  ws.on('error', (e) => console.error('[ws] ' + id + ':', e.message));
}

function disconnectDevice(id) {
  const ws = deviceClients.get(id);
  if (ws) { try { ws.close(); } catch (_) {} deviceClients.delete(id); }
}

function wsSend(deviceId, msg) {
  const ws = deviceClients.get(deviceId);
  if (ws && ws.readyState === WebSocket.OPEN)
    ws.send(JSON.stringify(msg));
}

ipcMain.handle('device-send', (_, opts) => {
  wsSend(opts.deviceId, opts.msg);
  return { ok: true };
});

// ─── Sender stream management ─────────────────────────────────────────────────

const senderStreams = new Map(); // streamId → { proc, port, config, assignedDevices, pipeline }

// Returns the argument for test-launch: "( src ! enc ! rtph264pay name=pay0 )"
function buildRtspSenderPipeline(config) {
  const srcType   = config.srcType   || 'screen';
  const filePath  = config.filePath  || '';
  const srcUrl    = config.srcUrl    || '';
  const webcam    = config.webcam    || '/dev/video0';
  const screenIdx = config.screenIdx || 0;
  const width     = config.width     || 1280;
  const height    = config.height    || 720;
  const fps       = config.fps       || 30;
  const codec     = config.codec     || 'x264enc';
  const bitrate   = config.bitrate   || 2500;
  const keyframe  = config.keyframe  || 30;
  const preset    = config.preset    || 'ultrafast';
  const tune      = config.tune      || 'zerolatency';
  const platform  = config.platform  || os.platform();
  let src;
  if (srcType === 'file') { src = 'filesrc location="' + filePath.replace(/\\/g, '/').replace(/"/g, '\\"') + '" ! decodebin ! videorate'; }
  else if (srcType === 'url')    { src = 'urisourcebin uri="' + srcUrl + '" ! decodebin ! videorate'; }
  else if (srcType === 'screen') { src = platform === 'win32' ? 'd3d11screencapturesrc monitor-index=' + screenIdx : 'ximagesrc use-damage=false display-name=:0'; }
  else if (srcType === 'webcam') { src = platform === 'win32' ? 'ksvideosrc device-index=' + webcam : 'v4l2src device=' + webcam; }
  else { src = 'videotestsrc pattern=smpte'; }
  const caps  = 'video/x-raw,framerate=' + fps + '/1';
  const scale = 'videoconvert ! video/x-raw,format=I420 ! videoscale ! video/x-raw,width=' + width + ',height=' + height + ',pixel-aspect-ratio=1/1';
  let enc;
  if (codec === 'nvh264enc')      { enc = 'nvh264enc zerolatency=true rc-mode=cbr bitrate=' + bitrate + ' gop-size=' + keyframe; }
  else if (codec === 'vaapih264enc') { enc = 'vaapih264enc rate-control=cbr bitrate=' + bitrate + ' keyframe-period=' + keyframe; }
  else if (codec === 'mfh264enc') { enc = 'mfh264enc rc-mode=cbr bitrate=' + bitrate + ' gop-size=' + keyframe; }
  else { enc = 'x264enc tune=' + tune + ' speed-preset=' + preset + ' bitrate=' + bitrate + ' key-int-max=' + keyframe + ' sliced-threads=true intra-refresh=true vbv-buf-capacity=' + Math.round(bitrate * 0.5) + ' byte-stream=true'; }
  return '( ' + [src, caps, scale, enc, 'video/x-h264,profile=baseline', 'rtph264pay name=pay0 pt=96 config-interval=1 mtu=1200'].join(' ! ') + ' )';
}
function buildSenderPipeline(config, deviceIps, port) {
  const srcType   = config.srcType   || 'screen';
  const filePath  = config.filePath  || '';
  const srcUrl    = config.srcUrl    || '';
  const webcam    = config.webcam    || '/dev/video0';
  const screenIdx = config.screenIdx || 0;
  const width     = config.width     || 1280;
  const height    = config.height    || 720;
  const fps       = config.fps       || 30;
  const codec     = config.codec     || 'x264enc';
  const bitrate   = config.bitrate   || 2500;
  const keyframe  = config.keyframe  || 30;
  const preset    = config.preset    || 'ultrafast';
  const tune      = config.tune      || 'zerolatency';
  const proto     = config.proto     || 'udp';
  const platform  = config.platform  || os.platform();

  let src;
  if (srcType === 'file') {
    src = 'filesrc location="' + filePath.replace(/\\/g, '/').replace(/"/g, '\\"') + '" ! decodebin ! videorate';
  } else if (srcType === 'url') {
    src = 'urisourcebin uri="' + srcUrl + '" ! decodebin ! videorate';
  } else if (srcType === 'rtsp') {
    src = 'rtspsrc location="' + srcUrl + '" latency=200 protocols=udp+tcp ! rtph264depay ! h264parse';
  } else if (srcType === 'screen') {
    src = platform === 'win32'
      ? 'd3d11screencapturesrc monitor-index=' + screenIdx
      : 'ximagesrc use-damage=false display-name=:0';
  } else if (srcType === 'webcam') {
    src = platform === 'win32'
      ? 'ksvideosrc device-index=' + webcam
      : 'v4l2src device=' + webcam;
  } else {
    src = 'videotestsrc pattern=smpte';
  }

  const caps  = 'video/x-raw,framerate=' + fps + '/1';
  const scale = 'videoconvert ! video/x-raw,format=I420'
              + ' ! videoscale ! video/x-raw,width=' + width + ',height=' + height + ',pixel-aspect-ratio=1/1';

  let enc;
  if (codec === 'nvh264enc') {
    enc = 'nvh264enc zerolatency=true rc-mode=cbr bitrate=' + bitrate + ' gop-size=' + keyframe;
  } else if (codec === 'vaapih264enc') {
    enc = 'vaapih264enc rate-control=cbr bitrate=' + bitrate + ' keyframe-period=' + keyframe;
  } else if (codec === 'mfh264enc') {
    enc = 'mfh264enc rc-mode=cbr bitrate=' + bitrate + ' gop-size=' + keyframe;
  } else {
    enc = 'x264enc tune=' + tune + ' speed-preset=' + preset
        + ' bitrate=' + bitrate + ' key-int-max=' + keyframe
        + ' sliced-threads=true intra-refresh=true'
        + ' vbv-buf-capacity=' + Math.round(bitrate * 0.5)
        + ' byte-stream=true';
  }

  const profile = 'video/x-h264,profile=baseline';
  const pay     = 'rtph264pay config-interval=1 pt=96 mtu=1200';

  let sink;
  if (proto === 'srt') {
    sink = 'srtsink uri="srt://0.0.0.0:' + port + '" latency=120 wait-for-connection=false';
  } else {
    const clients = deviceIps.map((ip) => ip + ':' + port).join(',');
    sink = 'multiudpsink clients="' + clients + '"';
  }

  return [src, caps, scale, enc, profile, pay, sink].join(' ! ');
}

ipcMain.handle('stream-start', (_, opts) => {
  const { streamId, config, deviceIds, basePort, gstBin } = opts;

  const existing = senderStreams.get(streamId);
  if (existing && existing.proc) {
    try { existing.proc.kill('SIGTERM'); } catch (_) {}
  }

  const devices = deviceIds.map((id) => discoveredDevices.get(id)).filter(Boolean);
  if (devices.length === 0) return { ok: false, error: 'No valid devices' };

  // ── RTSP pull mode: no local sender — tell devices to pull directly ──
  if (config.srcType === 'rtsp' && config.srcUrl) {
    senderStreams.set(streamId, {
      proc: null, port: 0, config, pipeline: '(rtsp pull)',
      assignedDevices: new Set(deviceIds),
    });
    for (const dev of devices) {
      const overrides = (config.overrides && config.overrides[dev.id]) || {};
      wsSend(dev.id, {
        type:     'start',
        streamId,
        proto:    'rtsp',
        srcUrl:   config.srcUrl,
        jitter:   config.jitter  || 200,
        decoder:  overrides.decoder || dev.decoder,
        sink:     overrides.sink    || dev.sink,
        dropLate: true,
        sync:     false,
      });
    }
    send('stream-output', { streamId, type: 'sys',
      data: '[RTSP pull] devices pulling from ' + config.srcUrl + '\n' });
    return { ok: true, pid: null, port: 0, pipeline: 'rtsp-pull:' + config.srcUrl };
  }

  // ── UDP / SRT mode: local sender → multiudpsink ──
  const port = (basePort || 5000) + (streamId - 1);
  const ips  = devices.map((d) => d.ip).filter(Boolean);
  if (ips.length === 0) return { ok: false, error: 'No valid device IPs' };

  const pipeline = buildSenderPipeline(
    Object.assign({}, config, { platform: os.platform() }),
    ips,
    port
  );

  const binary = gstBin || 'gst-launch-1.0';

  // Spawn sender and wire up event handlers. Calls itself on clean EOS when loop is enabled.
  // File sources use ffmpeg (scale to 720x480 NTSC, x264 ultrafast) instead of gst-launch.
  // NOTE: We do NOT use shell:true so that the child is a direct Electron child process.
  // On Windows this means the OS job object kills ffmpeg/gst-launch when Electron dies.
  function spawnSender() {
    const s = senderStreams.get(streamId);
    if (!s) return;

    let proc;
    if (config.srcType === 'file' && config.filePath) {
      const fp      = config.filePath;
      const dest    = 'rtp://' + ips[0] + ':' + port;
      const w       = config.width    || 1280;
      const h       = config.height   || 720;
      const fps     = config.fps      || 30;
      const br      = config.bitrate  || 4000;
      const kf      = config.keyframe || 30;
      const preset  = config.preset   || 'ultrafast';
      const tune    = config.tune     || 'zerolatency';
      const ffArgs = [
        '-re', '-stream_loop', '-1', '-i', fp,
        '-an',
        '-vf', `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1`,
        '-r', String(fps),
        '-c:v', 'libx264', '-preset', preset, '-tune', tune,
        '-b:v', br + 'k', '-maxrate', br + 'k', '-bufsize', (br * 2) + 'k',
        '-g', String(kf), '-keyint_min', String(kf),
        '-bsf:v', 'h264_mp4toannexb', '-payload_type', '96', '-f', 'rtp', dest,
      ];
      proc = spawn('ffmpeg', ffArgs, { windowsHide: true });
    } else {
      // Split pipeline string into args for direct spawn (no shell)
      const gstArgs = ['-e', ...pipeline.split(/\s+/).filter(Boolean)];
      proc = spawn(binary, gstArgs, { windowsHide: true });
    }
    s.proc = proc;

    proc.stdout.on('data', (d) =>
      send('stream-output', { streamId, type: 'out', data: d.toString() }));
    proc.stderr.on('data', (d) =>
      send('stream-output', { streamId, type: 'err', data: d.toString() }));
    proc.on('error', (e) =>
      send('stream-output', { streamId, type: 'sys', data: '[error] ' + e.message + '\n' }));
    proc.on('close', (code) => {
      const cur = senderStreams.get(streamId);
      if (cur) cur.proc = null;

      // Auto-restart for file/url sources when loop is enabled and exit was clean (EOS)
      const shouldLoop = (config.srcType === 'file' || config.srcType === 'url')
                       && config.loop !== false && code === 0 && cur;
      if (shouldLoop) {
        send('stream-output', { streamId, type: 'sys', data: '[loop] restarting playback…\n' });
        setTimeout(spawnSender, 500);
      } else {
        send('stream-output', { streamId, type: 'sys', data: '[exit ' + code + ']\n' });
        send('stream-stopped', { streamId });
        // Tell Pi(s) to return to idle/color-bars mode
        const cur2 = senderStreams.get(streamId);
        if (cur2) cur2.assignedDevices.forEach((deviceId) => wsSend(deviceId, { type: 'stop', streamId }));
      }
    });
  }

  senderStreams.set(streamId, {
    proc: null, port, config, pipeline,
    assignedDevices: new Set(deviceIds),
  });
  spawnSender();

  // Tell each assigned device to start its RTP/SRT receiver
  for (const dev of devices) {
    const overrides = (config.overrides && config.overrides[dev.id]) || {};
    wsSend(dev.id, {
      type:     'start',
      streamId,
      port,
      jitter:   config.jitter  || 200,
      decoder:  overrides.decoder || dev.decoder,
      sink:     overrides.sink    || dev.sink,
      proto:    config.proto   || 'udp',
      dropLate: true,
      sync:     false,
    });
  }

  const started = senderStreams.get(streamId);
  return { ok: true, pid: started && started.proc ? started.proc.pid : null, port, pipeline };
});

ipcMain.handle('stream-stop', (_, opts) => {
  const { streamId } = opts;
  const s = senderStreams.get(streamId);
  if (s) {
    if (s.proc) {
      try {
        if (os.platform() === 'win32')
          exec('taskkill /pid ' + s.proc.pid + ' /f /t', () => {});
        else
          s.proc.kill('SIGTERM');
      } catch (_) {}
    }
    s.assignedDevices.forEach((deviceId) => wsSend(deviceId, { type: 'stop', streamId }));
    senderStreams.delete(streamId);
  }
  return { ok: true };
});

ipcMain.handle('stream-list', () =>
  Array.from(senderStreams.entries()).map(([id, s]) => ({
    streamId: id, port: s.port,
    running:  s.proc !== null,
    devices:  Array.from(s.assignedDevices),
    pipeline: s.pipeline,
  }))
);

// ─── Terminal ─────────────────────────────────────────────────────────────────

let termProc = null;

ipcMain.handle('run-command', (_, cmdline) => {
  if (termProc) { try { termProc.kill(); } catch (_) {} termProc = null; }
  const proc = spawn(cmdline, [], { shell: true, windowsHide: true });
  termProc = proc;
  proc.stdout.on('data', (d) => send('term-output', { type: 'out', data: d.toString() }));
  proc.stderr.on('data', (d) => send('term-output', { type: 'err', data: d.toString() }));
  proc.on('error', (e)  => send('term-output', { type: 'sys', data: '[error] ' + e.message + '\n' }));
  proc.on('close', (c)  => {
    send('term-output', { type: 'sys', data: '[exit: ' + c + ']\n' });
    termProc = null;
  });
  return { ok: true };
});

ipcMain.handle('kill-term', () => {
  if (termProc) { try { termProc.kill(); } catch (_) {} termProc = null; }
  return { ok: true };
});

ipcMain.handle('file-exists', (_, filePath) => {
  try { require('fs').accessSync(filePath); return true; } catch (_) { return false; }
});

// ─── gst-inspect ─────────────────────────────────────────────────────────────

ipcMain.handle('inspect-element', (_, opts) => {
  const { binary, element } = opts;
  const bin = (binary || 'gst-launch-1.0').replace('gst-launch-1.0', 'gst-inspect-1.0');
  return new Promise((res) =>
    exec('"' + bin + '" ' + element, { timeout: 5000, windowsHide: true },
         (err, out, err2) => res({ ok: !err, output: err ? (err2 || err.message) : out })));
});

// ─── Cleanup ──────────────────────────────────────────────────────────────────

function shutdown() {
  if (subnetScanTimer) clearInterval(subnetScanTimer);
  if (knownDeviceTimer) clearInterval(knownDeviceTimer);
  senderStreams.forEach((s) => { if (s.proc) try { s.proc.kill(); } catch (_) {} });
  if (termProc) try { termProc.kill(); } catch (_) {}
  saveKnownDevices();
  deviceClients.forEach((_, id) => disconnectDevice(id));
  if (bonjourInstance) try { bonjourInstance.destroy(); } catch (_) {}
}

// Start mDNS after window is up
app.whenReady().then(() => setTimeout(startDiscovery, 1200));

