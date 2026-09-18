/**
 * Server-Sent Events stream for live download progress.
 *
 * SSE rather than WebSockets: the traffic is one-directional, it survives an
 * nginx reverse proxy without an upgrade dance, and the browser reconnects on
 * its own.
 */
import type { ServerEvent } from '@cfj/shared';
import { Router } from 'express';

import { requireAuth } from '../auth/middleware.js';
import { listDownloads } from '../downloads/service.js';
import { events } from '../lib/events.js';
import { asyncHandler } from '../lib/http.js';

export const eventsRouter: Router = Router();

/** Long enough to keep proxies from idling the connection out. */
const HEARTBEAT_MS = 25_000;

eventsRouter.get(
  '/events',
  requireAuth,
  asyncHandler(async (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // nginx buffers proxied responses by default, which would hold every
      // event until the buffer filled. This disables that for the stream.
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();

    const send = (event: ServerEvent): void => {
      if (res.writableEnded) return;
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    // Tell the browser to wait 3s before reconnecting after a drop.
    res.write('retry: 3000\n\n');

    // A fresh client gets the full picture up front, so it never has to poll.
    send({ type: 'snapshot', downloads: await listDownloads('all', 50) });

    const unsubscribe = events.subscribe(send);

    const heartbeat = setInterval(() => {
      if (res.writableEnded) return;
      // A comment line keeps the socket warm without reaching the client's
      // message handler.
      res.write(': keep-alive\n\n');
    }, HEARTBEAT_MS);

    const cleanup = (): void => {
      clearInterval(heartbeat);
      unsubscribe();
    };

    req.on('close', cleanup);
    res.on('close', cleanup);
    res.on('error', cleanup);
  }),
);
