/** Authentication, authorisation and CSRF middleware. */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import rateLimit from 'express-rate-limit';

import { ApiError } from '../lib/errors.js';
import { resolveSession, type SessionUser } from './session.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: SessionUser;
    }
  }
}

/** Attaches `req.user` when a valid session cookie is present. Never rejects. */
export const attachUser: RequestHandler = (req, _res, next) => {
  void resolveSession(req)
    .then((user) => {
      if (user) req.user = user;
      next();
    })
    .catch(next);
};

/** Rejects with 401 unless a session is present. Assumes `attachUser` ran. */
export const requireAuth: RequestHandler = (req, _res, next) => {
  if (!req.user) {
    next(ApiError.unauthorized());
    return;
  }
  next();
};

export const requireAdmin: RequestHandler = (req, _res, next) => {
  if (!req.user) {
    next(ApiError.unauthorized());
    return;
  }
  if (req.user.role !== 'ADMIN') {
    next(ApiError.forbidden('That action is restricted to administrators'));
    return;
  }
  next();
};

/**
 * CSRF defence for a cookie-authenticated API.
 *
 * The session cookie is SameSite=Lax, which already blocks cross-site POSTs
 * from forms. This adds the second half: a custom header that a cross-origin
 * form or image cannot set, and that a fetch() from another origin can only set
 * after a CORS preflight we never answer. No CORS middleware is installed, so
 * the browser refuses the preflight and the request never arrives.
 */
export function requireSameOrigin(req: Request, _res: Response, next: NextFunction): void {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
    next();
    return;
  }
  if (req.get('x-requested-with') !== 'circleftp-jellyfin') {
    next(ApiError.forbidden('Missing request header. Reload the page and try again.'));
    return;
  }
  next();
}

/**
 * Login throttling, keyed on IP. `trust proxy` is set to 1, so this sees the
 * real client address from nginx rather than 127.0.0.1 for everyone.
 */
export const loginRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  // Only failed attempts count, so a busy legitimate user is never locked out.
  skipSuccessfulRequests: true,
  handler: (_req, _res, next) => {
    next(ApiError.tooManyRequests('Too many sign-in attempts. Try again in 15 minutes.'));
  },
});

/** Cheap guard against someone hammering the Circle FTP proxy through us. */
export const apiRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 240,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (_req, _res, next) => {
    next(ApiError.tooManyRequests());
  },
});
