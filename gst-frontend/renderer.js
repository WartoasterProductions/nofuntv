'use strict';

// ── State ─────────────────────────────────────────────────────────────────────
let PLATFORM         = 'linux';
let devices          = [];        // array of device info from main process
let streams          = new Map(); // streamId → { config, assignedDevices: Set, running }
let nextStreamId     = 1;
let selectedStreamId = null;

const termHistory    = [];
let termHistIdx      = -1;

// ── Boot ──────────────────────────────────────────────────────────────────────
(async () => {
  PLATFORM = await window.gst.getPlatform();
  restoreSettings();
  setupWindowControls();
  setupTabs();
  setupResizeHandles();
  setupStreamSidebar();
  setupStreamEditor();
  setupDevicesPane();
  setupTerminal();
  setupSettings();
  setupIpcCallbacks();
  window.gst.discoveryStart();

  // Bootstrap: pull whatever devices main already knows about
  // (covers the case where Pi was connected before this window loaded)
  const initialDevices = await window.gst.deviceList();
  if (Array.isArray(initialDevices) && initialDevices.length) {
    devices = initialDevices;
    renderDeviceCards();
    renderDeviceRoutingList();
    renderDeviceBadge();
  }

  // Trigger a scan after 1.5 s so any already-advertising Pi gets picked up
  // even if the mDNS response arrived before our browser was ready.
  setTimeout(() => window.gst.discoveryScan(), 1500);
})();

// ── Resize handles ────────────────────────────────────────────────────────────
function setupResizeHandles() {
  makePaneResizable('rh-sidebar',     'stream-sidebar',     140, 380);
  makePaneResizable('rh-editor-left', 'editor-left-panel',  180, 700);
}

function makePaneResizable(handleId, targetId, minW, maxW) {
  const handle = document.getElementById(handleId);
  const target = document.getElementById(targetId);
  if (!handle || !target) return;
  let startX = 0, startW = 0;
  handle.addEventListener('mousedown', (e) => {
    startX = e.clientX;
    startW = target.getBoundingClientRect().width;
    handle.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    const onMove = (ev) => {
      const w = Math.min(maxW, Math.max(minW, startW + (ev.clientX - startX)));
      target.style.width = w + 'px';
    };
    const onUp = () => {
      handle.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup',   onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup',   onUp);
    e.preventDefault();
  });
}

// ── Window controls ───────────────────────────────────────────────────────────
function setupWindowControls() {
  document.getElementById('btn-min').onclick   = () => window.gst.minimize();
  document.getElementById('btn-max').onclick   = () => window.gst.maximize();
  document.getElementById('btn-close').onclick = () => window.gst.close();
}

// ── Tabs ──────────────────────────────────────────────────────────────────────
function setupTabs() {
  document.querySelectorAll('.tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((t)  => t.classList.remove('active'));
      document.querySelectorAll('.pane').forEach((p) => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('pane-' + btn.dataset.tab).classList.add('active');
      if (btn.dataset.tab === 'terminal')
        setTimeout(() => document.getElementById('term-input').focus(), 50);
      if (btn.dataset.tab === 'streams')
        renderDeviceRoutingList();
    });
  });
}

// ── IPC callbacks (from main process) ────────────────────────────────────────
function setupIpcCallbacks() {
  window.gst.onDeviceUpdate((list) => {
    devices = list;
    renderDeviceCards();
    renderDeviceRoutingList();
    renderDeviceBadge();
  });

  window.gst.onDeviceAck((data) => {
    const stream = streams.get(data.streamId);
    if (stream) {
      if (data.status === 'stopped') {
        stream.deviceStatus = stream.deviceStatus || {};
        stream.deviceStatus[data.deviceId] = 'stopped';
      }
    }
  });

  window.gst.onDeviceStreamOutput((data) => {
    if (selectedStreamId === data.streamId)
      appendLog('es-log', data.level || 'out', '[' + data.deviceId + '] ' + data.data);
  });

  window.gst.onStreamOutput((data) => {
    if (selectedStreamId === data.streamId)
      appendLog('es-log', data.type, data.data);
  });

  window.gst.onStreamStopped((data) => {
    const stream = streams.get(data.streamId);
    if (stream) {
      stream.running = false;
      renderStreamSidebar();
      if (selectedStreamId === data.streamId) syncEditorStatus(data.streamId);
    }
  });

  window.gst.onTermOutput((d) => appendLog('term-log', d.type, d.data));
}

