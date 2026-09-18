/**
 * Admin-issued password reset links.
 *
 * There is no mail server here, so nothing can be emailed to the user. An admin
 * generates a one-time link and passes it on by whatever channel they like. The
 * important property is preserved: the admin never learns the resulting
 * password, and the link is single-use and time-limited.
 */
import { createHash, randomBytes } from 'node:crypto';

import type { PasswordResetDto } from '@cfj/shared';

import { prisma } from '../lib/db.js';
import { ApiError } from '../lib/errors.js';
import { hashPassword } from './password.js';

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Issue a link for `userId`.
 *
 * Any previously issued, still-unused link for that user is invalidated first,
 * so an admin clicking twice does not leave two working links in the wild.
 */
export async function createPasswordReset(
  userId: string,
  issuedById: string | null,
  expiresInHours: number,
): Promise<PasswordResetDto> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw ApiError.notFound('No such user');

  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + expiresInHours * 60 * 60 * 1000);

  const reset = await prisma.$transaction(async (tx) => {
    await tx.passwordReset.deleteMany({ where: { userId, usedAt: null } });
    return tx.passwordReset.create({
      data: { tokenHash: hashToken(token), userId, issuedById, expiresAt },
    });
  });

  return {
    id: reset.id,
    userId: user.id,
    userName: user.name,
    userEmail: user.email,
    // Relative on purpose: the server does not reliably know its own public
    // origin behind nginx and a tunnel, and the UI can resolve this itself.
    url: `/reset?token=${encodeURIComponent(token)}`,
    expiresAt: expiresAt.toISOString(),
  };
}

export interface ResetTokenCheck {
  valid: boolean;
  reason?: string;
  userName?: string;
  userEmail?: string;
}

/** Look a token up without spending it, so the page can render sensibly. */
export async function inspectPasswordReset(token: string): Promise<ResetTokenCheck> {
  const reset = await prisma.passwordReset.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: true },
  });

  if (!reset) return { valid: false, reason: 'That reset link is not valid.' };
  if (reset.usedAt) return { valid: false, reason: 'That reset link has already been used.' };
  if (reset.expiresAt.getTime() <= Date.now()) {
    return { valid: false, reason: 'That reset link has expired.' };
  }
  if (reset.user.disabled) return { valid: false, reason: 'That account is disabled.' };

  return { valid: true, userName: reset.user.name, userEmail: reset.user.email };
}

/**
 * Spend a token and set the new password.
 *
 * Runs as one transaction with a conditional claim, so two requests racing on
 * the same link cannot both succeed. Every existing session for the account is
 * dropped: a reset is exactly the moment you want other devices signed out.
 */
export async function redeemPasswordReset(token: string, newPassword: string): Promise<string> {
  const passwordHash = await hashPassword(newPassword);

  return prisma.$transaction(async (tx) => {
    const reset = await tx.passwordReset.findUnique({
      where: { tokenHash: hashToken(token) },
      include: { user: true },
    });

    if (!reset) throw ApiError.badRequest('That reset link is not valid');
    if (reset.usedAt) throw ApiError.badRequest('That reset link has already been used');
    if (reset.expiresAt.getTime() <= Date.now()) {
      throw ApiError.badRequest('That reset link has expired');
    }
    if (reset.user.disabled) throw ApiError.forbidden('That account is disabled');

    const claimed = await tx.passwordReset.updateMany({
      where: { id: reset.id, usedAt: null },
      data: { usedAt: new Date() },
    });
    if (claimed.count === 0) {
      throw ApiError.conflict('reset_used', 'That reset link has already been used');
    }

    await tx.user.update({ where: { id: reset.userId }, data: { passwordHash } });
    await tx.session.deleteMany({ where: { userId: reset.userId } });

    return reset.userId;
  });
}

/** Housekeeping, run alongside session pruning at boot. */
export async function pruneExpiredResets(): Promise<number> {
  const { count } = await prisma.passwordReset.deleteMany({
    where: { OR: [{ expiresAt: { lte: new Date() } }, { usedAt: { not: null } }] },
  });
  return count;
}
