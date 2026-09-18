/**
 * Response shapes returned by the API.
 *
 * Every field the web client renders is declared here, so a server-side change
 * that drops a field fails the web build rather than the page.
 */
import type {
  DownloadFileStatus,
  DownloadStatus,
  MatchStrength,
  PostType,
  TitleKind,
  UserRole,
} from './enums.js';

export interface UserDto {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  createdAt: string;
}

export interface SessionDto {
  user: UserDto;
  expiresAt: string;
}

/** One row in the search results grid. */
export interface SearchResultDto {
  postId: number;
  name: string;
  title: string;
  year: string | null;
  quality: string;
  kind: TitleKind;
  type: PostType | string;
  category: string;
  /** Runtime as Circle FTP reports it, e.g. "2h 28m". */
  watchTime: string | null;
  /** Path on our own API — never a Circle FTP URL, to avoid mixed content. */
  posterUrl: string | null;
  match: MatchStrength;
  /** Series only, filled in by the detail enrichment pass. */
  seasonCount?: number;
  episodeCount?: number;
  seasonNames?: string[];
}

/** A season of a series, as offered to the user for selection. */
export interface SeasonSummaryDto {
  /** Raw season name from the API, e.g. "Season 1". This is the selection key. */
  name: string;
  /** Parsed number, when one could be read out of the name. */
  number: number | null;
  episodeCount: number;
}

/** One file the server would download, with the path it would land at. */
export interface PlannedFileDto {
  /** Path relative to the title's folder, e.g. "Season 01/Show S01E02 - x.mkv". */
  relPath: string;
  label: string;
  season: string | null;
  episode: number | null;
  /** Bytes, when probing was requested and the host answered. */
  size: number | null;
}

/** Everything the title page needs. */
export interface TitleDetailDto {
  postId: number;
  name: string;
  title: string;
  year: string | null;
  quality: string;
  kind: TitleKind;
  type: PostType | string;
  category: string;
  watchTime: string | null;
  description: string | null;
  posterUrl: string | null;
  /** Destination folder name, e.g. "Inception (2010)". */
  folderName: string;
  seasons: SeasonSummaryDto[];
  files: PlannedFileDto[];
  /** Sum of known file sizes; null when nothing was probed. */
  totalSize: number | null;
  /** True when an unfinished job for this post already exists. */
  alreadyQueued: boolean;
  /** Id of that job, when `alreadyQueued`. */
  activeDownloadId: string | null;
}

export interface DownloadFileDto {
  id: string;
  order: number;
  relPath: string;
  label: string;
  season: string | null;
  episode: number | null;
  status: DownloadFileStatus;
  sizeBytes: number | null;
  downloadedBytes: number;
  attempts: number;
  error: string | null;
}

export interface DownloadDto {
  id: string;
  postId: number;
  title: string;
  folderName: string;
  kind: TitleKind;
  posterUrl: string | null;
  status: DownloadStatus;
  totalBytes: number | null;
  downloadedBytes: number;
  /** Bytes/second over the last sampling window; only while RUNNING. */
  speedBps: number | null;
  /** Seconds remaining, when both speed and total are known. */
  etaSeconds: number | null;
  error: string | null;
  seasons: string[];
  fileCount: number;
  completedFileCount: number;
  requestedBy: { id: string; name: string } | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  files?: DownloadFileDto[];
}

/* -------------------------------------------------------------------------- */
/* Server-sent events                                                         */
/* -------------------------------------------------------------------------- */

export type ServerEvent =
  /** Sent on connect so a fresh client has the full picture without polling. */
  | { type: 'snapshot'; downloads: DownloadDto[] }
  | { type: 'download:created'; download: DownloadDto }
  | { type: 'download:progress'; download: DownloadDto }
  | { type: 'download:finished'; download: DownloadDto }
  | { type: 'download:deleted'; id: string }
  | { type: 'heartbeat'; at: string };

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

export interface ApiErrorDto {
  error: {
    /** Stable, machine-readable code, e.g. "invalid_credentials". */
    code: string;
    message: string;
    /** Field-level messages from zod, when the failure was validation. */
    details?: Record<string, string[]>;
  };
}
