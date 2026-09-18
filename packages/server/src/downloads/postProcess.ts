/**
 * What happens after the bytes land.
 *
 * Files on disk are not enough: Nextcloud keeps its own file index and will not
 * show anything it has not scanned, and Jellyfin will not surface a new title
 * until its library is refreshed. Both steps are best-effort — a completed
 * download must never be reported as failed because a rescan did not fire.
 */
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

import { request } from 'undici';

import { env } from '../env.js';
import { metadataDispatcher } from '../lib/httpClient.js';
import { logger } from '../lib/logger.js';

const execFileAsync = promisify(execFile);

/**
 * Translate a filesystem path into the `occ files:scan --path` argument, which
 * is Nextcloud-relative: `<user>/files/<...>`, not an absolute path.
 */
export function nextcloudScanPath(absolutePath: string): string | null {
  const dataDir = path.resolve(env.NEXTCLOUD_DATA_DIR);
  const target = path.resolve(absolutePath);

  if (target !== dataDir && !target.startsWith(dataDir + path.sep)) return null;

  const relative = path.relative(dataDir, target);
  return relative.length > 0 ? relative : null;
}

/**
 * Ask Nextcloud to index a path.
 *
 * Runs through the sudoers rule the Hermes plugin already installs:
 *   muz-server ALL=(www-data) NOPASSWD: /usr/bin/php /var/www/nextcloud/occ files\:scan *
 * Without it the files still land on disk; only the Nextcloud index is stale.
 */
export async function scanNextcloud(absolutePath: string): Promise<boolean> {
  if (!env.NEXTCLOUD_SCAN_ENABLED) return false;

  const scanPath = nextcloudScanPath(absolutePath);
  if (!scanPath) {
    logger.debug({ absolutePath }, 'Path is outside the Nextcloud data dir, skipping scan');
    return false;
  }

  const args = [
    '-n', // never prompt for a password: fail fast if the sudoers rule is gone
    '-u',
    env.NEXTCLOUD_WEB_USER,
    env.NEXTCLOUD_PHP_PATH,
    env.NEXTCLOUD_OCC_PATH,
    'files:scan',
    `--path=${scanPath}`,
  ];

  try {
    await execFileAsync('sudo', args, { timeout: 300_000, maxBuffer: 4 * 1024 * 1024 });
    logger.info({ scanPath }, 'Nextcloud rescan complete');
    return true;
  } catch (error) {
    logger.warn(
      { err: error, scanPath },
      'Nextcloud rescan failed (files are on disk; check /etc/sudoers.d/circleftp-occ)',
    );
    return false;
  }
}

/**
 * Ask Jellyfin to rescan its libraries.
 *
 * Jellyfin has no "scan this one folder" API — `/Library/Refresh` kicks off a
 * scan of everything, which is cheap because it only looks at what changed.
 */
export async function refreshJellyfin(): Promise<boolean> {
  if (!env.JELLYFIN_REFRESH_ENABLED || !env.JELLYFIN_API_KEY) return false;

  try {
    const response = await request(`${env.JELLYFIN_URL.replace(/\/$/, '')}/Library/Refresh`, {
      method: 'POST',
      headers: {
        // Jellyfin 10.9+ accepts Authorization; the legacy header still works
        // and is simpler for a server-to-server call.
        'x-emby-token': env.JELLYFIN_API_KEY,
        'content-length': '0',
      },
      headersTimeout: 15_000,
      bodyTimeout: 15_000,
      dispatcher: metadataDispatcher,
    });
    await response.body.dump();

    if (response.statusCode >= 200 && response.statusCode < 300) {
      logger.info('Jellyfin library refresh triggered');
      return true;
    }
    logger.warn({ status: response.statusCode }, 'Jellyfin refresh returned an error status');
    return false;
  } catch (error) {
    logger.warn({ err: error }, 'Jellyfin refresh failed');
    return false;
  }
}

/** Run both rescans. Never throws: the download itself already succeeded. */
export async function runPostProcessing(titleDir: string): Promise<{
  nextcloud: boolean;
  jellyfin: boolean;
}> {
  const [nextcloud, jellyfin] = await Promise.all([
    scanNextcloud(titleDir).catch(() => false),
    refreshJellyfin().catch(() => false),
  ]);
  return { nextcloud, jellyfin };
}
