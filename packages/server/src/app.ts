/** Builds the Express app. Kept free of side effects so tests can mount it. */
import path from 'node:path';

import compression from 'compression';
import cookieParser from 'cookie-parser';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';

import { apiRateLimiter, attachUser, requireSameOrigin } from './auth/middleware.js';
import { env, hasWebDist, isTest } from './env.js';
import { errorHandler, notFoundHandler } from './lib/http.js';
import { logger } from './lib/logger.js';
import { authRouter } from './routes/auth.js';
import { healthRouter } from './routes/health.js';

export function createApp(): Express {
  const app = express();

  // Behind nginx (and Cloudflare beyond it), so rate limiting and logging need
  // the forwarded client address. One hop: nginx on this host.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  if (!isTest) {
    app.use(pinoHttp({ logger, autoLogging: { ignore: (req: { url?: string }) => req.url === '/api/health' } }));
  }

  app.use(
    helmet({
      // The SPA is served from the same origin; posters are proxied through our
      // own API, so no third-party image origins need allowing.
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],
          fontSrc: ["'self'", 'data:'],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
        },
      },
      // Off: the app is served over plain HTTP on Tailscale as well as HTTPS
      // through the tunnel, and HSTS would break the former.
      hsts: false,
      crossOriginEmbedderPolicy: false,
    }),
  );
  app.use(compression());
  app.use(express.json({ limit: '256kb' }));
  app.use(cookieParser(env.SESSION_SECRET));

  app.use('/api', healthRouter);
  app.use('/api', apiRateLimiter, requireSameOrigin, attachUser, authRouter);

  if (hasWebDist()) {
    // Hashed asset filenames can be cached hard; index.html must not be.
    app.use(
      express.static(env.WEB_DIST, {
        index: false,
        maxAge: '1y',
        setHeaders: (res, filePath) => {
          if (filePath.endsWith('index.html')) res.setHeader('Cache-Control', 'no-cache');
        },
      }),
    );
  }

  app.use('/api', notFoundHandler);

  if (hasWebDist()) {
    // Client-side routing: everything not matched above renders the SPA shell.
    app.use((_req, res) => {
      res.sendFile(path.join(env.WEB_DIST, 'index.html'));
    });
  }

  app.use(errorHandler);
  return app;
}
