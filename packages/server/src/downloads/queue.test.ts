/**
 * Download engine integration tests.
 *
 * These drive the real queue, the real fetcher and a real SQLite database
 * against a local stand-in for a Circle FTP file host, so resume, retry,
 * truncation detection and cancellation are exercised end to end rather than
 * mocked.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { testPaths } from '../test/setup.js';
import { makeBlob, startFileServer, type TestFileServer } from '../test/fileServer.js';
import { prisma } from '../lib/db.js';
import { downloadQueue } from './queue.js';
import { PART_SUFFIX } from './paths.js';

let fileServer: TestFileServer;

const BLOB = makeBlob(256 * 1024); // 256 KiB, big enough to cut in half

beforeEach(async () => {
  await prisma.downloadFile.deleteMany();
  await prisma.download.deleteMany();
  await fs.rm(testPaths.mediaRoot, { recursive: true, force: true });
  await fs.mkdir(testPaths.mediaRoot, { recursive: true });

  await fileServer?.close();
  fileServer = await startFileServer();
  fileServer.addFile('movie.mkv', BLOB);
});

afterAll(async () => {
  await fileServer?.close();
  await prisma.$disconnect();
});

interface JobFile {
  relPath: string;
  url: string;
}

async function createJob(folderName: string, files: JobFile[]): Promise<string> {
  const download = await prisma.download.create({
    data: {
      postId: Math.floor(Math.random() * 1_000_000),
      title: folderName,
      folderName,
      kind: 'movie',
      status: 'QUEUED',
      files: {
        create: files.map((file, index) => ({
          order: index,
          url: file.url,
          relPath: file.relPath,
          label: file.relPath,
          status: 'PENDING',
        })),
      },
    },
  });
  return download.id;
}

/** Poll until the job reaches a terminal state, or fail the test. */
async function waitForFinish(id: string, timeoutMs = 25_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = await prisma.download.findUnique({ where: { id }, select: { status: true } });
    if (row && !['QUEUED', 'RUNNING'].includes(row.status)) return row.status;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Download ${id} did not finish within ${timeoutMs}ms`);
}

function mediaPath(...segments: string[]): string {
  return path.join(testPaths.mediaRoot, ...segments);
}

describe('download queue', () => {
  it('downloads a file into the Jellyfin folder layout', async () => {
    const id = await createJob('Test Movie (2020)', [
      { relPath: 'Test Movie.mkv', url: fileServer.url('movie.mkv') },
    ]);

    downloadQueue.wake();
    expect(await waitForFinish(id)).toBe('COMPLETED');

    const written = await fs.readFile(mediaPath('Test Movie (2020)', 'Test Movie.mkv'));
    expect(written.length).toBe(BLOB.length);
    expect(written.equals(BLOB)).toBe(true);

    // The .part file must be gone, or Jellyfin would index a stray file.
    await expect(
      fs.access(mediaPath('Test Movie (2020)', `Test Movie.mkv${PART_SUFFIX}`)),
    ).rejects.toThrow();

    const job = await prisma.download.findUniqueOrThrow({
      where: { id },
      include: { files: true },
    });
    expect(Number(job.downloadedBytes)).toBe(BLOB.length);
    expect(Number(job.totalBytes)).toBe(BLOB.length);
    expect(job.files[0]?.status).toBe('COMPLETED');
    expect(job.finishedAt).not.toBeNull();
  });

  it('creates season sub-folders for a series', async () => {
    fileServer.addFile('ep1.mkv', BLOB.subarray(0, 4096));
    fileServer.addFile('ep2.mkv', BLOB.subarray(0, 8192));

    const id = await createJob('Test Show (2021)', [
      { relPath: 'Season 01/Test Show S01E01 - ep1.mkv', url: fileServer.url('ep1.mkv') },
      { relPath: 'Season 01/Test Show S01E02 - ep2.mkv', url: fileServer.url('ep2.mkv') },
    ]);

    downloadQueue.wake();
    expect(await waitForFinish(id)).toBe('COMPLETED');

    const entries = await fs.readdir(mediaPath('Test Show (2021)', 'Season 01'));
    expect(entries.sort()).toEqual([
      'Test Show S01E01 - ep1.mkv',
      'Test Show S01E02 - ep2.mkv',
    ]);

    const job = await prisma.download.findUniqueOrThrow({ where: { id } });
    expect(Number(job.totalBytes)).toBe(4096 + 8192);
  });

  it('resumes from a partial file rather than restarting', async () => {
    const destination = mediaPath('Resume Movie (2020)', 'Resume Movie.mkv');
    await fs.mkdir(path.dirname(destination), { recursive: true });
    // Pretend a previous run got 100 KiB in before dying.
    const alreadyHave = 100 * 1024;
    await fs.writeFile(destination + PART_SUFFIX, BLOB.subarray(0, alreadyHave));

    const id = await createJob('Resume Movie (2020)', [
      { relPath: 'Resume Movie.mkv', url: fileServer.url('movie.mkv') },
    ]);

    downloadQueue.wake();
    expect(await waitForFinish(id)).toBe('COMPLETED');

    // The result must be the whole, correct file — not a doubled or corrupt one.
    const written = await fs.readFile(destination);
    expect(written.length).toBe(BLOB.length);
    expect(written.equals(BLOB)).toBe(true);
  });

  it('retries and resumes after the connection is cut mid-transfer', async () => {
    fileServer.setOptions({ cutAfterBytes: 64 * 1024 });

    const id = await createJob('Flaky Movie (2020)', [
      { relPath: 'Flaky Movie.mkv', url: fileServer.url('movie.mkv') },
    ]);

    downloadQueue.wake();
    expect(await waitForFinish(id)).toBe('COMPLETED');

    const written = await fs.readFile(mediaPath('Flaky Movie (2020)', 'Flaky Movie.mkv'));
    expect(written.equals(BLOB)).toBe(true);

    const job = await prisma.download.findUniqueOrThrow({
      where: { id },
      include: { files: true },
    });
    // More than one attempt proves the retry path ran, not a lucky first pass.
    expect(job.files[0]!.attempts).toBeGreaterThan(1);
  });

  it('falls back to a ranged GET when the host refuses HEAD', async () => {
    fileServer.setOptions({ headStatus: 403 });

    const id = await createJob('No Head (2020)', [
      { relPath: 'No Head.mkv', url: fileServer.url('movie.mkv') },
    ]);

    downloadQueue.wake();
    expect(await waitForFinish(id)).toBe('COMPLETED');

    const job = await prisma.download.findUniqueOrThrow({
      where: { id },
      include: { files: true },
    });
    // The size still has to be discovered, or the progress bar has no denominator.
    expect(Number(job.files[0]!.sizeBytes)).toBe(BLOB.length);
  });

  it('restarts from zero when the host ignores a Range request', async () => {
    const destination = mediaPath('Ignores Range (2020)', 'Ignores Range.mkv');
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination + PART_SUFFIX, BLOB.subarray(0, 50 * 1024));

    fileServer.setOptions({ ignoreRange: true });

    const id = await createJob('Ignores Range (2020)', [
      { relPath: 'Ignores Range.mkv', url: fileServer.url('movie.mkv') },
    ]);

    downloadQueue.wake();
    expect(await waitForFinish(id)).toBe('COMPLETED');

    // Appending to the existing partial would have produced a corrupt file.
    const written = await fs.readFile(destination);
    expect(written.length).toBe(BLOB.length);
    expect(written.equals(BLOB)).toBe(true);
  });

  it('marks a job FAILED when the file is permanently missing', async () => {
    const id = await createJob('Missing Movie (2020)', [
      { relPath: 'Missing.mkv', url: fileServer.url('does-not-exist.mkv') },
    ]);

    downloadQueue.wake();
    expect(await waitForFinish(id)).toBe('FAILED');

    const job = await prisma.download.findUniqueOrThrow({
      where: { id },
      include: { files: true },
    });
    expect(job.files[0]?.status).toBe('FAILED');
    expect(job.files[0]?.error).toContain('404');
    expect(job.error).toBe('No files could be downloaded');
  });

  it('reports PARTIAL when some files succeed and others do not', async () => {
    const id = await createJob('Mixed Show (2021)', [
      { relPath: 'Season 01/good.mkv', url: fileServer.url('movie.mkv') },
      { relPath: 'Season 01/bad.mkv', url: fileServer.url('nope.mkv') },
    ]);

    downloadQueue.wake();
    expect(await waitForFinish(id)).toBe('PARTIAL');

    const job = await prisma.download.findUniqueOrThrow({
      where: { id },
      include: { files: { orderBy: { order: 'asc' } } },
    });
    expect(job.files.map((file) => file.status)).toEqual(['COMPLETED', 'FAILED']);
    expect(job.error).toContain('1 of 2');

    // The file that did succeed must still be in place and usable.
    const good = await fs.readFile(mediaPath('Mixed Show (2021)', 'Season 01', 'good.mkv'));
    expect(good.equals(BLOB)).toBe(true);
  });

  it('skips a file that is already complete on disk', async () => {
    const destination = mediaPath('Already There (2020)', 'Already There.mkv');
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, BLOB);

    const before = fileServer.requestCount();
    const id = await createJob('Already There (2020)', [
      { relPath: 'Already There.mkv', url: fileServer.url('movie.mkv') },
    ]);

    downloadQueue.wake();
    expect(await waitForFinish(id)).toBe('COMPLETED');

    // One HEAD to confirm the size; no body transfer.
    expect(fileServer.requestCount() - before).toBeLessThanOrEqual(1);
  });

  it('refuses a relative path that would escape the media root', async () => {
    const id = await createJob('Evil (2020)', [
      { relPath: '../../../../tmp/pwned.mkv', url: fileServer.url('movie.mkv') },
    ]);

    downloadQueue.wake();
    expect(await waitForFinish(id)).toBe('COMPLETED');

    // The ".." segments are dropped rather than resolved, so what is left
    // ("tmp/pwned.mkv") nests harmlessly inside the job's own folder.
    const written = await fs.readFile(mediaPath('Evil (2020)', 'tmp', 'pwned.mkv'));
    expect(written.length).toBe(BLOB.length);

    // The point of the test: nothing escaped the media root.
    await expect(fs.access('/tmp/pwned.mkv')).rejects.toThrow();
    await expect(fs.access(path.join(testPaths.mediaRoot, '..', 'pwned.mkv'))).rejects.toThrow();
  });

  it('rejects an absolute path outright', async () => {
    const id = await createJob('Absolute (2020)', [
      { relPath: '/etc/cron.d/pwned', url: fileServer.url('movie.mkv') },
    ]);

    downloadQueue.wake();
    expect(await waitForFinish(id)).toBe('COMPLETED');

    await expect(fs.access('/etc/cron.d/pwned')).rejects.toThrow();
    const written = await fs.readFile(mediaPath('Absolute (2020)', 'etc', 'cron.d', 'pwned'));
    expect(written.length).toBe(BLOB.length);
  });

  it('requeues jobs left RUNNING by a crash', async () => {
    const id = await createJob('Crashed (2020)', [
      { relPath: 'Crashed.mkv', url: fileServer.url('movie.mkv') },
    ]);
    await prisma.download.update({ where: { id }, data: { status: 'RUNNING' } });
    await prisma.downloadFile.updateMany({ where: { downloadId: id }, data: { status: 'RUNNING' } });

    await downloadQueue.recoverFromCrash();

    const recovered = await prisma.download.findUniqueOrThrow({
      where: { id },
      include: { files: true },
    });
    expect(recovered.status).toBe('QUEUED');
    expect(recovered.files[0]?.status).toBe('PENDING');
  });
});
