/**
 * Enum-like unions shared by the API and the web client.
 *
 * These deliberately mirror the string values stored by Prisma so a row can be
 * handed to the client without translation.
 */

export const USER_ROLES = ['ADMIN', 'USER'] as const;
export type UserRole = (typeof USER_ROLES)[number];

/** Coarse classification of a Circle FTP post, derived from its `type` field. */
export const TITLE_KINDS = ['movie', 'series', 'file'] as const;
export type TitleKind = (typeof TITLE_KINDS)[number];

/** Raw `type` values the Circle FTP API uses. */
export const POST_TYPES = [
  'series',
  'singleVideo',
  'multiVideo',
  'singleFile',
  'multiFile',
] as const;
export type PostType = (typeof POST_TYPES)[number];

/** How well a search result matched the query, best first. */
export const MATCH_STRENGTHS = ['exact', 'prefix', 'contains', 'title', 'weak'] as const;
export type MatchStrength = (typeof MATCH_STRENGTHS)[number];

export const DOWNLOAD_STATUSES = [
  'QUEUED',
  'RUNNING',
  'COMPLETED',
  /** Finished, but at least one file failed. */
  'PARTIAL',
  'FAILED',
  'CANCELLED',
] as const;
export type DownloadStatus = (typeof DOWNLOAD_STATUSES)[number];

export const DOWNLOAD_FILE_STATUSES = [
  'PENDING',
  'RUNNING',
  'COMPLETED',
  'FAILED',
  'SKIPPED',
  'CANCELLED',
] as const;
export type DownloadFileStatus = (typeof DOWNLOAD_FILE_STATUSES)[number];

/** Statuses that mean the job is still consuming (or waiting for) the worker. */
export const ACTIVE_DOWNLOAD_STATUSES: readonly DownloadStatus[] = ['QUEUED', 'RUNNING'];

/** Statuses that mean the job will not change again without user action. */
export const TERMINAL_DOWNLOAD_STATUSES: readonly DownloadStatus[] = [
  'COMPLETED',
  'PARTIAL',
  'FAILED',
  'CANCELLED',
];

export function isActiveStatus(status: DownloadStatus): boolean {
  return ACTIVE_DOWNLOAD_STATUSES.includes(status);
}

export function isTerminalStatus(status: DownloadStatus): boolean {
  return TERMINAL_DOWNLOAD_STATUSES.includes(status);
}