// ── Device badge (titlebar) ───────────────────────────────────────────────────
function renderDeviceBadge() {
  const connected = devices.filter((d) => d.connected).length;
  const badge     = document.getElementById('device-badge');
  const count     = document.getElementById('badge-count');
  if (connected > 0) {
    badge.classList.remove('hidden');
    count.textContent = connected;
  } else {
    badge.classList.add('hidden');
  }
}

// ── Stream sidebar ────────────────────────────────────────────────────────────
function setupStreamSidebar() {
  document.getElementById('btn-add-stream').addEventListener('click', addStream);
}

function addStream() {
  const id = nextStreamId++;
  streams.set(id, {
    id,
    label:           'Stream ' + id,
    assignedDevices: new Set(),
    running:         false,
    config:          defaultConfig(),
    filePath:        '',
  });
  renderStreamSidebar();
  selectStream(id);
}

function defaultConfig() {
  return {
    srcType:   'screen',
    filePath:  '',
    srcUrl:    '',
    webcam:    '/dev/video0',
    screenIdx: 0,
    width:     1280,
    height:    720,
    fps:       30,
    codec:     'x264enc',
    bitrate:   4000,
    keyframe:  30,
    preset:    'ultrafast',
    tune:      'zerolatency',
    proto:     'udp',
    jitter:    50,
    overrides: {},
  };
}

function renderStreamSidebar() {
  const ul = document.getElementById('stream-list-ul');
  ul.innerHTML = '';
  streams.forEach((stream) => {
    const li  = document.createElement('li');
    li.className = 'stream-slot-item' + (stream.id === selectedStreamId ? ' active' : '');
    li.dataset.id = stream.id;

    const dot = document.createElement('span');
    dot.className = 'stream-slot-dot' + (stream.running ? ' running' : '');

    const num = document.createElement('span');
    num.className = 'stream-slot-num';
    num.textContent = stream.id;

    const lbl = document.createElement('span');
    lbl.className = 'stream-slot-label';
    lbl.textContent = stream.label;

    li.appendChild(num);
    li.appendChild(lbl);
    li.appendChild(dot);
    li.addEventListener('click', () => selectStream(stream.id));
    ul.appendChild(li);
  });
}

// ── Stream editor ─────────────────────────────────────────────────────────────
function setupStreamEditor() {
  // Source type
  document.querySelectorAll('input[name="es-src-type"]').forEach((r) => {
    r.addEventListener('change', () => { showSrcRow(r.value); rebuildPipeline(); });
  });

  // File browse
  document.getElementById('es-btn-browse').addEventListener('click', async () => {
    const fp = await window.gst.openFile();
    if (fp) {
      const stream = streams.get(selectedStreamId);
      if (stream) { stream.filePath = fp; stream.config.filePath = fp; }
      document.getElementById('es-file-display').textContent = fp;
      rebuildPipeline();
    }
  });

  // Resolution
  document.getElementById('es-res').addEventListener('change', (e) => {
    document.getElementById('es-res-custom').classList.toggle('hidden', e.target.value !== 'custom');
    rebuildPipeline();
  });

  // All simple inputs
  ['es-src-url','es-src-rtsp-url','es-webcam-dev','es-screen-idx','es-fps','es-codec','es-preset','es-tune',
   'es-width','es-height','es-proto'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('input',  rebuildPipeline);
      el.addEventListener('change', rebuildPipeline);
    }
  });

  // Codec toggle
  document.getElementById('es-codec').addEventListener('change', (e) => {
    document.getElementById('es-x264-opts').style.display =
      e.target.value === 'x264enc' ? '' : 'none';
  });

  // Sliders
  setupSliderLive('es-bitrate',  'es-val-bitrate',  (v) => v, rebuildPipeline);
  setupSliderLive('es-keyframe', 'es-val-keyframe', (v) => v, rebuildPipeline);
  setupSliderLive('es-jitter',   'es-val-jitter',   (v) => v, rebuildPipeline);

  // Routing quick-select
  document.getElementById('rp-all').addEventListener('click', () => {
    const stream = streams.get(selectedStreamId);
    if (!stream) return;
    devices.forEach((d) => stream.assignedDevices.add(d.id));
    renderDeviceRoutingList();
    rebuildPipeline();
  });
  document.getElementById('rp-none').addEventListener('click', () => {
    const stream = streams.get(selectedStreamId);
    if (!stream) return;
    stream.assignedDevices.clear();
    renderDeviceRoutingList();
    rebuildPipeline();
  });

  // Pipeline copy
  document.getElementById('es-copy-pipe').addEventListener('click', () => {
    navigator.clipboard.writeText(document.getElementById('es-pipeline').value);
  });

  // Start / Stop
  document.getElementById('es-start').addEventListener('click', startSelectedStream);
  document.getElementById('es-stop').addEventListener('click',  stopSelectedStream);

  // Delete slot
  document.getElementById('es-delete-stream').addEventListener('click', () => {
    if (!selectedStreamId) return;
    stopSelectedStream();
    streams.delete(selectedStreamId);
    selectedStreamId = null;
    renderStreamSidebar();
    showEditorEmpty(true);
  });

  // Clear log
  document.getElementById('es-clear-log').addEventListener('click', () => clearLog('es-log'));
}

