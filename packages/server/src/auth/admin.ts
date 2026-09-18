/**
 * Administration: user and invite management.
 *
 * The rules here exist to stop an admin locking everyone out of the app. There
 * is no password-reset-by-email and no console recovery, so "the last admin
 * demoted themselves" would mean editing SQLite by hand.
 */
import type { AdminUserDto, InviteDto, UserRole } from '@cfj/shared';
import type { Prisma } from '@prisma/client';

import { prisma } from '../lib/db.js';
import { ApiError } from '../lib/errors.js';

const USER_INCLUDE = {
  _count: { select: { downloads: true, sessions: true } },
  sessions: { orderBy: { createdAt: 'desc' }, take: 1, select: { createdAt: true } },
} satisfies Prisma.UserInclude;

type UserWithCounts = Prisma.UserGetPayload<{ include: typeof USER_INCLUDE }>;

function toAdminUserDto(user: UserWithCounts, currentUserId: string): AdminUserDto {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role as UserRole,
    createdAt: user.createdAt.toISOString(),
    disabled: user.disabled,
    downloadCount: user._count.downloads,
    sessionCount: user._count.sessions,
    lastSeenAt: user.sessions[0]?.createdAt.toISOString() ?? null,
    isSelf: user.id === currentUserId,
  };
}

export async function listUsers(currentUserId: string): Promise<AdminUserDto[]> {
  const users = await prisma.user.findMany({
    orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
    include: USER_INCLUDE,
  });
  return users.map((user) => toAdminUserDto(user, currentUserId));
}

export async function getAdminUser(id: string, currentUserId: string): Promise<AdminUserDto> {
  const user = await prisma.user.findUnique({ where: { id }, include: USER_INCLUDE });
  if (!user) throw ApiError.notFound('No such user');
  return toAdminUserDto(user, currentUserId);
}

/** How many enabled admins exist, optionally ignoring one account. */
async function activeAdminCount(exceptUserId?: string): Promise<number> {
  return prisma.user.count({
    where: {
      role: 'ADMIN',
      disabled: false,
      ...(exceptUserId ? { id: { not: exceptUserId } } : {}),
    },
  });
}

/**
 * Refuse a change that would leave the app with no way in.
 *
 * Called before demoting, disabling or deleting an admin.
 */
async function assertNotLastAdmin(userId: string, action: string): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user || user.role !== 'ADMIN' || user.disabled) return;

  if ((await activeAdminCount(userId)) === 0) {
    throw ApiError.conflict(
      'last_admin',
      `This is the only active administrator — ${action} would lock everyone out. ` +
        'Promote another account to administrator first.',
    );
  }
}

export interface UpdateUserOptions {
  name?: string;
  role?: UserRole;
  disabled?: boolean;
}

export async function updateUser(
  id: string,
  changes: UpdateUserOptions,
  currentUserId: string,
): Promise<AdminUserDto> {
  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) throw ApiError.notFound('No such user');

  if (changes.role === 'USER' && user.role === 'ADMIN') {
    await assertNotLastAdmin(id, 'demoting them');
  }
  if (changes.disabled === true) {
    if (id === currentUserId) {
      throw ApiError.badRequest('You cannot disable your own account');
    }
    await assertNotLastAdmin(id, 'disabling them');
  }

  await prisma.user.update({
    where: { id },
    data: {
      ...(changes.name !== undefined ? { name: changes.name } : {}),
      ...(changes.role !== undefined ? { role: changes.role } : {}),
      ...(changes.disabled !== undefined ? { disabled: changes.disabled } : {}),
    },
  });

  // A disabled account must not keep working from an already-open tab.
  if (changes.disabled === true) {
    await prisma.session.deleteMany({ where: { userId: id } });
  }

  return getAdminUser(id, currentUserId);
}

export async function deleteUser(id: string, currentUserId: string): Promise<void> {
  if (id === currentUserId) {
    throw ApiError.badRequest('You cannot delete your own account');
  }
  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) throw ApiError.notFound('No such user');

  await assertNotLastAdmin(id, 'deleting them');

  // Downloads survive with userId set to null (onDelete: SetNull), so the
  // history of what was fetched is not lost with the account.
  await prisma.user.delete({ where: { id } });
}

/** Sign an account out everywhere without changing its password. */
export async function revokeSessions(id: string): Promise<number> {
  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) throw ApiError.notFound('No such user');

  const { count } = await prisma.session.deleteMany({ where: { userId: id } });
  return count;
}

/* -------------------------------------------------------------------------- */
/* Invites                                                                    */
/* -------------------------------------------------------------------------- */

type InviteWithRelations = Prisma.InviteGetPayload<{
  include: { createdBy: true; usedBy: true };
}>;

function toInviteDto(invite: InviteWithRelations): InviteDto {
  const status: InviteDto['status'] = invite.usedById
    ? 'used'
    : invite.expiresAt.getTime() <= Date.now()
      ? 'expired'
      : 'pending';

  return {
    id: invite.id,
    code: invite.code,
    role: invite.role as UserRole,
    note: invite.note,
    expiresAt: invite.expiresAt.toISOString(),
    createdAt: invite.createdAt.toISOString(),
    createdByName: invite.createdBy?.name ?? null,
    usedByName: invite.usedBy?.name ?? null,
    usedAt: invite.usedAt?.toISOString() ?? null,
    status,
  };
}

export async function listInvites(): Promise<InviteDto[]> {
  const invites = await prisma.invite.findMany({
    orderBy: { createdAt: 'desc' },
    take: 100,
    include: { createdBy: true, usedBy: true },
  });
  return invites.map(toInviteDto);
}

export async function revokeInvite(id: string): Promise<void> {
  const invite = await prisma.invite.findUnique({ where: { id } });
  if (!invite) throw ApiError.notFound('No such invite');

  if (invite.usedById) {
    // Deleting a spent invite would erase the record of how an account was
    // created, which is the more useful thing to keep.
    throw ApiError.conflict('invite_used', 'That invite has already been redeemed');
  }

  await prisma.invite.delete({ where: { id } });
}
