/**
 * Your own account: change your password, rename yourself, see and end your
 * sessions. Everything here acts on the caller, never on anyone else.
 */
import { changePasswordSchema, redeemPasswordResetSchema, updateProfileSchema } from '@cfj/shared';
import { Router } from 'express';

import { loginRateLimiter, requireAuth } from '../auth/middleware.js';
import { verifyPassword } from '../auth/password.js';
import { inspectPasswordReset, redeemPasswordReset } from '../auth/passwordReset.js';
import { destroyAllSessions, issueSession } from '../auth/session.js';
import { setPassword, toUserDto } from '../auth/users.js';
import { prisma } from '../lib/db.js';
import { ApiError } from '../lib/errors.js';
import { asyncHandler, parseBody } from '../lib/http.js';

export const accountRouter: Router = Router();

accountRouter.patch(
  '/account/profile',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { name } = parseBody(updateProfileSchema, req.body);
    const user = await prisma.user.update({ where: { id: req.user!.id }, data: { name } });
    res.json({ user: toUserDto(user) });
  }),
);

/**
 * Change your own password.
 *
 * Requires the current password even though the session already proves
 * identity: it stops a walked-away-from browser being used to take the account
 * over permanently.
 */
accountRouter.post(
  '/account/password',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { currentPassword, newPassword } = parseBody(changePasswordSchema, req.body);

    const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
    if (!user) throw ApiError.unauthorized();

    if (!(await verifyPassword(currentPassword, user.passwordHash))) {
      throw ApiError.badRequest('Current password is incorrect', {
        currentPassword: ['Current password is incorrect'],
      });
    }
    if (currentPassword === newPassword) {
      throw ApiError.badRequest('That is already your password', {
        newPassword: ['Choose a password you are not already using'],
      });
    }

    await setPassword(user.id, newPassword);
    // Sign every device out, then re-issue for this one, so a changed password
    // actually evicts whoever else was signed in.
    await destroyAllSessions(user.id);
    await issueSession(res, req, user.id);

    res.json({ ok: true });
  }),
);

/** Your open sessions, so you can see whether anyone else is signed in. */
accountRouter.get(
  '/account/sessions',
  requireAuth,
  asyncHandler(async (req, res) => {
    const sessions = await prisma.session.findMany({
      where: { userId: req.user!.id },
      orderBy: { createdAt: 'desc' },
      select: { id: true, userAgent: true, ip: true, createdAt: true, expiresAt: true },
    });

    res.json({
      sessions: sessions.map((session) => ({
        id: session.id,
        userAgent: session.userAgent,
        ip: session.ip,
        createdAt: session.createdAt.toISOString(),
        expiresAt: session.expiresAt.toISOString(),
      })),
    });
  }),
);

/** Sign out everywhere else, keeping this device signed in. */
accountRouter.post(
  '/account/sessions/revoke-others',
  requireAuth,
  asyncHandler(async (req, res) => {
    const before = await prisma.session.count({ where: { userId: req.user!.id } });
    await destroyAllSessions(req.user!.id);
    await issueSession(res, req, req.user!.id);

    res.json({ ok: true, endedCount: Math.max(0, before - 1) });
  }),
);

/* -------------------------------------------------------------------------- */
/* Reset links — unauthenticated: the token is the credential                  */
/* -------------------------------------------------------------------------- */

/** Check a link before showing the form, so a dead link says why. */
accountRouter.get(
  '/account/reset/check',
  asyncHandler(async (req, res) => {
    const token = typeof req.query.token === 'string' ? req.query.token : '';
    if (!token) throw ApiError.badRequest('No reset token supplied');

    res.json(await inspectPasswordReset(token));
  }),
);

accountRouter.post(
  '/account/reset',
  // Throttled like a login: this endpoint accepts a bearer-style secret.
  loginRateLimiter,
  asyncHandler(async (req, res) => {
    const { token, newPassword } = parseBody(redeemPasswordResetSchema, req.body);

    const userId = await redeemPasswordReset(token, newPassword);
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw ApiError.internal();

    // Sign them straight in — they have just proven control of the link and
    // chosen a password, so a login form here would be pure friction.
    await issueSession(res, req, user.id);
    res.json({ user: toUserDto(user) });
  }),
);