function showSrcRow(type) {
  ['file','url','rtsp','webcam','screen'].forEach((t) => {
    const el = document.getElementById('es-src-' + t + '-row');
    if (el) el.classList.toggle('hidden', t !== type);
  });
}

function selectStream(id) {
  selectedStreamId = id;
  renderStreamSidebar();
  const stream = streams.get(id);
  if (!stream) { showEditorEmpty(true); return; }
  showEditorEmpty(false);
  populateEditorFromStream(stream);
  renderDeviceRoutingList();
  rebuildPipeline();
  syncEditorStatus(id);
}

function showEditorEmpty(empty) {
  document.getElementById('stream-editor-empty').classList.toggle('hidden', !empty);
  document.getElementById('stream-editor-form').classList.toggle('hidden', empty);
}

function populateEditorFromStream(stream) {
  const c = stream.config;

  // Source type
  const radio = document.querySelector('input[name="es-src-type"][value="' + c.srcType + '"]');
  if (radio) { radio.checked = true; showSrcRow(c.srcType); }

  document.getElementById('es-file-display').textContent = stream.filePath || 'no file';
  document.getElementById('es-src-url').value      = c.srcType !== 'rtsp' ? (c.srcUrl || '') : '';
  const rtspInput = document.getElementById('es-src-rtsp-url');
  if (rtspInput) rtspInput.value = c.srcType === 'rtsp' ? (c.srcUrl || '') : '';
  document.getElementById('es-webcam-dev').value   = c.webcam    || '/dev/video0';
  document.getElementById('es-screen-idx').value   = c.screenIdx || 0;

  // Resolution
  const resKey = c.width + 'x' + c.height;
  const resEl  = document.getElementById('es-res');
  const presets = ['1920x1080','1280x720','854x480','640x360'];
  resEl.value = presets.includes(resKey) ? resKey : 'custom';
  document.getElementById('es-res-custom').classList.toggle('hidden', resEl.value !== 'custom');
  document.getElementById('es-width').value  = c.width;
  document.getElementById('es-height').value = c.height;

  document.getElementById('es-fps').value    = c.fps;
  document.getElementById('es-codec').value  = c.codec;
  document.getElementById('es-preset').value = c.preset;
  document.getElementById('es-tune').value   = c.tune;
  document.getElementById('es-proto').value  = c.proto;

  document.getElementById('es-x264-opts').style.display = c.codec === 'x264enc' ? '' : 'none';

  setSlider('es-bitrate',  'es-val-bitrate',  c.bitrate);
  setSlider('es-keyframe', 'es-val-keyframe', c.keyframe);
  setSlider('es-jitter',   'es-val-jitter',   c.jitter);
}

