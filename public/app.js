'use strict';

// ── DOM refs ─────────────────────────────────────────────────────────────────
const $ = (s) => document.getElementById(s);
const form         = $('stream-form');
const urlInput     = $('stream-url');
const clearBtn     = $('clear-stream');
const statusEl     = $('status');
const hostInput    = $('host-name');
const mdnsInput    = $('mdns-name');
const currentHost  = $('current-host');
const mdnsPreview  = $('mdns-preview');
const scanStatus   = $('scan-status');
const scanResults  = $('scan-results');
const pullFields   = $('pull-fields');
const pushFields   = $('push-fields');
const pushProto    = $('push-proto');
const pushPort     = $('push-port');
const agentDot     = $('agent-dot');
const agentLabel   = $('agent-label');

// Info panels
const infoMode     = $('info-mode');
const infoSource   = $('info-source');
const infoDecoder  = $('info-decoder');
const infoSink     = $('info-sink');
const infoAgent    = $('info-agent-streams');
const hwDecoder    = $('hw-decoder');
const hwSink       = $('hw-sink');
const hwPlatform   = $('hw-platform');
const hwDeviceName = $('hw-device-name');

// ── Status helpers ───────────────────────────────────────────────────────────
const setStatus = (msg, type) => {
  statusEl.textContent = msg;
  statusEl.className = 'status ' + (type || '');
};

// ── Tabs ─────────────────────────────────────────────────────────────────────
document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t)  => t.classList.remove('active'));
    document.querySelectorAll('.pane').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('pane-' + btn.dataset.tab).classList.add('active');
  });
});

// ── Mode selector ────────────────────────────────────────────────────────────
document.querySelectorAll('input[name="stream-mode"]').forEach((radio) => {
  radio.addEventListener('change', () => {
    const mode = radio.value;
    pullFields.classList.toggle('hidden', mode !== 'pull');
    pushFields.classList.toggle('hidden', mode !== 'push');
  });
});

function getSelectedMode() {
  const checked = document.querySelector('input[name="stream-mode"]:checked');
  return checked ? checked.value : 'pull';
}

// ── mDNS preview ─────────────────────────────────────────────────────────────
mdnsInput.addEventListener('input', () => {
  mdnsPreview.textContent = (mdnsInput.value.trim() || 'nofuntv') + '.local';
});

// ── Load config ──────────────────────────────────────────────────────────────
async function loadConfig() {
  try {
    const res  = await fetch('/api/config');
    if (!res.ok) throw new Error('Failed');
    const data = await res.json();

    // Populate stream form
    const mode = data.mode || 'pull';
    const modeRadio = document.querySelector('input[name="stream-mode"][value="' + mode + '"]');
    if (modeRadio) { modeRadio.checked = true; modeRadio.dispatchEvent(new Event('change')); }

    urlInput.value  = data.streamUrl || '';
    pushProto.value = data.protocol || 'udp';
    pushPort.value  = data.receivePort || 5000;

    // Device settings
    hostInput.value = data.hostName || '';
    mdnsInput.value = data.mdnsName || '';
    currentHost.textContent = data.currentHost || 'unknown';
    mdnsPreview.textContent = (data.mdnsName || 'nofuntv') + '.local';

    // Hardware info
    hwDecoder.textContent    = data.decoder    || '—';
    hwSink.textContent       = data.sink       || '—';
    hwDeviceName.textContent = data.deviceName || '—';
    hwPlatform.textContent   = 'linux'; // Pi is always linux

    // Info panel
    infoDecoder.textContent = data.decoder || '—';
    infoSink.textContent    = data.sink    || '—';
    updateInfoPanel(data);

    setStatus('Loaded settings.');
  } catch (e) {
    setStatus('Unable to load config.', 'error');
  }
}

function updateInfoPanel(data) {
  const mode = data.mode || 'pull';
  infoMode.textContent = mode.toUpperCase();

  if (mode === 'pull') {
    infoSource.textContent = data.streamUrl || '(none)';
  } else {
    const proto = data.protocol || 'udp';
    const port  = data.receivePort || 5000;
    infoSource.textContent = proto.toUpperCase() + ' :' + port;
  }
}

// ── Save stream config ───────────────────────────────────────────────────────
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const mode = getSelectedMode();

  const body = { mode: mode };
  if (mode === 'pull') {
    body.streamUrl = urlInput.value.trim();
  } else {
    body.protocol    = pushProto.value;
    body.receivePort = Number(pushPort.value) || 5000;
    body.streamUrl   = ''; // clear pull URL when in push mode
  }

  setStatus('Saving…');
  try {
    const res = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Save failed');
    }
    const data = await res.json();
    updateInfoPanel(data);
    setStatus(mode === 'pull'
      ? (body.streamUrl ? 'Saved — player reloading.' : 'Cleared stream.')
      : 'Listening on ' + body.protocol.toUpperCase() + ' port ' + body.receivePort + '.', 'ok');
  } catch (err) {
    setStatus(err.message, 'error');
  }
});

