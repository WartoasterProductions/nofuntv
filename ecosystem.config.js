const os = require('os');
const path = require('path');

module.exports = {
  apps: [
    {
      name: 'nofuntv-server',
      script: 'server.js',
      cwd: __dirname,
      // Restart automatically on crash; back off up to 10 s between attempts
      autorestart: true,
      restart_delay: 2000,
      max_restarts: 20,
      env: {
        PORT: 80,
        HOST: '0.0.0.0'
      }
    }
    // server.js now includes the agent (WebSocket + mDNS) in-process.
    // nofuntv-player is NOT managed by pm2 — it is launched by the desktop
    // compositor (labwc) autostart so it inherits the correct Wayland display
    // environment.  restart-player.sh kills gst-launch to trigger a reload.
  ]
};