function readEditorConfig() {
  const stream = streams.get(selectedStreamId);
  if (!stream) return null;

  const resVal  = document.getElementById('es-res').value;
  let width, height;
  if (resVal === 'custom') {
    width  = Number(document.getElementById('es-width').value)  || 1280;
    height = Number(document.getElementById('es-height').value) || 720;
  } else {
    const parts = resVal.split('x');
    width  = Number(parts[0]);
    height = Number(parts[1]);
  }

  const srcType = document.querySelector('input[name="es-src-type"]:checked')?.value || 'screen';

  // For RTSP source, use the dedicated RTSP URL input
  let srcUrlVal = document.getElementById('es-src-url').value.trim();
  if (srcType === 'rtsp') {
    srcUrlVal = (document.getElementById('es-src-rtsp-url')?.value || '').trim();
  }

  const config = {
    srcType,
    filePath:  stream.filePath || '',
    srcUrl:    srcUrlVal,
    webcam:    document.getElementById('es-webcam-dev').value.trim() || '/dev/video0',
    screenIdx: Number(document.getElementById('es-screen-idx').value) || 0,
    width, height,
    fps:       Number(document.getElementById('es-fps').value),
    codec:     document.getElementById('es-codec').value,
    bitrate:   Number(document.getElementById('es-bitrate').value),
    keyframe:  Number(document.getElementById('es-keyframe').value),
    preset:    document.getElementById('es-preset').value,
    tune:      document.getElementById('es-tune').value,
    proto:     document.getElementById('es-proto').value,
    jitter:    Number(document.getElementById('es-jitter').value),
    overrides: stream.config.overrides || {},
    platform:  PLATFORM,
  };

  stream.config = config;
  return config;
}

function rebuildPipeline() {
  const config = readEditorConfig();
  if (!config) return;

  const stream   = streams.get(selectedStreamId);
  const basePort = Number(document.getElementById('cfg-base-port').value) || 5000;
  const port     = basePort + (selectedStreamId - 1);

  document.getElementById('es-port-preview').value = port;

  const deviceIds = stream ? [...stream.assignedDevices] : [];
  const ips       = deviceIds.map((id) => {
    const d = devices.find((dv) => dv.id === id);
    return d ? d.ip : null;
  }).filter(Boolean);

  document.getElementById('es-pipeline').value =
    ips.length > 0
      ? buildPipelineString(config, ips, port)
      : buildPipelineString(config, ['<device-ip>'], port);
}

function buildPipelineString(config, ips, port) {
  const {
    srcType, filePath, srcUrl, webcam, screenIdx,
    width, height, fps, codec, bitrate, keyframe,
    preset, tune, proto, platform,
  } = config;

  // RTSP passthrough — no local sender needed, devices pull directly
  if (srcType === 'rtsp') {
    return '# RTSP pull mode — no local sender pipeline.\n'
         + '# Devices will pull directly from: ' + (srcUrl || 'rtsp://host/live') + '\n'
         + '# Each device runs: rtspsrc location=\"' + (srcUrl || 'rtsp://host/live')
         + '\" latency=' + (config.jitter || 50) + ' ! rtph264depay ! h264parse ! <decoder> ! <sink>';
  }

  let src;
  if (srcType === 'file') {
    src = 'filesrc location="' + (filePath || 'video.mp4') + '" ! decodebin ! videorate';
  } else if (srcType === 'url') {
    src = 'urisourcebin uri="' + (srcUrl || 'rtsp://x/live') + '" ! decodebin ! videorate';
  } else if (srcType === 'rtsp') {
    src = 'rtspsrc location="' + (srcUrl || 'rtsp://host/live') + '" latency=200 protocols=udp+tcp'
        + ' ! rtph264depay ! h264parse';
  } else if (srcType === 'screen') {
    src = (platform || PLATFORM) === 'win32'
      ? 'd3d11screencapturesrc monitor-index=' + (screenIdx || 0)
      : 'ximagesrc use-damage=false display-name=:0';
  } else if (srcType === 'webcam') {
    src = (platform || PLATFORM) === 'win32'
      ? 'ksvideosrc device-index=' + (webcam || '0')
      : 'v4l2src device=' + (webcam || '/dev/video0');
  } else {
    src = 'videotestsrc pattern=smpte';
  }

  const caps  = 'video/x-raw,framerate=' + fps + '/1';
  const scale = 'videoconvert ! video/x-raw,format=I420 ! videoscale'
              + ' ! video/x-raw,width=' + width + ',height=' + height + ',pixel-aspect-ratio=1/1';

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
    const clients = ips.map((ip) => ip + ':' + port).join(',');
    sink = 'multiudpsink clients="' + clients + '"';
  }

  return [src, caps, scale, enc, profile, pay, sink].join(' ! ');
}

