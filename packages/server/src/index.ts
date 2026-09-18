/** Process entry point: start the HTTP server and shut down cleanly. */
import { createApp } from './app.js';
import { env } from './env.js';
import { configureSqlite, disconnect } from './lib/db.js';
import { logger } from './lib/logger.js';

await configureSqlite();

const app = createApp();

const server = app.listen(env.PORT, env.HOST, () => {
  logger.info({ host: env.HOST, port: env.PORT, env: env.NODE_ENV }, 'circleftp-jellyfin listening');
});

// Long-lived SSE connections mean the default (infinite) would hang a restart.
server.headersTimeout = 0;
server.requestTimeout = 0;

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Shutting down');

  server.close(() => {
    void disconnect().finally(() => {
      logger.info('HTTP server closed');
      process.exit(0);
    });
  });

  // Don't let a stuck connection hold the restart hostage.
  setTimeout(() => {
    logger.warn('Forced exit after shutdown timeout');
    process.exit(1);
  }, 15_000).unref();
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'Unhandled promise rejection');
});
