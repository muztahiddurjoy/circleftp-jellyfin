import { Router } from 'express';

import { env } from '../env.js';

export const healthRouter: Router = Router();

/** Liveness probe. Deliberately unauthenticated and free of DB access. */
healthRouter.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'circleftp-jellyfin',
    version: process.env.npm_package_version ?? '0.1.0',
    env: env.NODE_ENV,
    uptimeSeconds: Math.round(process.uptime()),
  });
});