// ── Device routing list (inside stream editor) ────────────────────────────────
function renderDeviceRoutingList() {
  const container = document.getElementById('device-routing-list');
  const stream    = streams.get(selectedStreamId);

  container.innerHTML = '';

  if (devices.length === 0) {
    container.innerHTML = '<p class="no-devices-hint">No devices discovered yet.<br>Go to DEVICES tab to add manually.</p>';
    return;
  }

  if (!stream) {
    container.innerHTML = '<p class="no-devices-hint">Select a stream to assign devices.</p>';
    return;
  }

  devices.forEach((dev) => {
    const item = document.createElement('div');
    item.className = 'device-route-item'
                   + (stream.assignedDevices.has(dev.id) ? ' selected' : '')
                   + (dev.connected ? '' : ' offline');

    const dot = document.createElement('span');
    dot.className = 'dri-dot ' + (dev.connected ? 'online' : 'offline');

    const label = document.createElement('span');
    label.textContent = dev.name || dev.ip;

    item.appendChild(dot);
    item.appendChild(label);

    item.addEventListener('click', () => {
      if (!dev.connected) return;
      if (stream.assignedDevices.has(dev.id))
        stream.assignedDevices.delete(dev.id);
      else
        stream.assignedDevices.add(dev.id);
      item.classList.toggle('selected', stream.assignedDevices.has(dev.id));
      rebuildPipeline();
    });

    container.appendChild(item);
  });
}

// ── Start / Stop stream ───────────────────────────────────────────────────────
async function startSelectedStream() {
  if (!selectedStreamId) return;
  const stream    = streams.get(selectedStreamId);
  const config    = readEditorConfig();
  const basePort  = Number(document.getElementById('cfg-base-port').value) || 5000;
  const gstBin    = document.getElementById('cfg-gst-bin').value.trim() || null;
  const deviceIds = [...stream.assignedDevices];

  if (deviceIds.length === 0) {
    appendLog('es-log', 'sys', '[error] No devices selected in routing panel.\n');
    return;
  }

  appendLog('es-log', 'sys', '[starting stream ' + selectedStreamId + ' → ' + deviceIds.join(', ') + ']\n');

  const result = await window.gst.streamStart({
    streamId: selectedStreamId,
    config,
    deviceIds,
    basePort,
    gstBin,
  });

  if (result.ok) {
    stream.running = true;
    appendLog('es-log', 'sys', '[sender PID ' + result.pid + ' port ' + result.port + ']\n');
  } else {
    appendLog('es-log', 'err', '[failed: ' + result.error + ']\n');
  }

  renderStreamSidebar();
  syncEditorStatus(selectedStreamId);
}

async function stopSelectedStream() {
  if (!selectedStreamId) return;
  await window.gst.streamStop({ streamId: selectedStreamId });
  const stream = streams.get(selectedStreamId);
  if (stream) { stream.running = false; }
  appendLog('es-log', 'sys', '[stopped stream ' + selectedStreamId + ']\n');
  renderStreamSidebar();
  syncEditorStatus(selectedStreamId);
}

function syncEditorStatus(streamId) {
  const stream = streams.get(streamId);
  if (!stream) return;
  const running = stream.running;
  document.getElementById('es-start').classList.toggle('hidden', running);
  document.getElementById('es-stop').classList.toggle('hidden', !running);
  const dot  = document.getElementById('es-status-dot');
  const text = document.getElementById('es-status-text');
  dot.className   = 'status-dot ' + (running ? 'running' : '');
  text.textContent = running ? 'streaming' : 'idle';
}

