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

// ─── mDNS discovery ───────────────────────────────────────────────────────────

const discoveredDevices = new Map(); // id → device info
let bonjourBrowser  = null;
let bonjourInstance = null;

function startDiscovery() {
  try {
    const { Bonjour } = require('bonjour-service');
    bonjourInstance = new Bonjour();
    bonjourBrowser  = bonjourInstance.find({ type: 'nofuntv' }, (service) => {
      const id = service.host + ':' + service.port;
      const ip = (service.addresses || []).find((a) => !a.includes(':')) || service.host;
      if (!discoveredDevices.has(id)) {
        const info = {
          id, name: service.name || service.host, host: service.host,
          ip, port: service.port,
          decoder: (service.txt && service.txt.decoder) || 'avdec_h264',
          sink:    (service.txt && service.txt.sink)    || 'autovideosink',
          status: 'discovered',
        };
        discoveredDevices.set(id, info);
        console.log('[discovery] found "' + info.name + '" at ' + ip + ':' + service.port);
        connectToDevice(id, info);
      }
    });
    console.log('[discovery] mDNS browser started (_nofuntv._tcp)');
  } catch (e) {
    console.warn('[discovery] bonjour-service unavailable:', e.message);
  }
}

ipcMain.handle('discovery-start', () => {
  if (!bonjourBrowser) startDiscovery();
  return { ok: true };
});

// Full re-scan: destroy browser, wait, restart it, then also ping known devices
ipcMain.handle('discovery-scan', () => {
  // Ping existing connected devices
  for (const [id] of deviceClients) wsSend(id, { type: 'status' });
  // Restart the mDNS browser so newly-appeared devices get found
  if (bonjourBrowser) {
    try { bonjourBrowser.stop(); } catch (_) {}
    bonjourBrowser = null;
  }
  if (bonjourInstance) {
    try { bonjourInstance.destroy(); } catch (_) {}
    bonjourInstance = null;
  }
  // Short delay then restart so the network stack flushes
  setTimeout(startDiscovery, 300);
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
  const { id, decoder, sink } = opts;
  const dev = discoveredDevices.get(id);
  if (!dev) return { ok: false };
  if (decoder) dev.decoder = decoder;
  if (sink)    dev.sink    = sink;
  discoveredDevices.set(id, dev);
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
  const bitrate   = config.bitrate   || 4000;
  const keyframe  = config.keyframe  || 30;
  const preset    = config.preset    || 'ultrafast';
  const tune      = config.tune      || 'zerolatency';
  const platform  = config.platform  || os.platform();
  let src;
  if (srcType === 'file') { src = 'filesrc location="' + filePath.replace(/"/g, '\\"') + '" ! decodebin ! videorate'; }
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
  else { enc = 'x264enc tune=' + tune + ' speed-preset=' + preset + ' bitrate=' + bitrate + ' key-int-max=' + keyframe + ' byte-stream=true'; }
  return '( ' + [src, caps, scale, enc, 'video/x-h264,profile=baseline', 'rtph264pay name=pay0 pt=96 config-interval=1'].join(' ! ') + ' )';
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
  const bitrate   = config.bitrate   || 4000;
  const keyframe  = config.keyframe  || 30;
  const preset    = config.preset    || 'ultrafast';
  const tune      = config.tune      || 'zerolatency';
  const proto     = config.proto     || 'udp';
  const platform  = config.platform  || os.platform();

  let src;
  if (srcType === 'file') {
    src = 'filesrc location="' + filePath.replace(/"/g, '\\"') + '" ! decodebin ! videorate';
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
        + ' bitrate=' + bitrate + ' key-int-max=' + keyframe + ' byte-stream=true';
  }

  const profile = 'video/x-h264,profile=baseline';
  const pay     = 'rtph264pay config-interval=1 pt=96';

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
  const proc   = spawn('"' + binary + '" -e ' + pipeline, [], { shell: true, windowsHide: true });

  senderStreams.set(streamId, {
    proc, port, config, pipeline,
    assignedDevices: new Set(deviceIds),
  });

  proc.stdout.on('data', (d) =>
    send('stream-output', { streamId, type: 'out', data: d.toString() }));
  proc.stderr.on('data', (d) =>
    send('stream-output', { streamId, type: 'err', data: d.toString() }));
  proc.on('error', (e) =>
    send('stream-output', { streamId, type: 'sys', data: '[error] ' + e.message + '\n' }));
  proc.on('close', (code) => {
    send('stream-output', { streamId, type: 'sys', data: '[exit ' + code + ']\n' });
    send('stream-stopped', { streamId });
    const s = senderStreams.get(streamId);
    if (s) s.proc = null;
  });

  // Tell each assigned device to start its RTP/SRT receiver
  for (const dev of devices) {
    const overrides = (config.overrides && config.overrides[dev.id]) || {};
    wsSend(dev.id, {
      type:     'start',
      streamId,
      port,
      jitter:   config.jitter  || 50,
      decoder:  overrides.decoder || dev.decoder,
      sink:     overrides.sink    || dev.sink,
      proto:    config.proto   || 'udp',
      dropLate: true,
      sync:     false,
    });
  }

  return { ok: true, pid: proc.pid, port, pipeline };
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
  senderStreams.forEach((s) => { if (s.proc) try { s.proc.kill(); } catch (_) {} });
  if (termProc) try { termProc.kill(); } catch (_) {}
  deviceClients.forEach((_, id) => disconnectDevice(id));
  if (bonjourInstance) try { bonjourInstance.destroy(); } catch (_) {}
}

// Start mDNS after window is up
app.whenReady().then(() => setTimeout(startDiscovery, 1200));

