/**
 * pm2 process definition.
 *
 *   pm2 start ecosystem.config.cjs
 *   pm2 logs circleftp-jellyfin
 *   pm2 restart circleftp-jellyfin
 *
 * CommonJS (.cjs) on purpose: the repo is ESM ("type": "module"), and pm2 loads
 * this file with require().
 */
const path = require('node:path');

const serverDir = path.join(__dirname, 'packages', 'server');

module.exports = {
  apps: [
    {
      name: 'circleftp-jellyfin',
      script: path.join(serverDir, 'dist', 'index.js'),
      cwd: serverDir,

      /**
       * Exactly one instance, in fork mode — never cluster.
       *
       * The download queue is an in-process singleton and SSE subscribers live
       * in that same process. A second worker would race the first for queued
       * jobs and would only ever push progress to the browsers connected to
       * itself, so half the tabs would sit frozen.
       */
      instances: 1,
      exec_mode: 'fork',

      // The server reads packages/server/.env itself, so nothing secret belongs
      // in this file — it is committed.
      env: {
        NODE_ENV: 'production',
      },

      // Downloads stream to disk rather than buffering, so the footprint is
      // small and steady. This is a leak guard, not a working limit.
      max_memory_restart: '512M',

      autorestart: true,
      // A crash loop should back off rather than hammer the CPU.
      restart_delay: 5000,
      exp_backoff_restart_delay: 200,
      // More than this in a short window means it is broken, not unlucky.
      max_restarts: 15,
      min_uptime: '30s',

      /**
       * Give in-flight downloads a moment to abort cleanly on stop. The app's
       * SIGTERM handler aborts transfers and closes the database; the .part
       * files stay on disk so the queue resumes from them on the next start.
       */
      kill_timeout: 20000,
      listen_timeout: 10000,
      wait_ready: false,

      // Log to pm2's own directory; journald does not see these.
      merge_logs: true,
      time: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',

      // Watching would restart the server every time a download is written into
      // the media directory. Never enable it here.
      watch: false,
    },
  ],
};
