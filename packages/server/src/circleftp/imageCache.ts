/**
 * Poster proxy cache.
 *
 * Posters must not be hotlinked: Circle FTP serves them over plain HTTP, so an
 * HTTPS page would block them as mixed content, and every visitor's browser
 * would be talking to Circle FTP directly. Proxying fixes both; caching to disk
 * keeps a grid of 24 posters from becoming 24 upstream requests per render.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { request } from 'undici';

import { env } from '../env.js';
import { metadataDispatcher } from '../lib/httpClient.js';
import { logger } from '../lib/logger.js';

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

const ALLOWED_CONTENT_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/avif',
]);

export interface CachedImage {
  body: Buffer;
  contentType: string;
}

function cacheDir(): string {
  return path.join(env.CACHE_DIR, 'posters');
}

/**
 * The upstream filename is a UUID, but it arrives from the URL, so it is hashed
 * rather than trusted as a path component.
 */
function cachePath(filename: string): string {
  const hash = createHash('sha256').update(filename).digest('hex');
  return path.join(cacheDir(), `${hash.slice(0, 2)}`, hash);
}

/**
 * Reject anything that is not a plain filename before it reaches the URL.
 *
 * The allow-list is the whole defence: it admits no slash, no backslash, no
 * dot-segment and no control character, so nothing here can escape the upstream
 * uploads directory or the local cache directory.
 */
export function isValidImageName(filename: string): boolean {
  if (filename.length === 0 || filename.length > 200) return false;
  if (filename === '.' || filename === '..') return false;
  return /^[A-Za-z0-9._-]+$/.test(filename);
}

export async function getPoster(filename: string): Promise<CachedImage | null> {
  const file = cachePath(filename);

  const cached = await readCache(file);
  if (cached) return cached;

  const fetched = await fetchUpstream(filename);
  if (!fetched) return null;

  await writeCache(file, fetched).catch((error: unknown) => {
    // A full or unwritable cache directory must not break image serving.
    logger.warn({ err: error, filename }, 'Could not cache poster');
  });

  return fetched;
}

async function readCache(file: string): Promise<CachedImage | null> {
  try {
    const stat = await fs.stat(file);
    if (Date.now() - stat.mtimeMs > CACHE_TTL_MS) return null;
    const body = await fs.readFile(file);
    const contentType = await fs.readFile(`${file}.type`, 'utf8').catch(() => 'image/jpeg');
    return { body, contentType: contentType.trim() || 'image/jpeg' };
  } catch {
    return null;
  }
}

async function writeCache(file: string, image: CachedImage): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  // Write-then-rename so a concurrent reader never sees a half-written file.
  const temp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temp, image.body);
  await fs.rename(temp, file);
  await fs.writeFile(`${file}.type`, image.contentType);
}

async function fetchUpstream(filename: string): Promise<CachedImage | null> {
  const url = `${env.CIRCLEFTP_IMAGE_BASE.replace(/\/$/, '')}/${encodeURIComponent(filename)}`;
  try {
    const response = await request(url, {
      method: 'GET',
      headers: { 'user-agent': 'circleftp-jellyfin/0.1', accept: 'image/*' },
      headersTimeout: 15_000,
      bodyTimeout: 20_000,
      dispatcher: metadataDispatcher,
    });

    if (response.statusCode !== 200) {
      await response.body.dump();
      return null;
    }

    const contentType = String(response.headers['content-type'] ?? '')
      .split(';')[0]!
      .trim()
      .toLowerCase();
    if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
      // Never relay an arbitrary upstream body as if it were an image.
      await response.body.dump();
      logger.debug({ filename, contentType }, 'Rejected non-image poster response');
      return null;
    }

    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of response.body) {
      const buffer = Buffer.from(chunk);
      total += buffer.length;
      if (total > MAX_IMAGE_BYTES) {
        response.body.destroy();
        logger.debug({ filename }, 'Poster exceeded the size cap');
        return null;
      }
      chunks.push(buffer);
    }

    return { body: Buffer.concat(chunks), contentType };
  } catch (error) {
    logger.debug({ err: error, filename }, 'Poster fetch failed');
    return null;
  }
}