// ── Device cards ──────────────────────────────────────────────────────────────
function renderDeviceCards() {
  const container = document.getElementById('device-cards');
  container.innerHTML = '';

  if (devices.length === 0) {
    container.innerHTML =
      '<div class="no-devices-hint">'
      + '<p>No devices found.</p>'
      + '<p class="hint">Run <code>node agent.js</code> on your Pi / Orange Pi.'
      + ' They appear here automatically via mDNS, or add manually above.</p></div>';
    return;
  }

  devices.forEach((dev) => {
    const card = document.createElement('div');
    card.className = 'device-card ' + (dev.connected ? 'connected' : 'disconnected');
    card.dataset.id = dev.id;

    // Active streams for this device
    const activeStreams = [];
    streams.forEach((s, sid) => {
      if (s.running && s.assignedDevices.has(dev.id)) activeStreams.push(sid);
    });

    card.innerHTML =
      '<div class="dc-header">'
      +   '<span class="dc-name" contenteditable="plaintext-only" spellcheck="false" title="Click to rename">' + esc(dev.name || dev.ip) + '</span>'
      +   '<span class="dc-status"><span class="dc-dot ' + (dev.connected ? 'online' : 'offline') + '"></span>'
      +     (dev.connected ? 'connected' : 'offline') + '</span>'
      + '</div>'
      + '<div class="dc-meta">'
      +   '<div>IP: <span>' + esc(dev.ip) + '</span>'
      +     (dev.latency != null ? ' &nbsp;<span class="dc-latency">' + dev.latency + 'ms</span>' : '') + '</div>'
      +   '<div>Decoder: <span>' + esc(dev.decoder) + '</span></div>'
      +   '<div>Sink: <span>' + esc(dev.sink) + '</span></div>'
      + '</div>'
      + '<div class="dc-overrides">'
      +   '<label class="field-label">Decoder override</label>'
      +   '<select class="select dc-decoder-sel">'
      +     decoderOptions(dev.decoder)
      +   '</select>'
      +   '<label class="field-label">Sink override</label>'
      +   '<select class="select dc-sink-sel">'
      +     sinkOptions(dev.sink)
      +   '</select>'
      + '</div>'
      + (activeStreams.length
          ? '<div class="dc-streams">'
            + activeStreams.map((sid) => '<span class="dc-stream-badge">STREAM ' + sid + '</span>').join('')
            + '</div>'
          : '')
      + '<div class="dc-actions">'
      +   '<button class="btn ghost tiny dc-ping">PING</button>'
      +   '<button class="btn danger tiny dc-remove">REMOVE</button>'
      + '</div>';

    // Name edit → save on blur or Enter
    const nameEl = card.querySelector('.dc-name');
    const saveName = () => {
      const n = nameEl.textContent.trim();
      if (n && n !== dev.name) window.gst.deviceUpdateConfig({ id: dev.id, name: n });
    };
    nameEl.addEventListener('blur', saveName);
    nameEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); nameEl.blur(); } });

    // Override change → persist to main
    card.querySelector('.dc-decoder-sel').addEventListener('change', (e) =>
      window.gst.deviceUpdateConfig({ id: dev.id, decoder: e.target.value }));
    card.querySelector('.dc-sink-sel').addEventListener('change', (e) =>
      window.gst.deviceUpdateConfig({ id: dev.id, sink: e.target.value }));

    // Ping
    card.querySelector('.dc-ping').addEventListener('click', () =>
      window.gst.deviceSend({ deviceId: dev.id, msg: { type: 'ping', ts: Date.now() } }));

    // Remove
    card.querySelector('.dc-remove').addEventListener('click', () =>
      window.gst.deviceRemove(dev.id));

    container.appendChild(card);
  });
}

function decoderOptions(current) {
  return ['v4l2h264dec','mppvideodec','avdec_h264','nvh264dec'].map((v) =>
    '<option value="' + v + '"' + (v === current ? ' selected' : '') + '>' + v + '</option>'
  ).join('');
}

function sinkOptions(current) {
  return ['kmssink','waylandsink','xvimagesink sync=false','autovideosink'].map((v) =>
    '<option value="' + v + '"' + (v === current ? ' selected' : '') + '>' + v + '</option>'
  ).join('');
}

// ── Devices pane ──────────────────────────────────────────────────────────────
function setupDevicesPane() {
  document.getElementById('btn-scan').addEventListener('click', () =>
    window.gst.discoveryScan());

  const form   = document.getElementById('manual-add-form');
  const addBtn = document.getElementById('btn-add-device');
  addBtn.addEventListener('click', () => form.classList.toggle('hidden'));

  document.getElementById('manual-add-cancel').addEventListener('click', () =>
    form.classList.add('hidden'));

  document.getElementById('manual-add-confirm').addEventListener('click', async () => {
    const ip   = document.getElementById('manual-ip').value.trim();
    const port = Number(document.getElementById('manual-port').value) || 80;
    const name = document.getElementById('manual-name').value.trim();
    if (!ip) return;
    await window.gst.deviceAddManual({ ip, port, name });
    form.classList.add('hidden');
    document.getElementById('manual-ip').value   = '';
    document.getElementById('manual-name').value = '';
  });
}

