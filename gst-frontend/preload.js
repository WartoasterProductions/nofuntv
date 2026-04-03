'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('gst', {
  // ── Platform / window ─────────────────────────────────────────────────────
  getPlatform: () => ipcRenderer.invoke('get-platform'),
  minimize:    () => ipcRenderer.invoke('window-minimize'),
  maximize:    () => ipcRenderer.invoke('window-maximize'),
  close:       () => ipcRenderer.invoke('window-close'),

  // ── File dialog ───────────────────────────────────────────────────────────
  openFile: () => ipcRenderer.invoke('open-file'),

  // ── Discovery / devices ───────────────────────────────────────────────────
  discoveryStart:     ()          => ipcRenderer.invoke('discovery-start'),
  discoveryScan:      ()          => ipcRenderer.invoke('discovery-scan'),
  deviceList:         ()          => ipcRenderer.invoke('device-list'),
  deviceAddManual:    (opts)      => ipcRenderer.invoke('device-add-manual', opts),
  deviceRemove:       (id)        => ipcRenderer.invoke('device-remove', id),
  deviceUpdateConfig: (opts)      => ipcRenderer.invoke('device-update-config', opts),
  deviceSend:         (opts)      => ipcRenderer.invoke('device-send', opts),

  onDeviceUpdate:       (cb) => ipcRenderer.on('device-update',        (_e, d) => cb(d)),
  onDeviceAck:          (cb) => ipcRenderer.on('device-ack',           (_e, d) => cb(d)),
  onDeviceStreamOutput: (cb) => ipcRenderer.on('device-stream-output', (_e, d) => cb(d)),

  // ── Stream management ─────────────────────────────────────────────────────
  streamStart: (opts) => ipcRenderer.invoke('stream-start', opts),
  streamStop:  (opts) => ipcRenderer.invoke('stream-stop',  opts),
  streamList:  ()     => ipcRenderer.invoke('stream-list'),

  onStreamOutput:  (cb) => ipcRenderer.on('stream-output',  (_e, d) => cb(d)),
  onStreamStopped: (cb) => ipcRenderer.on('stream-stopped', (_e, d) => cb(d)),

  // ── Terminal ──────────────────────────────────────────────────────────────
  runCommand:  (cmd) => ipcRenderer.invoke('run-command', cmd),
  killTerm:    ()    => ipcRenderer.invoke('kill-term'),
  onTermOutput:(cb)  => ipcRenderer.on('term-output', (_e, d) => cb(d)),

  // ── gst-inspect ───────────────────────────────────────────────────────────
  inspectElement: (binary, element) =>
    ipcRenderer.invoke('inspect-element', { binary, element }),
});
