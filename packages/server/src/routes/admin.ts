/**
 * Administration endpoints. Every route here is behind `requireAdmin`.
 */
import {
  adminCreateUserSchema,
  createInviteSchema,
  createPasswordResetSchema,
  updateUserSchema,
  type CreatedUserDto,
} from '@cfj/shared';
import { randomBytes } from 'node:crypto';
import { Router } from 'express';

import {
  deleteUser,
  getAdminUser,
  listInvites,
  listUsers,
  revokeInvite,
  revokeSessions,
  updateUser,
} from '../auth/admin.js';
import { requireAdmin } from '../auth/middleware.js';
import { createPasswordReset } from '../auth/passwordReset.js';
import { createInvite, createUser } from '../auth/users.js';
import { asyncHandler, parseBody } from '../lib/http.js';

export const adminRouter: Router = Router();

adminRouter.use('/admin', requireAdmin);

/* ------------------------------------------------------------------ users */

adminRouter.get(
  '/admin/users',
  asyncHandler(async (req, res) => {
    res.json({ users: await listUsers(req.user!.id) });
  }),
);

adminRouter.post(
  '/admin/users',
  asyncHandler(async (req, res) => {
    const input = parseBody(adminCreateUserSchema, req.body);

    // A generated password is the better default: it is strong, and it is never
    // something the admin chose and might reuse elsewhere.
    const generated = input.password ? null : randomBytes(18).toString('base64url');

    const user = await createUser({
      email: input.email,
      name: input.name,
      password: input.password ?? generated!,
      role: input.role,
    });

    const payload: CreatedUserDto = {
      user: await getAdminUser(user.id, req.user!.id),
      generatedPassword: generated,
    };
    res.status(201).json(payload);
  }),
);

adminRouter.patch(
  '/admin/users/:id',
  asyncHandler(async (req, res) => {
    const changes = parseBody(updateUserSchema, req.body);
    res.json({ user: await updateUser(String(req.params.id), changes, req.user!.id) });
  }),
);

adminRouter.delete(
  '/admin/users/:id',
  asyncHandler(async (req, res) => {
    await deleteUser(String(req.params.id), req.user!.id);
    res.json({ ok: true });
  }),
);

/** Sign an account out everywhere, without touching its password. */
adminRouter.post(
  '/admin/users/:id/revoke-sessions',
  asyncHandler(async (req, res) => {
    const endedCount = await revokeSessions(String(req.params.id));
    res.json({ ok: true, endedCount });
  }),
);

/**
 * Issue a reset link.
 *
 * The token comes back exactly once — only its hash is stored — so the client
 * must show it immediately.
 */
adminRouter.post(
  '/admin/users/:id/reset-link',
  asyncHandler(async (req, res) => {
    const { expiresInHours } = parseBody(createPasswordResetSchema, req.body ?? {});
    const reset = await createPasswordReset(String(req.params.id), req.user!.id, expiresInHours);
    res.status(201).json(reset);
  }),
);

/* ---------------------------------------------------------------- invites */

adminRouter.get(
  '/admin/invites',
  asyncHandler(async (_req, res) => {
    res.json({ invites: await listInvites() });
  }),
);

adminRouter.post(
  '/admin/invites',
  asyncHandler(async (req, res) => {
    const input = parseBody(createInviteSchema, req.body ?? {});
    const invite = await createInvite({
      role: input.role,
      expiresInDays: input.expiresInDays,
      ...(input.note ? { note: input.note } : {}),
      createdById: req.user!.id,
    });

    res.status(201).json({
      invite: {
        id: invite.id,
        code: invite.code,
        role: invite.role,
        note: invite.note,
        expiresAt: invite.expiresAt.toISOString(),
        createdAt: invite.createdAt.toISOString(),
        createdByName: req.user!.name,
        usedByName: null,
        usedAt: null,
        status: 'pending' as const,
      },
    });
  }),
);

adminRouter.delete(
  '/admin/invites/:id',
  asyncHandler(async (req, res) => {
    await revokeInvite(String(req.params.id));
    res.json({ ok: true });
  }),
);
