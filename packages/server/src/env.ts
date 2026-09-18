/**
 * Environment loading and validation.
 *
 * Everything the app can be configured with is declared here and validated once
 * at boot, so a typo in `.env` fails immediately with a readable message rather
 * than surfacing as `undefined` halfway through a download.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import dotenv from 'dotenv';
import { z } from 'zod';

const here = path.dirname(fileURLToPath(import.meta.url));
/** Package root, whether running from `src/` (tsx) or `dist/` (node). */
export const packageRoot = path.resolve(here, '..');
export const repoRoot = path.resolve(packageRoot, '..', '..');

dotenv.config({ path: path.join(packageRoot, '.env') });

const booleanish = z
  .enum(['true', 'false', '1', '0', 'yes', 'no'])
  .transform((value) => value === 'true' || value === '1' || value === 'yes');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(7070),
  HOST: z.string().default('0.0.0.0'),

  /**
   * Signs session cookies. Must be set in production — a random per-boot value
   * would silently log everyone out on every restart.
   */
  SESSION_SECRET: z.string().min(16).optional(),
  SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  /** Send `Secure` on the session cookie. Off by default: plain HTTP on Tailscale. */
  COOKIE_SECURE: booleanish.default('false'),

  /** Circle FTP JSON API, reverse-engineered from the site's React bundle. */
  CIRCLEFTP_API_BASE: z.string().url().default('http://new.circleftp.net:5000/api'),
  CIRCLEFTP_IMAGE_BASE: z.string().url().default('http://new.circleftp.net:5000/uploads'),
  CIRCLEFTP_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(25_000),

  /** Where downloads land. `<Title (Year)>/[Season NN/]file` is created below it. */
  MEDIA_ROOT: z.string().default('/var/nextcloud-data/ncadmin/files/Movies'),
  /** Poster cache directory. */
  CACHE_DIR: z.string().default(path.join(packageRoot, 'var', 'cache')),

  /**
   * Circle FTP hosts give ~9-10 MB/s on a single stream and get *slower* when
   * split across parallel ranges, so one at a time is the right default.
   */
  DOWNLOAD_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(1),
  DOWNLOAD_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(8),
  /** Refuse to start a file that would take the disk below this. */
  MIN_FREE_GIB: z.coerce.number().min(0).max(1024).default(5),
  /** Give up on a stalled connection after this long with no bytes. */
  DOWNLOAD_STALL_TIMEOUT_MS: z.coerce.number().int().min(5_000).default(120_000),

  /** Tell Nextcloud to reindex the new files when a job finishes. */
  NEXTCLOUD_SCAN_ENABLED: booleanish.default('true'),
  NEXTCLOUD_DATA_DIR: z.string().default('/var/nextcloud-data'),
  NEXTCLOUD_OCC_PATH: z.string().default('/var/www/nextcloud/occ'),
  NEXTCLOUD_PHP_PATH: z.string().default('/usr/bin/php'),
  NEXTCLOUD_WEB_USER: z.string().default('www-data'),

  /** Tell Jellyfin to rescan. Needs an API key from Dashboard → API Keys. */
  JELLYFIN_REFRESH_ENABLED: booleanish.default('false'),
  JELLYFIN_URL: z.string().url().default('http://127.0.0.1:8096'),
  JELLYFIN_API_KEY: z.string().optional(),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  /** Serve the built web client from here. Empty = API only. */
  WEB_DIST: z.string().default(path.join(repoRoot, 'packages', 'web', 'dist')),
});

export type Env = z.infer<typeof envSchema> & { SESSION_SECRET: string };

function load(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const value = parsed.data;

  if (!value.SESSION_SECRET) {
    if (value.NODE_ENV === 'production') {
      throw new Error(
        'SESSION_SECRET must be set in production. Generate one with:\n' +
          "  node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
      );
    }
    // Dev/test convenience only. Restarting invalidates existing sessions.
    value.SESSION_SECRET = 'dev-only-insecure-session-secret-change-me';
  }

  if (value.JELLYFIN_REFRESH_ENABLED && !value.JELLYFIN_API_KEY) {
    throw new Error('JELLYFIN_REFRESH_ENABLED=true requires JELLYFIN_API_KEY');
  }

  return value as Env;
}

export const env = load();

export const isProduction = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';

/** True when a built web client is actually present to serve. */
export function hasWebDist(): boolean {
  return Boolean(env.WEB_DIST) && fs.existsSync(path.join(env.WEB_DIST, 'index.html'));
}
