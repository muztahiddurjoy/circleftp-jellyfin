import { changePasswordSchema, loginSchema, redeemInviteSchema } from '@cfj/shared';
import { Router } from 'express';

import { loginRateLimiter, requireAuth } from '../auth/middleware.js';
import { fakeVerify, verifyPassword } from '../auth/password.js';
import { destroyAllSessions, destroySession, issueSession } from '../auth/session.js';
import { redeemInvite, setPassword, toUserDto } from '../auth/users.js';
import { prisma } from '../lib/db.js';
import { ApiError } from '../lib/errors.js';
import { asyncHandler, parseBody } from '../lib/http.js';

export const authRouter: Router = Router();

authRouter.post(
  '/auth/login',
  loginRateLimiter,
  asyncHandler(async (req, res) => {
    const { email, password } = parseBody(loginSchema, req.body);

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      // Spend the same time as a real check so timing does not reveal which
      // addresses have accounts.
      await fakeVerify();
      throw new ApiError(401, 'invalid_credentials', 'Email or password is incorrect');
    }
    if (!(await verifyPassword(password, user.passwordHash))) {
      throw new ApiError(401, 'invalid_credentials', 'Email or password is incorrect');
    }
    if (user.disabled) {
      throw ApiError.forbidden('That account has been disabled');
    }

    const expiresAt = await issueSession(res, req, user.id);
    res.json({ user: toUserDto(user), expiresAt: expiresAt.toISOString() });
  }),
);

authRouter.post(
  '/auth/logout',
  asyncHandler(async (req, res) => {
    await destroySession(req, res);
    res.json({ ok: true });
  }),
);

/** The client calls this on load to decide between the app and the login page. */
authRouter.get(
  '/auth/me',
  asyncHandler(async (req, res) => {
    if (!req.user) throw ApiError.unauthorized('Not signed in');
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user) throw ApiError.unauthorized('Not signed in');
    res.json({ user: toUserDto(user) });
  }),
);

/** Invite redemption is the only way to create an account over HTTP. */
authRouter.post(
  '/auth/redeem',
  loginRateLimiter,
  asyncHandler(async (req, res) => {
    const input = parseBody(redeemInviteSchema, req.body);
    const user = await redeemInvite(input);
    const expiresAt = await issueSession(res, req, user.id);
    res.status(201).json({ user: toUserDto(user), expiresAt: expiresAt.toISOString() });
  }),
);

authRouter.post(
  '/auth/password',
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

    await setPassword(user.id, newPassword);
    // Everything else is signed out, then this device is signed back in.
    await destroyAllSessions(user.id);
    await issueSession(res, req, user.id);
    res.json({ ok: true });
  }),
);
