/**
 * Destination path resolution and safety.
 *
 * Every path here is derived from data the Circle FTP API supplied, so none of
 * it is trusted. `resolveDestination` is the single choke point: if a resolved
 * path is not inside MEDIA_ROOT, the download does not happen.
 */
import { statfs } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { env } from '../env.js';
import { ApiError } from '../lib/errors.js';
import { sanitize } from '../circleftp/text.js';

const statfsAsync = promisify(statfs);

/** Suffix for a file still being written. Renamed away on completion. */
export const PART_SUFFIX = '.part';

/**
 * Resolve `<MEDIA_ROOT>/<folder>/<relPath>`, rejecting anything that escapes.
 *
 * Each path segment is sanitised individually, so a "../" that survived the
 * upstream data cannot reappear as a directory level. The final containment
 * check is belt-and-braces against a sanitiser bug.
 */
export function resolveDestination(folder: string, relPath: string): string {
  const root = path.resolve(env.MEDIA_ROOT);
  const safeFolder = sanitize(folder, 'untitled');

  const segments = relPath
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
    .map((segment) => sanitize(segment, 'file'));

  if (segments.length === 0) {
    throw ApiError.badRequest('That title has no usable file name');
  }

  const resolved = path.resolve(root, safeFolder, ...segments);

  // `path.resolve` has already collapsed any traversal; this proves the result
  // still sits under the media root before anything is written.
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw ApiError.badRequest('Refusing to write outside the media directory');
  }
  return resolved;
}

export function partPathFor(destination: string): string {
  return destination + PART_SUFFIX;
}

export async function ensureParentDir(destination: string): Promise<void> {
  await fs.mkdir(path.dirname(destination), { recursive: true });
}

export async function fileSize(file: string): Promise<number> {
  try {
    const stat = await fs.stat(file);
    return stat.isFile() ? stat.size : 0;
  } catch {
    return 0;
  }
}

export async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

/** Free bytes on the filesystem holding the media root. */
export async function freeBytes(): Promise<number> {
  try {
    const stats = await statfsAsync(env.MEDIA_ROOT);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    // Unknown free space must not block downloads; the disk will error if full.
    return Number.POSITIVE_INFINITY;
  }
}

export interface SpaceCheck {
  ok: boolean;
  free: number;
  required: number;
}

/**
 * Would writing `incomingBytes` take the disk below the configured floor?
 *
 * The floor exists because this writes into the same volume as Nextcloud's own
 * data — filling it would take far more than this app down with it.
 */
export async function checkSpace(incomingBytes: number | null): Promise<SpaceCheck> {
  const free = await freeBytes();
  const floor = env.MIN_FREE_GIB * 1024 ** 3;
  const required = (incomingBytes ?? 0) + floor;
  return { ok: free >= required, free, required };
}

/** Remove a job's files and any directories it emptied. */
export async function removeDownloadFiles(folder: string, relPaths: readonly string[]): Promise<void> {
  const root = path.resolve(env.MEDIA_ROOT);

  for (const relPath of relPaths) {
    let destination: string;
    try {
      destination = resolveDestination(folder, relPath);
    } catch {
      continue; // Never delete something we would have refused to write.
    }
    await fs.rm(destination, { force: true });
    await fs.rm(partPathFor(destination), { force: true });
  }

  // Tidy up the season folder, then the title folder, but only while empty.
  const titleDir = path.resolve(root, sanitize(folder, 'untitled'));
  if (titleDir === root || !titleDir.startsWith(root + path.sep)) return;

  const seasonDirs = new Set(
    relPaths
      .map((relPath) => relPath.split('/').slice(0, -1).join('/'))
      .filter((dir) => dir.length > 0),
  );
  for (const seasonDir of seasonDirs) {
    await fs.rmdir(path.join(titleDir, sanitize(seasonDir, 'season'))).catch(() => undefined);
  }
  await fs.rmdir(titleDir).catch(() => undefined);
}
