/**
 * File size probing.
 *
 * The API never reports sizes, so the only way to show a user what "Add to
 * Jellyfin" will cost is to ask the file host. Ported from
 * `circleftp_core.py::probe_sizes`, including the fallback for hosts that
 * refuse HEAD.
 */
import { request } from 'undici';

import { metadataDispatcher } from '../lib/httpClient.js';
import { logger } from '../lib/logger.js';

const USER_AGENT = 'circleftp-jellyfin/0.1 (+self-hosted)';

export interface ProbeResult {
  size: number | null;
  status: number | null;
  /** Whether the host honours Range requests, i.e. whether resume will work. */
  supportsRange: boolean;
}

/**
 * Ask one URL for its size.
 *
 * Tries HEAD first. Some of the ftpN hosts answer 403 or 405 to HEAD while
 * serving GET perfectly well, so those fall back to a one-byte ranged GET and
 * read the total out of `Content-Range`.
 */
export async function probeSize(url: string, timeoutMs = 15_000): Promise<ProbeResult> {
  try {
    const head = await request(url, {
      method: 'HEAD',
      headers: { 'user-agent': USER_AGENT },
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs,
      dispatcher: metadataDispatcher,
    });
    await head.body.dump();

    const acceptsRanges = String(head.headers['accept-ranges'] ?? '').toLowerCase() === 'bytes';

    if (head.statusCode === 200) {
      const length = head.headers['content-length'];
      const size = parseLength(length);
      if (size !== null) {
        return { size, status: 200, supportsRange: acceptsRanges };
      }
    }

    if (head.statusCode === 403 || head.statusCode === 405 || head.statusCode === 501) {
      return await probeViaRange(url, timeoutMs);
    }

    return { size: null, status: head.statusCode, supportsRange: acceptsRanges };
  } catch (error) {
    logger.debug({ err: error, url }, 'HEAD probe failed, trying ranged GET');
    try {
      return await probeViaRange(url, timeoutMs);
    } catch {
      return { size: null, status: null, supportsRange: false };
    }
  }
}

/** One-byte ranged GET; `Content-Range: bytes 0-0/12345` carries the total. */
async function probeViaRange(url: string, timeoutMs: number): Promise<ProbeResult> {
  const response = await request(url, {
    method: 'GET',
    headers: { 'user-agent': USER_AGENT, range: 'bytes=0-0' },
    headersTimeout: timeoutMs,
    bodyTimeout: timeoutMs,
    dispatcher: metadataDispatcher,
  });
  const contentRange = String(response.headers['content-range'] ?? '');
  await response.body.dump();

  const match = /\/(\d+)\s*$/.exec(contentRange);
  if (match?.[1]) {
    // A 206 with a Content-Range total is proof resume works on this host.
    return { size: Number(match[1]), status: response.statusCode, supportsRange: true };
  }
  return { size: null, status: response.statusCode, supportsRange: false };
}

/**
 * Probe many URLs at once.
 *
 * Bounded by both concurrency and a wall-clock deadline: an unresponsive host
 * must not hold up a page render, so anything unfinished is reported as an
 * unknown size rather than waited on.
 */
export async function probeSizes<T extends { url: string }>(
  files: readonly T[],
  { concurrency = 8, perRequestTimeoutMs = 15_000, totalTimeoutMs = 45_000 } = {},
): Promise<Map<string, ProbeResult>> {
  const results = new Map<string, ProbeResult>();
  if (files.length === 0) return results;

  const deadline = Date.now() + totalTimeoutMs;
  const queue = [...files];

  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length > 0) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return;

      const file = queue.shift();
      if (!file) return;
      if (results.has(file.url)) continue;

      const result = await probeSize(file.url, Math.min(perRequestTimeoutMs, remaining));
      results.set(file.url, result);
    }
  });

  await Promise.all(workers);
  return results;
}

function parseLength(value: string | string[] | undefined): number | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/** Sum of known sizes, or null when nothing was resolved. */
export function totalKnownSize(sizes: Iterable<number | null>): number | null {
  let total = 0;
  let any = false;
  for (const size of sizes) {
    if (size !== null) {
      total += size;
      any = true;
    }
  }
  return any ? total : null;
}
