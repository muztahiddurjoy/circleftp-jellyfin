/**
 * Download job lifecycle: create, read, cancel, retry, delete.
 *
 * Everything the HTTP layer and the worker both need lives here, so the two
 * never reach into each other.
 */
import type { Download, DownloadFile, Prisma } from '@prisma/client';
import type { DownloadDto, DownloadFileDto, DownloadStatus, TitleKind } from '@cfj/shared';

import { fetchPost } from '../circleftp/client.js';
import { buildPlan } from '../circleftp/plan.js';
import { kindOf } from '../circleftp/search.js';
import { bigIntToNumber, bigIntToNumberOr } from '../lib/bigint.js';
import { prisma } from '../lib/db.js';
import { ApiError } from '../lib/errors.js';
import { events } from '../lib/events.js';
import { removeDownloadFiles } from './paths.js';

type DownloadWithRelations = Download & {
  files?: DownloadFile[];
  user?: { id: string; name: string } | null;
  _count?: { files: number };
};

/** Live speed samples, keyed by job id. Not persisted — only meaningful now. */
const speedSamples = new Map<string, { bytes: number; at: number; bps: number }>();

export function recordSpeedSample(downloadId: string, downloadedBytes: number): number | null {
  const now = Date.now();
  const previous = speedSamples.get(downloadId);

  if (!previous) {
    speedSamples.set(downloadId, { bytes: downloadedBytes, at: now, bps: 0 });
    return null;
  }

  const elapsed = (now - previous.at) / 1000;
  if (elapsed < 1) return previous.bps || null;

  const delta = downloadedBytes - previous.bytes;
  const instant = delta > 0 ? delta / elapsed : 0;
  // Exponential smoothing: raw samples jump around too much to render.
  const smoothed = previous.bps > 0 ? previous.bps * 0.6 + instant * 0.4 : instant;

  speedSamples.set(downloadId, { bytes: downloadedBytes, at: now, bps: smoothed });
  return smoothed > 0 ? smoothed : null;
}

export function clearSpeedSample(downloadId: string): void {
  speedSamples.delete(downloadId);
}

function currentSpeed(downloadId: string, status: string): number | null {
  if (status !== 'RUNNING') return null;
  const sample = speedSamples.get(downloadId);
  if (!sample || sample.bps <= 0) return null;
  // A sample older than 15s means nothing is moving; do not show a stale rate.
  if (Date.now() - sample.at > 15_000) return null;
  return Math.round(sample.bps);
}

export function toDownloadFileDto(file: DownloadFile): DownloadFileDto {
  return {
    id: file.id,
    order: file.order,
    relPath: file.relPath,
    label: file.label,
    season: file.season,
    episode: file.episode,
    status: file.status as DownloadFileDto['status'],
    sizeBytes: bigIntToNumber(file.sizeBytes),
    downloadedBytes: bigIntToNumberOr(file.downloadedBytes, 0),
    attempts: file.attempts,
    error: file.error,
  };
}

export function toDownloadDto(download: DownloadWithRelations): DownloadDto {
  const totalBytes = bigIntToNumber(download.totalBytes);
  const downloadedBytes = bigIntToNumberOr(download.downloadedBytes, 0);
  const speedBps = currentSpeed(download.id, download.status);

  const files = download.files;
  const fileCount = download._count?.files ?? files?.length ?? 0;
  const completedFileCount = files?.filter((file) => file.status === 'COMPLETED').length ?? 0;

  const remaining = totalBytes !== null ? Math.max(0, totalBytes - downloadedBytes) : null;

  return {
    id: download.id,
    postId: download.postId,
    title: download.title,
    folderName: download.folderName,
    kind: download.kind as TitleKind,
    posterUrl: download.posterImage
      ? `/api/library/image/${encodeURIComponent(download.posterImage)}`
      : null,
    status: download.status as DownloadStatus,
    totalBytes,
    downloadedBytes,
    speedBps,
    etaSeconds: speedBps && remaining !== null ? Math.round(remaining / speedBps) : null,
    error: download.error,
    seasons: parseSeasons(download.seasonsJson),
    fileCount,
    completedFileCount,
    requestedBy: download.user ? { id: download.user.id, name: download.user.name } : null,
    createdAt: download.createdAt.toISOString(),
    startedAt: download.startedAt?.toISOString() ?? null,
    finishedAt: download.finishedAt?.toISOString() ?? null,
    ...(files ? { files: files.map(toDownloadFileDto) } : {}),
  };
}