clearBtn.addEventListener('click', async () => {
  urlInput.value = '';
  setStatus('Saving clear…');
  try {
    await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ streamUrl: '', mode: 'pull' }),
    });
    setStatus('Stream cleared. Player will show idle screen.', 'ok');
    infoSource.textContent = '(none)';
    infoMode.textContent   = 'PULL';
  } catch (e) {
    setStatus('Clear failed', 'error');
  }
});

// ── Save device settings ─────────────────────────────────────────────────────
$('save-device').addEventListener('click', async () => {
  const body = {
    hostName: hostInput.value.trim(),
    mdnsName: mdnsInput.value.trim(),
  };
  try {
    const res = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Save failed');
    }
    const data = await res.json();
    currentHost.textContent = data.currentHost || 'unknown';
    setStatus('Device settings saved.', 'ok');
  } catch (err) {
    setStatus(err.message, 'error');
  }
});

// ── Network scanning ─────────────────────────────────────────────────────────
async function scan(type) {
  scanStatus.textContent = 'Scanning (' + type + ')…';
  scanResults.innerHTML  = '';
  try {
    const res = await fetch('/api/scan-streams?type=' + type);
    if (!res.ok) throw new Error('Scan failed');
    const data = await res.json();
    renderScanResults(data.services || []);
  } catch (e) {
    scanStatus.textContent = e.message || 'Scan failed';
  }
}

function renderScanResults(services) {
  scanResults.innerHTML = '';
  if (!services.length) {
    scanStatus.textContent = 'No services found.';
    return;
  }
  scanStatus.textContent = 'Found ' + services.length + ' service' + (services.length > 1 ? 's' : '') + '.';

  services.forEach((svc) => {
    const li   = document.createElement('li');
    const badge = svc.serviceType === 'nofuntv' ? 'NOFUNTV' : 'RTSP';
    const addr  = svc.address || svc.hostname || 'unknown';
    const port  = svc.port || '';

    li.innerHTML =
      '<div class="scan-meta">' +
        '<div class="scan-name">' +
          '<span class="svc-badge ' + badge.toLowerCase() + '">' + badge + '</span> ' +
          '<strong>' + esc(svc.name || 'unknown') + '</strong>' +
        '</div>' +
        '<div class="addr">' + esc(addr) + (port ? ':' + port : '') + '</div>' +
      '</div>';

    const useBtn = document.createElement('button');
    useBtn.className = 'button ghost';

    if (svc.serviceType === 'rtsp' && addr) {
      useBtn.textContent = 'Use as RTSP';
      useBtn.addEventListener('click', () => {
        // Switch to pull mode and fill URL
        const pullRadio = document.querySelector('input[name="stream-mode"][value="pull"]');
        pullRadio.checked = true;
        pullRadio.dispatchEvent(new Event('change'));
        urlInput.value = 'rtsp://' + addr + ':' + (port || 554) + '/';
        document.querySelector('[data-tab="stream"]').click();
        setStatus('Prefilled RTSP URL from scan. Adjust path and click Apply.', '');
      });
    } else if (svc.serviceType === 'nofuntv' && addr) {
      useBtn.textContent = 'Open UI';
      useBtn.addEventListener('click', () => {
        window.open('http://' + addr + ':' + (port || 80), '_blank');
      });
    } else {
      useBtn.textContent = 'No address';
      useBtn.disabled = true;
    }

    li.appendChild(useBtn);
    scanResults.appendChild(li);
  });
}

$('scan-all').addEventListener('click',     () => scan('all'));
$('scan-rtsp').addEventListener('click',    () => scan('rtsp'));
$('scan-nofuntv').addEventListener('click', () => scan('nofuntv'));

// ── WebSocket agent status ───────────────────────────────────────────────────
let ws = null;
let wsReconnectTimer = null;

function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(proto + '//' + location.host);

  ws.onopen = () => {
    agentDot.className   = 'agent-dot online';
    agentLabel.textContent = 'agent connected';
  };

  ws.onmessage = (evt) => {
    try {
      const msg = JSON.parse(evt.data);
      if (msg.type === 'hello' || msg.type === 'status') {
        infoDecoder.textContent = msg.decoder || '—';
        infoSink.textContent    = msg.sink    || '—';
        hwDecoder.textContent   = msg.decoder || '—';
        hwSink.textContent      = msg.sink    || '—';
        hwDeviceName.textContent = msg.device || '—';
        hwPlatform.textContent   = msg.platform || '—';
        infoAgent.textContent = msg.activeStreams && msg.activeStreams.length
          ? msg.activeStreams.join(', ')
          : 'none';
      }
    } catch (_) {}
  };

  ws.onclose = () => {
    agentDot.className   = 'agent-dot offline';
    agentLabel.textContent = 'agent disconnected';
    clearTimeout(wsReconnectTimer);
    wsReconnectTimer = setTimeout(connectWs, 3000);
  };

  ws.onerror = () => {};
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── Init ─────────────────────────────────────────────────────────────────────
loadConfig();
connectWs();
