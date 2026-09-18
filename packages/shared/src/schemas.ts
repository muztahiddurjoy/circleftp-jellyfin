/**
 * Zod schemas for every request body / query the API accepts.
 *
 * The server validates with these; the web client imports the inferred types so
 * a shape change breaks the build on both sides at once.
 */
import { z } from 'zod';

import { TITLE_KINDS } from './enums.js';

/* -------------------------------------------------------------------------- */
/* Auth                                                                       */
/* -------------------------------------------------------------------------- */

export const emailSchema = z
  .string()
  .trim()
  .min(3)
  .max(254)
  .email('Enter a valid email address')
  .transform((value) => value.toLowerCase());

/**
 * Deliberately permissive on composition but strict on length: this is a
 * private, invite-only app, and length is the property that actually matters.
 */
export const passwordSchema = z
  .string()
  .min(10, 'Password must be at least 10 characters')
  .max(200, 'Password must be at most 200 characters');

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Password is required').max(200),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const redeemInviteSchema = z.object({
  code: z.string().trim().min(8).max(64),
  name: z.string().trim().min(1).max(80),
  email: emailSchema,
  password: passwordSchema,
});
export type RedeemInviteInput = z.infer<typeof redeemInviteSchema>;

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: passwordSchema,
});
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

/* -------------------------------------------------------------------------- */
/* Library                                                                    */
/* -------------------------------------------------------------------------- */

export const searchQuerySchema = z.object({
  q: z.string().trim().min(1, 'Enter something to search for').max(120),
  /** `any` keeps every post type; the others filter to that coarse kind. */
  kind: z.enum(['any', ...TITLE_KINDS]).default('any'),
  limit: z.coerce.number().int().min(1).max(50).default(24),
});
export type SearchQuery = z.infer<typeof searchQuerySchema>;

export const postIdSchema = z.coerce.number().int().positive();

export const titleDetailQuerySchema = z.object({
  /**
   * Season selection for series, as season names or numbers. Absent = every
   * season. Only affects the returned plan preview, not what is stored.
   */
  seasons: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform(toStringArray),
  /** HEAD every file to fill in sizes. Slower, so the client opts in. */
  probe: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});
export type TitleDetailQuery = z.infer<typeof titleDetailQuerySchema>;

/* -------------------------------------------------------------------------- */
/* Downloads                                                                  */
/* -------------------------------------------------------------------------- */

export const createDownloadSchema = z.object({
  postId: postIdSchema,
  /** Season names or numbers to include. Empty/absent = all seasons. */
  seasons: z.array(z.string().trim().min(1).max(120)).max(100).optional(),
});
export type CreateDownloadInput = z.infer<typeof createDownloadSchema>;

export const downloadListQuerySchema = z.object({
  status: z.enum(['all', 'active', 'done']).default('all'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type DownloadListQuery = z.infer<typeof downloadListQuerySchema>;

export const deleteDownloadQuerySchema = z.object({
  /** Also remove whatever landed on disk for this job. */
  deleteFiles: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});
export type DeleteDownloadQuery = z.infer<typeof deleteDownloadQuerySchema>;

/* -------------------------------------------------------------------------- */
/* Admin                                                                      */
/* -------------------------------------------------------------------------- */

export const createInviteSchema = z.object({
  role: z.enum(['ADMIN', 'USER']).default('USER'),
  /** Days until the invite expires. */
  expiresInDays: z.coerce.number().int().min(1).max(365).default(14),
  note: z.string().trim().max(200).optional(),
});
export type CreateInviteInput = z.infer<typeof createInviteSchema>;

/* -------------------------------------------------------------------------- */

/** Query params arrive as `?seasons=1&seasons=2` or `?seasons=1`; normalise both. */
function toStringArray(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  const list = Array.isArray(value) ? value : [value];
  return list
    .flatMap((entry) => entry.split(','))
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}