function parseSeasons(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

const LIST_INCLUDE = {
  user: { select: { id: true, name: true } },
  _count: { select: { files: true } },
  files: { orderBy: { order: 'asc' } },
} satisfies Prisma.DownloadInclude;

export async function listDownloads(
  filter: 'all' | 'active' | 'done',
  limit: number,
): Promise<DownloadDto[]> {
  const where: Prisma.DownloadWhereInput =
    filter === 'active'
      ? { status: { in: ['QUEUED', 'RUNNING'] } }
      : filter === 'done'
        ? { status: { in: ['COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED'] } }
        : {};

  const rows = await prisma.download.findMany({
    where,
    // Active jobs first, then most recent.
    orderBy: [{ finishedAt: { sort: 'asc', nulls: 'first' } }, { createdAt: 'desc' }],
    take: limit,
    include: LIST_INCLUDE,
  });

  return rows.map(toDownloadDto);
}

export async function getDownload(id: string): Promise<DownloadDto> {
  const row = await prisma.download.findUnique({ where: { id }, include: LIST_INCLUDE });
  if (!row) throw ApiError.notFound('No such download');
  return toDownloadDto(row);
}

/** Emit the current state of one job to every SSE listener. */
export async function publishDownload(
  id: string,
  type: 'download:created' | 'download:progress' | 'download:finished',
): Promise<void> {
  const row = await prisma.download.findUnique({ where: { id }, include: LIST_INCLUDE });
  if (!row) return;
  events.publish({ type, download: toDownloadDto(row) });
}

export interface CreateDownloadOptions {
  postId: number;
  seasons: string[];
  userId: string;
}

export async function createDownload(options: CreateDownloadOptions): Promise<DownloadDto> {
  const { postId, seasons, userId } = options;

  // One in-flight job per title is plenty, and a second would race the first
  // for the same files on disk.
  const existing = await prisma.download.findFirst({
    where: { postId, status: { in: ['QUEUED', 'RUNNING'] } },
    select: { id: true },
  });
  if (existing) {
    throw ApiError.conflict(
      'already_queued',
      'That title is already downloading. Check the Downloads page.',
    );
  }

  const post = await fetchPost(postId);
  const plan = buildPlan(post, seasons);

  if (plan.files.length === 0) {
    throw ApiError.badRequest(
      seasons.length > 0
        ? 'No episodes matched the seasons you picked'
        : 'Circle FTP lists no downloadable files for that title',
    );
  }

  const download = await prisma.download.create({
    data: {
      postId,
      title: String(post.name ?? post.title ?? plan.folder),
      folderName: plan.folder,
      kind: kindOf(post),
      posterImage: post.image ?? null,
      status: 'QUEUED',
      seasonsJson: JSON.stringify(seasons),
      userId,
      files: {
        create: plan.files.map((file, index) => ({
          order: index,
          url: file.url,
          relPath: file.relPath,
          label: file.label,
          season: file.season,
          episode: file.episode,
          status: 'PENDING',
        })),
      },
    },
    include: LIST_INCLUDE,
  });

  const dto = toDownloadDto(download);
  events.publish({ type: 'download:created', download: dto });
  return dto;
}

export async function requestCancel(id: string): Promise<DownloadDto> {
  const download = await prisma.download.findUnique({ where: { id } });
  if (!download) throw ApiError.notFound('No such download');

  if (!['QUEUED', 'RUNNING'].includes(download.status)) {
    throw ApiError.conflict('not_active', 'That download has already finished');
  }

  if (download.status === 'QUEUED') {
    // Nothing is running it, so finish it here rather than waiting for a worker.
    await prisma.download.update({
      where: { id },
      data: { status: 'CANCELLED', cancelRequested: true, finishedAt: new Date() },
    });
    await prisma.downloadFile.updateMany({
      where: { downloadId: id, status: 'PENDING' },
      data: { status: 'CANCELLED' },
    });
  } else {
    // The worker checks this flag and aborts the in-flight request.
    await prisma.download.update({ where: { id }, data: { cancelRequested: true } });
  }

  await publishDownload(id, 'download:progress');
  return getDownload(id);
}

/** Re-queue the files that did not succeed. Completed ones are left alone. */
export async function retryDownload(id: string): Promise<DownloadDto> {
  const download = await prisma.download.findUnique({
    where: { id },
    include: { files: true },
  });
  if (!download) throw ApiError.notFound('No such download');

  if (['QUEUED', 'RUNNING'].includes(download.status)) {
    throw ApiError.conflict('already_active', 'That download is already in progress');
  }

  const retryable = download.files.filter((file) => file.status !== 'COMPLETED');
  if (retryable.length === 0) {
    throw ApiError.conflict('nothing_to_retry', 'Every file in that download already completed');
  }

  await prisma.$transaction([
    prisma.downloadFile.updateMany({
      where: { downloadId: id, status: { not: 'COMPLETED' } },
      // attempts resets so the retry gets a full budget, not the tail of the
      // previous one.
      data: { status: 'PENDING', error: null, attempts: 0 },
    }),
    prisma.download.update({
      where: { id },
      data: {
        status: 'QUEUED',
        error: null,
        cancelRequested: false,
        finishedAt: null,
        startedAt: null,
      },
    }),
  ]);

  await publishDownload(id, 'download:progress');
  return getDownload(id);
}

export async function deleteDownload(id: string, deleteFiles: boolean): Promise<void> {
  const download = await prisma.download.findUnique({
    where: { id },
    include: { files: true },
  });
  if (!download) throw ApiError.notFound('No such download');

  if (['QUEUED', 'RUNNING'].includes(download.status)) {
    throw ApiError.conflict('still_active', 'Cancel the download before deleting it');
  }

  if (deleteFiles) {
    await removeDownloadFiles(
      download.folderName,
      download.files.map((file) => file.relPath),
    );
  }

  // Files cascade via the schema relation.
  await prisma.download.delete({ where: { id } });
  clearSpeedSample(id);
  events.publish({ type: 'download:deleted', id });
}
