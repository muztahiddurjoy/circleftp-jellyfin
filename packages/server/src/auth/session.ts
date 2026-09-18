/**
 * Session issuing and verification.
 *
 * The cookie carries a random 32-byte token; the database stores only its
 * SHA-256. Verification hashes the presented token and looks that up, so the
 * table is useless to anyone who steals it.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import type { Request, Response } from 'express';

import { env } from '../env.js';
import { prisma } from '../lib/db.js';

export const SESSION_COOKIE = 'cfj_session';

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: string;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function ttlMs(): number {
  return env.SESSION_TTL_DAYS * 24 * 60 * 60 * 1000;
}

/** Create a session row and set the cookie. Returns the expiry for the client. */
export async function issueSession(
  res: Response,
  req: Request,
  userId: string,
): Promise<Date> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + ttlMs());

  await prisma.session.create({
    data: {
      tokenHash: hashToken(token),
      userId,
      expiresAt,
      userAgent: req.get('user-agent')?.slice(0, 255) ?? null,
      ip: req.ip ?? null,
    },
  });

  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    // Lax, not Strict: a link into the app from elsewhere should land logged in.
    // Combined with the X-Requested-With check this still blocks cross-site writes.
    sameSite: 'lax',
    secure: env.COOKIE_SECURE,
    signed: true,
    path: '/',
    maxAge: ttlMs(),
  });

  return expiresAt;
}

/** Look up the signed-in user for a request, or null. Expired rows are pruned. */
export async function resolveSession(req: Request): Promise<SessionUser | null> {
  const token = req.signedCookies?.[SESSION_COOKIE];
  if (typeof token !== 'string' || token.length === 0) return null;

  const session = await prisma.session.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: true },
  });
  if (!session) return null;

  if (session.expiresAt.getTime() <= Date.now()) {
    await prisma.session.delete({ where: { id: session.id } }).catch(() => undefined);
    return null;
  }
  if (session.user.disabled) return null;

  return {
    id: session.user.id,
    email: session.user.email,
    name: session.user.name,
    role: session.user.role,
  };
}

/** Drop the caller's session row and clear the cookie. */
export async function destroySession(req: Request, res: Response): Promise<void> {
  const token = req.signedCookies?.[SESSION_COOKIE];
  if (typeof token === 'string' && token.length > 0) {
    await prisma.session
      .deleteMany({ where: { tokenHash: hashToken(token) } })
      .catch(() => undefined);
  }
  res.clearCookie(SESSION_COOKIE, { path: '/' });
}

/** Sign every device out — used after a password change. */
export async function destroyAllSessions(userId: string): Promise<void> {
  await prisma.session.deleteMany({ where: { userId } });
}

/** Housekeeping, run on boot and daily. */
export async function pruneExpiredSessions(): Promise<number> {
  const { count } = await prisma.session.deleteMany({
    where: { expiresAt: { lte: new Date() } },
  });
  return count;
}

/** Constant-time compare for the few places that compare secrets directly. */
export function safeEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}
