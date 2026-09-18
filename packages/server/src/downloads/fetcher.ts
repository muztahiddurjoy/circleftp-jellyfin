/**
 * Single-file downloader with resume.
 *
 * Writes to `<dest>.part` and renames on completion, so a partial file is never
 * visible to Jellyfin's scanner. If a `.part` already exists, the transfer
 * resumes from its length with a Range request — Circle FTP's ftpN hosts are
 * plain Apache and honour Range, which matters when a 4 GB file drops at 90%.
 */
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';

import { request } from 'undici';

import { env } from '../env.js';
import { downloadDispatcher } from '../lib/httpClient.js';
import { logger } from '../lib/logger.js';
import { ensureParentDir, fileSize, partPathFor } from './paths.js';

const USER_AGENT = 'circleftp-jellyfin/0.1 (+self-hosted)';

export class DownloadCancelledError extends Error {
  constructor() {
    super('Download cancelled');
    this.name = 'DownloadCancelledError';
  }
}

export class DownloadStalledError extends Error {
  constructor(ms: number) {
    super(`No data received for ${Math.round(ms / 1000)}s`);
    this.name = 'DownloadStalledError';
  }
}

export interface FetchOptions {
  url: string;
  destination: string;
  /** Bytes already accounted for elsewhere; used only for progress reporting. */
  expectedSize?: number | null;
  signal: AbortSignal;
  /** Called roughly every 500ms with the total bytes on disk for this file. */
  onProgress?: (bytesOnDisk: number, totalBytes: number | null) => void;
}

export interface FetchResult {
  bytes: number;
  /** True when the file was already complete and nothing was transferred. */
  skipped: boolean;
}

/**
 * Download one file, resuming if a partial exists.
 *
 * Throws `DownloadCancelledError` when the signal aborts, `DownloadStalledError`
 * when the connection goes quiet, and a plain Error for anything else. The
 * caller decides whether to retry.
 */
export async function fetchFile(options: FetchOptions): Promise<FetchResult> {
  const { url, destination, signal, onProgress } = options;
  const partPath = partPathFor(destination);

  await ensureParentDir(destination);

  // Already finished on a previous run — nothing to do.
  const finalSize = await fileSize(destination);
  if (finalSize > 0) {
    const expected = options.expectedSize ?? null;
    if (expected === null || finalSize === expected) {
      return { bytes: finalSize, skipped: true };
    }
    // Wrong size: the previous attempt produced something we cannot trust.
    logger.warn({ destination, finalSize, expected }, 'Existing file has unexpected size, refetching');
    await fs.rm(destination, { force: true });
  }

  let resumeFrom = await fileSize(partPath);

  const headers: Record<string, string> = { 'user-agent': USER_AGENT };
  if (resumeFrom > 0) headers.range = `bytes=${resumeFrom}-`;

  const response = await request(url, {
    method: 'GET',
    headers,
    signal,
    dispatcher: downloadDispatcher,
    headersTimeout: 60_000,
    // The stall detector below governs a long transfer, not a blanket timeout
    // that would kill a healthy multi-gigabyte download.
    bodyTimeout: 0,
  });

  if (response.statusCode === 416) {
    // "Range not satisfiable": the partial is already the whole file.
    await response.body.dump();
    await fs.rename(partPath, destination);
    return { bytes: resumeFrom, skipped: false };
  }

  if (response.statusCode === 200 && resumeFrom > 0) {
    // The host ignored our Range and is sending from the start; honour that
    // rather than appending and corrupting the file.
    logger.warn({ url }, 'Host ignored Range request, restarting from zero');
    await fs.rm(partPath, { force: true });
    resumeFrom = 0;
  }

  if (response.statusCode !== 200 && response.statusCode !== 206) {
    await response.body.dump();
    throw new Error(`HTTP ${response.statusCode} from the file host`);
  }

  const totalBytes = totalFromHeaders(response.headers, resumeFrom);

  const handle = createWriteStream(partPath, { flags: resumeFrom > 0 ? 'a' : 'w' });

  let written = resumeFrom;
  let lastReport = 0;
  let lastByteAt = Date.now();

  // A dead TCP connection can hang indefinitely without erroring, so progress
  // itself is the liveness signal.
  const stallTimer = setInterval(() => {
    const idleFor = Date.now() - lastByteAt;
    if (idleFor > env.DOWNLOAD_STALL_TIMEOUT_MS) {
      handle.destroy(new DownloadStalledError(idleFor));
    }
  }, 5_000);
  stallTimer.unref();

  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      written += chunk.length;
      lastByteAt = Date.now();

      const now = Date.now();
      if (onProgress && now - lastReport > 500) {
        lastReport = now;
        onProgress(written, totalBytes);
      }
      callback(null, chunk);
    },
  });

  try {
    await pipeline(response.body, counter, handle, { signal });
  } catch (error) {
    clearInterval(stallTimer);
    // The partial file is deliberately kept: the next attempt resumes from it.
    if (signal.aborted) throw new DownloadCancelledError();
    throw error;
  }
  clearInterval(stallTimer);

  onProgress?.(written, totalBytes);

  // A truncated transfer that still "succeeded" must not be renamed into place,
  // or Jellyfin will index a broken file.
  if (totalBytes !== null && written < totalBytes) {
    throw new Error(`Transfer ended early at ${written} of ${totalBytes} bytes`);
  }

  await fs.rename(partPath, destination);
  return { bytes: written, skipped: false };
}

/**
 * Total file size from the response.
 *
 * On a 206 the total is the part after the slash in `Content-Range`; on a 200
 * it is `Content-Length`. A resumed 206 whose Content-Range is missing falls
 * back to offset + length.
 */
function totalFromHeaders(
  headers: Record<string, string | string[] | undefined>,
  resumeFrom: number,
): number | null {
  const contentRange = String(headers['content-range'] ?? '');
  const match = /\/(\d+)\s*$/.exec(contentRange);
  if (match?.[1]) return Number(match[1]);

  const raw = headers['content-length'];
  const lengthText = Array.isArray(raw) ? raw[0] : raw;
  if (!lengthText) return null;

  const length = Number(lengthText);
  if (!Number.isFinite(length)) return null;
  return resumeFrom + length;
}
