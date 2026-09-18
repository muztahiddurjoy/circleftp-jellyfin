/** User and invite operations shared by the HTTP routes and the admin CLI. */
import { randomBytes } from 'node:crypto';

import type { User } from '@prisma/client';
import type { UserDto, UserRole } from '@cfj/shared';

import { prisma } from '../lib/db.js';
import { ApiError } from '../lib/errors.js';
import { hashPassword } from './password.js';

export function toUserDto(user: User): UserDto {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role as UserRole,
    createdAt: user.createdAt.toISOString(),
  };
}

export interface CreateUserOptions {
  email: string;
  name: string;
  password: string;
  role?: UserRole;
}

export async function createUser(options: CreateUserOptions): Promise<User> {
  const email = options.email.trim().toLowerCase();
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    throw ApiError.conflict('email_taken', 'An account with that email already exists');
  }
  return prisma.user.create({
    data: {
      email,
      name: options.name.trim(),
      passwordHash: await hashPassword(options.password),
      role: options.role ?? 'USER',
    },
  });
}

export async function setPassword(userId: string, password: string): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: { passwordHash: await hashPassword(password) },
  });
}

/**
 * Invite codes are 24 base32-ish characters from a 15-byte random source —
 * enough entropy that guessing is not a threat, short enough to retype.
 */
export function generateInviteCode(): string {
  return randomBytes(15).toString('base64url').replace(/[-_]/g, '').slice(0, 24).toUpperCase();
}

export interface CreateInviteOptions {
  role?: UserRole;
  expiresInDays?: number;
  note?: string;
  createdById?: string | null;
}

export async function createInvite(options: CreateInviteOptions = {}) {
  const expiresInDays = options.expiresInDays ?? 14;
  return prisma.invite.create({
    data: {
      code: generateInviteCode(),
      role: options.role ?? 'USER',
      note: options.note ?? null,
      createdById: options.createdById ?? null,
      expiresAt: new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000),
    },
  });
}

/**
 * Redeem an invite and create its account in one transaction, so two people
 * racing on the same code cannot both end up with an account.
 */
export async function redeemInvite(input: {
  code: string;
  name: string;
  email: string;
  password: string;
}): Promise<User> {
  const code = input.code.trim().toUpperCase();
  const email = input.email.trim().toLowerCase();
  const passwordHash = await hashPassword(input.password);

  return prisma.$transaction(async (tx) => {
    const invite = await tx.invite.findUnique({ where: { code } });
    if (!invite) throw ApiError.badRequest('That invite code is not valid');
    if (invite.usedById) throw ApiError.badRequest('That invite code has already been used');
    if (invite.expiresAt.getTime() <= Date.now()) {
      throw ApiError.badRequest('That invite code has expired');
    }

    const existing = await tx.user.findUnique({ where: { email } });
    if (existing) {
      throw ApiError.conflict('email_taken', 'An account with that email already exists');
    }

    const user = await tx.user.create({
      data: { email, name: input.name.trim(), passwordHash, role: invite.role },
    });

    // Conditional update: if another request redeemed the code between the read
    // above and here, this matches zero rows and the transaction is rolled back.
    const claimed = await tx.invite.updateMany({
      where: { id: invite.id, usedById: null },
      data: { usedById: user.id, usedAt: new Date() },
    });
    if (claimed.count === 0) {
      throw ApiError.conflict('invite_used', 'That invite code has already been used');
    }

    return user;
  });
}
