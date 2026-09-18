/**
 * The download worker.
 *
 * A single in-process queue, because the server is long-lived and SSE progress
 * would otherwise need IPC. Concurrency defaults to 1 deliberately: Circle FTP
 * hosts deliver ~9-10 MB/s on one stream and get *slower* when split, a finding
 * carried over from the Hermes plugin.
 */
import path from 'node:path';

import type { DownloadFile } from '@prisma/client';

import { probeSize } from '../circleftp/probe.js';
import { env } from '../env.js';
import { toBigInt, toBigIntOrZero } from '../lib/bigint.js';
import { prisma } from '../lib/db.js';
import { logger } from '../lib/logger.js';
import { DownloadCancelledError, fetchFile } from './fetcher.js';
import { checkSpace, resolveDestination } from './paths.js';
import { runPostProcessing } from './postProcess.js';
import { clearSpeedSample, publishDownload, recordSpeedSample } from './service.js';

/** Progress is persisted at most this often, to keep SQLite writes sane. */
const PROGRESS_WRITE_INTERVAL_MS = 1_500;

class DownloadQueue {
  private running = 0;
  private draining = false;
  private stopped = false;
  /** Abort handles for in-flight jobs, so a cancel can interrupt mid-transfer. */
  private readonly aborts = new Map<string, AbortController>();
  /**
   * Chain of in-flight progress writes per job.
   *
   * Progress writes are fire-and-forget so a slow database cannot stall a
   * transfer, but a stale one landing after the job's final totals would
   * overwrite them with a mid-flight snapshot. Chaining lets `finishJob` wait
   * for them to settle before it computes the totals that stick.
   */
  private readonly progressWrites = new Map<string, Promise<void>>();

  /**
   * Requeue anything the previous process was mid-way through.
   *
   * A RUNNING row means the process died holding it. The `.part` files are
   * still on disk, so the retry resumes rather than starting over.
   */
  async recoverFromCrash(): Promise<void> {
    const { count } = await prisma.download.updateMany({
      where: { status: 'RUNNING' },
      data: { status: 'QUEUED', startedAt: null },
    });
    const files = await prisma.downloadFile.updateMany({
      where: { status: 'RUNNING' },
      data: { status: 'PENDING' },
    });
    if (count > 0 || files.count > 0) {
      logger.warn({ jobs: count, files: files.count }, 'Requeued downloads interrupted by a restart');
    }
  }

