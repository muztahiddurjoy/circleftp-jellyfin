/**
 * Test bootstrap.
 *
 * Runs before any module under test is imported, which matters because `env.ts`
 * reads `process.env` once at import time. Everything is pointed at throwaway
 * directories so a test run can never touch the real media root or database.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll } from 'vitest';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cfj-test-'));

const dbFile = path.join(tempRoot, 'test.db');
const mediaRoot = path.join(tempRoot, 'media');
const cacheDir = path.join(tempRoot, 'cache');

fs.mkdirSync(mediaRoot, { recursive: true });
fs.mkdirSync(cacheDir, { recursive: true });

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = `file:${dbFile}`;
process.env.MEDIA_ROOT = mediaRoot;
process.env.CACHE_DIR = cacheDir;
process.env.SESSION_SECRET = 'test-secret-value-at-least-sixteen-chars';
// The logger already forces level 'silent' when NODE_ENV is test.
// The real rescans shell out to sudo and hit Jellyfin; neither belongs in a test.
process.env.NEXTCLOUD_SCAN_ENABLED = 'false';
process.env.JELLYFIN_REFRESH_ENABLED = 'false';
// Keep retries quick so a failure test does not sit through eight backoffs.
process.env.DOWNLOAD_MAX_ATTEMPTS = '2';
process.env.MIN_FREE_GIB = '0';
process.env.DOWNLOAD_STALL_TIMEOUT_MS = '5000';

/**
 * npm workspaces hoist binaries to the repo root, so the package-local
 * `node_modules/.bin` may not exist. Check both.
 */
function prismaBin(): string {
  const candidates = [
    path.join(process.cwd(), 'node_modules', '.bin', 'prisma'),
    path.join(process.cwd(), '..', '..', 'node_modules', '.bin', 'prisma'),
  ];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) throw new Error(`Could not find the prisma CLI in: ${candidates.join(', ')}`);
  return found;
}

// Build the schema in the throwaway database.
execFileSync(prismaBin(), ['db', 'push', '--skip-generate', '--accept-data-loss'], {
  cwd: process.cwd(),
  stdio: 'pipe',
  env: { ...process.env },
});

export const testPaths = { tempRoot, dbFile, mediaRoot, cacheDir };

afterAll(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});