// ── Terminal ──────────────────────────────────────────────────────────────────
function setupTerminal() {
  const input  = document.getElementById('term-input');
  const runBtn = document.getElementById('term-run');

  const run = () => {
    const cmd = input.value.trim();
    if (!cmd) return;
    termHistory.unshift(cmd);
    termHistIdx = -1;
    appendLog('term-log', 'sys', '> ' + cmd + '\n');
    window.gst.runCommand(cmd);
    input.value = '';
  };

  runBtn.addEventListener('click', run);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { run(); return; }
    if (e.key === 'ArrowUp') {
      termHistIdx = Math.min(termHistIdx + 1, termHistory.length - 1);
      input.value = termHistory[termHistIdx] || '';
      e.preventDefault();
    }
    if (e.key === 'ArrowDown') {
      termHistIdx = Math.max(termHistIdx - 1, -1);
      input.value = termHistIdx < 0 ? '' : (termHistory[termHistIdx] || '');
      e.preventDefault();
    }
  });

  document.getElementById('term-kill').addEventListener('click', () => {
    window.gst.killTerm();
    appendLog('term-log', 'sys', '[killed]\n');
  });
  document.getElementById('term-clear').addEventListener('click', () => clearLog('term-log'));
}

// ── Settings ──────────────────────────────────────────────────────────────────
function setupSettings() {
  const binInput  = document.getElementById('cfg-gst-bin');
  const portInput = document.getElementById('cfg-base-port');

  binInput.addEventListener('input',  saveSettings);
  portInput.addEventListener('input', () => { saveSettings(); rebuildPipeline(); });

  document.getElementById('diag-gst-version').addEventListener('click', () => {
    const bin = binInput.value.trim() || 'gst-launch-1.0';
    switchToTerminal('"' + bin + '" --version');
  });
  document.getElementById('diag-inspect-h264').addEventListener('click', () => {
    const bin = (binInput.value.trim() || 'gst-launch-1.0').replace('gst-launch-1.0','gst-inspect-1.0');
    switchToTerminal('"' + bin + '" | grep -i h264');
  });
  document.getElementById('diag-inspect-udp').addEventListener('click', () => {
    const bin = (binInput.value.trim() || 'gst-launch-1.0').replace('gst-launch-1.0','gst-inspect-1.0');
    switchToTerminal('"' + bin + '" udpsrc');
  });
}

function switchToTerminal(cmd) {
  document.querySelector('[data-tab="terminal"]').click();
  document.getElementById('term-input').value = cmd;
  setTimeout(() => document.getElementById('term-run').click(), 50);
}

function saveSettings() {
  localStorage.setItem('nofun-gst-v2', JSON.stringify({
    gstBin:   document.getElementById('cfg-gst-bin').value,
    basePort: document.getElementById('cfg-base-port').value,
  }));
}

function restoreSettings() {
  try {
    const raw = localStorage.getItem('nofun-gst-v2');
    if (!raw) return;
    const s = JSON.parse(raw);
    if (s.gstBin)   document.getElementById('cfg-gst-bin').value    = s.gstBin;
    if (s.basePort) document.getElementById('cfg-base-port').value  = s.basePort;
  } catch (_) {}
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function appendLog(logId, type, text) {
  const el = document.getElementById(logId);
  if (!el) return;
  const span = document.createElement('span');
  span.className = type === 'err' ? 'err' : type === 'sys' ? 'sys' : 'out';
  span.textContent = text;
  el.appendChild(span);
  el.scrollTop = el.scrollHeight;
}

function clearLog(logId) {
  const el = document.getElementById(logId);
  if (el) el.innerHTML = '';
}

function setupSliderLive(sliderId, valId, fmt, onChange) {
  const slider = document.getElementById(sliderId);
  const valEl  = document.getElementById(valId);
  if (!slider) return;
  const update = () => {
    valEl.textContent = fmt(slider.value);
    updateSliderFill(slider);
    onChange && onChange();
  };
  slider.addEventListener('input', update);
  updateSliderFill(slider);
}

function setSlider(sliderId, valId, value) {
  const slider = document.getElementById(sliderId);
  const valEl  = document.getElementById(valId);
  if (!slider) return;
  slider.value = value;
  if (valEl) valEl.textContent = value;
  updateSliderFill(slider);
}

function updateSliderFill(slider) {
  const pct = ((slider.value - slider.min) / (slider.max - slider.min)) * 100;
  slider.style.background =
    'linear-gradient(to right, var(--accent) ' + pct + '%, var(--bg4) ' + pct + '%)';
}

function esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