  /** Kick the queue. Safe to call whenever a job might have become runnable. */
  wake(): void {
    if (this.stopped) return;
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (!this.stopped && this.running < env.DOWNLOAD_CONCURRENCY) {
        const next = await prisma.download.findFirst({
          where: { status: 'QUEUED' },
          orderBy: { createdAt: 'asc' },
          select: { id: true },
        });
        if (!next) break;

        // Claim it conditionally: with concurrency > 1 two drains could
        // otherwise pick the same row.
        const claimed = await prisma.download.updateMany({
          where: { id: next.id, status: 'QUEUED' },
          data: { status: 'RUNNING', startedAt: new Date() },
        });
        if (claimed.count === 0) continue;

        this.running += 1;
        void this.runJob(next.id).finally(() => {
          this.running -= 1;
          // Another job may be waiting on the slot just freed.
          setImmediate(() => this.wake());
        });
      }
    } catch (error) {
      logger.error({ err: error }, 'Download queue drain failed');
    } finally {
      this.draining = false;
    }
  }

  private async runJob(downloadId: string): Promise<void> {
    const controller = new AbortController();
    this.aborts.set(downloadId, controller);

    try {
      await this.processJob(downloadId, controller);
    } catch (error) {
      logger.error({ err: error, downloadId }, 'Download job failed unexpectedly');
      await prisma.download
        .update({
          where: { id: downloadId },
          data: {
            status: 'FAILED',
            error: error instanceof Error ? error.message : 'Unknown error',
            finishedAt: new Date(),
          },
        })
        .catch(() => undefined);
      await publishDownload(downloadId, 'download:finished').catch(() => undefined);
    } finally {
      this.aborts.delete(downloadId);
      this.progressWrites.delete(downloadId);
      clearSpeedSample(downloadId);
    }
  }

  private async processJob(downloadId: string, controller: AbortController): Promise<void> {
    const download = await prisma.download.findUnique({
      where: { id: downloadId },
      include: { files: { orderBy: { order: 'asc' } } },
    });
    if (!download) return;

    logger.info(
      { downloadId, title: download.title, files: download.files.length },
      'Starting download',
    );
    await publishDownload(downloadId, 'download:progress');

    let cancelled = false;

    for (const file of download.files) {
      if (file.status === 'COMPLETED') continue;

      if (await this.isCancelled(downloadId)) {
        cancelled = true;
        break;
      }

      const outcome = await this.processFile(download.folderName, file, controller, downloadId);
      if (outcome === 'cancelled') {
        cancelled = true;
        break;
      }
    }

    await this.finishJob(downloadId, cancelled);
  }

  private async processFile(
    folderName: string,
    file: DownloadFile,
    controller: AbortController,
    downloadId: string,
  ): Promise<'done' | 'failed' | 'cancelled'> {
    let destination: string;
    try {
      destination = resolveDestination(folderName, file.relPath);
    } catch (error) {
      await this.markFileFailed(file.id, error instanceof Error ? error.message : 'Invalid path');
      return 'failed';
    }

    // Probe first: the size is both the space check and the progress denominator.
    const probed = file.sizeBytes ?? (await this.probeAndStore(file));

    const space = await checkSpace(probed !== null ? Number(probed) : null);
    if (!space.ok) {
      const message = `Not enough disk space (${formatGib(space.free)} free, needs ${formatGib(space.required)})`;
      await this.markFileFailed(file.id, message);
      logger.error({ downloadId, file: file.relPath }, message);
      return 'failed';
    }

    await prisma.downloadFile.update({
      where: { id: file.id },
      data: { status: 'RUNNING', attempts: { increment: 1 }, error: null },
    });

    let lastWrite = 0;

    try {
      const result = await fetchFile({
        url: file.url,
        destination,
        expectedSize: probed !== null ? Number(probed) : null,
        signal: controller.signal,
        onProgress: (bytesOnDisk, totalBytes) => {
          const now = Date.now();
          if (now - lastWrite < PROGRESS_WRITE_INTERVAL_MS) return;
          lastWrite = now;
          this.queueProgressWrite(downloadId, file.id, bytesOnDisk, totalBytes);
        },
      });

      await prisma.downloadFile.update({
        where: { id: file.id },
        data: {
          status: 'COMPLETED',
          downloadedBytes: toBigIntOrZero(result.bytes),
          sizeBytes: toBigInt(result.bytes),
          finishedAt: new Date(),
          error: null,
        },
      });
      await this.recomputeTotals(downloadId);
      await publishDownload(downloadId, 'download:progress');

      logger.info(
        { downloadId, file: file.relPath, bytes: result.bytes, skipped: result.skipped },
        'File complete',
      );
      return 'done';
    } catch (error) {
      if (error instanceof DownloadCancelledError || controller.signal.aborted) {
        await prisma.downloadFile.update({
          where: { id: file.id },
          data: { status: 'CANCELLED' },
        });
        return 'cancelled';
      }

      const message = error instanceof Error ? error.message : 'Download failed';
      const attempts = file.attempts + 1;

      if (attempts < env.DOWNLOAD_MAX_ATTEMPTS) {
        // Back to PENDING: the outer loop moves on, and a later retry resumes
        // from the .part file this attempt left behind.
        await prisma.downloadFile.update({
          where: { id: file.id },
          data: { status: 'PENDING', error: message },
        });
        logger.warn(
          { downloadId, file: file.relPath, attempts, err: message },
          'File attempt failed, will retry',
        );
        // Linear backoff, capped, so a flapping host is not hammered.
        await delay(Math.min(attempts * 2_000, 15_000));
        return this.processFile(folderName, { ...file, attempts }, controller, downloadId);
      }

      await this.markFileFailed(file.id, message);
      logger.error({ downloadId, file: file.relPath, err: message }, 'File failed permanently');
      return 'failed';
    }
  }

  private async probeAndStore(file: DownloadFile): Promise<bigint | null> {
    const result = await probeSize(file.url);
    if (result.size === null) return null;

    const size = toBigInt(result.size);
    await prisma.downloadFile.update({ where: { id: file.id }, data: { sizeBytes: size } });
    return size;
  }

  /** Append a progress write to this job's chain, keeping writes ordered. */
  private queueProgressWrite(
    downloadId: string,
    fileId: string,
    bytesOnDisk: number,
    totalBytes: number | null,
  ): void {
    const previous = this.progressWrites.get(downloadId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => this.persistProgress(downloadId, fileId, bytesOnDisk, totalBytes));
    this.progressWrites.set(downloadId, next);
  }

  /** Wait for this job's outstanding progress writes, then forget them. */
  private async settleProgressWrites(downloadId: string): Promise<void> {
    const pending = this.progressWrites.get(downloadId);
    if (!pending) return;
    await pending.catch(() => undefined);
    this.progressWrites.delete(downloadId);
  }

  private async persistProgress(
    downloadId: string,
    fileId: string,
    bytesOnDisk: number,
    totalBytes: number | null,
  ): Promise<void> {
    try {
      await prisma.downloadFile.update({
        where: { id: fileId },
        data: {
          downloadedBytes: toBigIntOrZero(bytesOnDisk),
          ...(totalBytes !== null ? { sizeBytes: toBigInt(totalBytes) } : {}),
        },
      });
      const totals = await this.recomputeTotals(downloadId);
      recordSpeedSample(downloadId, totals.downloaded);
      await publishDownload(downloadId, 'download:progress');
    } catch (error) {
      // Progress reporting must never abort a healthy transfer.
      logger.debug({ err: error, downloadId }, 'Progress write failed');
    }
  }

  /** Roll the per-file numbers up to the job. */
  private async recomputeTotals(downloadId: string): Promise<{ downloaded: number; total: number | null }> {
    const files = await prisma.downloadFile.findMany({
      where: { downloadId },
      select: { downloadedBytes: true, sizeBytes: true },
    });

    let downloaded = 0;
    let total = 0;
    let everySizeKnown = true;

    for (const file of files) {
      downloaded += Number(file.downloadedBytes);
      if (file.sizeBytes === null) everySizeKnown = false;
      else total += Number(file.sizeBytes);
    }

    // A partial total would make the progress bar lie, so it stays null until
    // every file has a size.
    const totalBytes = everySizeKnown ? total : null;

    await prisma.download.update({
      where: { id: downloadId },
      data: {
        downloadedBytes: toBigIntOrZero(downloaded),
        totalBytes: totalBytes !== null ? toBigInt(totalBytes) : null,
      },
    });

    return { downloaded, total: totalBytes };
  }

  private async markFileFailed(fileId: string, error: string): Promise<void> {
    await prisma.downloadFile.update({
      where: { id: fileId },
      data: { status: 'FAILED', error: error.slice(0, 500), finishedAt: new Date() },
    });
  }

  private async isCancelled(downloadId: string): Promise<boolean> {
    const row = await prisma.download.findUnique({
      where: { id: downloadId },
      select: { cancelRequested: true },
    });
    return row?.cancelRequested ?? false;
  }

  private async finishJob(downloadId: string, cancelled: boolean): Promise<void> {
    // Let any in-flight progress write land first, so the totals computed below
    // are the last word on this job rather than being clobbered by a stale one.
    await this.settleProgressWrites(downloadId);

    const files = await prisma.downloadFile.findMany({
      where: { downloadId },
      select: { status: true, relPath: true },
    });

    const completed = files.filter((file) => file.status === 'COMPLETED').length;
    const failed = files.filter((file) => file.status === 'FAILED').length;

    let status: string;
    let error: string | null = null;

    if (cancelled) {
      status = 'CANCELLED';
      await prisma.downloadFile.updateMany({
        where: { downloadId, status: { in: ['PENDING', 'RUNNING'] } },
        data: { status: 'CANCELLED' },
      });
    } else if (completed === files.length) {
      status = 'COMPLETED';
    } else if (completed > 0) {
      status = 'PARTIAL';
      error = `${failed} of ${files.length} files could not be downloaded`;
    } else {
      status = 'FAILED';
      error = 'No files could be downloaded';
    }

    // Recompute from the now-final per-file rows before the status is written.
    await this.recomputeTotals(downloadId);

    await prisma.download.update({
      where: { id: downloadId },
      data: { status, error, finishedAt: new Date(), cancelRequested: false },
    });

    // Tell Nextcloud and Jellyfin about anything that actually landed.
    if (completed > 0) {
      const download = await prisma.download.findUnique({
        where: { id: downloadId },
        select: { folderName: true },
      });
      if (download) {
        const titleDir = path.join(env.MEDIA_ROOT, download.folderName);
        const result = await runPostProcessing(titleDir);
        logger.info({ downloadId, ...result }, 'Post-processing done');
      }
    }

    logger.info({ downloadId, status, completed, failed }, 'Download finished');
    await publishDownload(downloadId, 'download:finished');
  }

  /** Abort an in-flight job immediately, if this process is running it. */
  abort(downloadId: string): boolean {
    const controller = this.aborts.get(downloadId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  /** Stop accepting work and abort everything in flight. */
  shutdown(): void {
    this.stopped = true;
    for (const controller of this.aborts.values()) controller.abort();
  }
}

function formatGib(bytes: number): string {
  if (!Number.isFinite(bytes)) return 'unknown';
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const downloadQueue = new DownloadQueue();

/** Called once at boot. */
export async function startDownloadQueue(): Promise<void> {
  await downloadQueue.recoverFromCrash();
  downloadQueue.wake();
}
