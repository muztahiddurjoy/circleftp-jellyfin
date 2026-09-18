/**
 * A stand-in for a Circle FTP file host.
 *
 * Supports Range requests the way the real ftpN Apache hosts do, and can be
 * told to misbehave — cut a connection mid-transfer, refuse HEAD, ignore Range
 * — so the downloader's resume and retry paths can be tested without depending
 * on a flaky upstream.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FileServerOptions {
  /** Drop the connection after this many bytes, once, then behave normally. */
  cutAfterBytes?: number;
  /** Answer HEAD with this status instead of 200. */
  headStatus?: number;
  /** Ignore Range headers and always send the whole body with a 200. */
  ignoreRange?: boolean;
  /** Fail this many requests with a 500 before serving normally. */
  failFirst?: number;
}

export interface TestFileServer {
  url: (name: string) => string;
  addFile: (name: string, body: Buffer) => void;
  close: () => Promise<void>;
  requestCount: () => number;
  setOptions: (options: FileServerOptions) => void;
}

export async function startFileServer(initial: FileServerOptions = {}): Promise<TestFileServer> {
  const files = new Map<string, Buffer>();
  let options: FileServerOptions = { ...initial };
  let requests = 0;
  let failuresLeft = options.failFirst ?? 0;
  let cutUsed = false;

  const server = http.createServer((req, res) => {
    requests += 1;

    const name = decodeURIComponent((req.url ?? '/').replace(/^\//, '').split('?')[0]!);
    const body = files.get(name);

    if (!body) {
      res.writeHead(404).end('not found');
      return;
    }

    if (failuresLeft > 0) {
      failuresLeft -= 1;
      res.writeHead(500).end('temporary failure');
      return;
    }

    if (req.method === 'HEAD') {
      const status = options.headStatus ?? 200;
      if (status !== 200) {
        res.writeHead(status).end();
        return;
      }
      res.writeHead(200, {
        'Content-Length': String(body.length),
        'Accept-Ranges': 'bytes',
        'Content-Type': 'application/octet-stream',
      }).end();
      return;
    }

    const rangeHeader = options.ignoreRange ? undefined : req.headers.range;
    let start = 0;
    let end = body.length - 1;
    let status = 200;

    if (typeof rangeHeader === 'string') {
      const match = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader.trim());
      if (match) {
        start = Number(match[1]);
        if (match[2]) end = Number(match[2]);

        if (start >= body.length) {
          res.writeHead(416, { 'Content-Range': `bytes */${body.length}` }).end();
          return;
        }
        status = 206;
      }
    }

    const slice = body.subarray(start, end + 1);
    const headers: Record<string, string> = {
      'Content-Length': String(slice.length),
      'Accept-Ranges': 'bytes',
      'Content-Type': 'application/octet-stream',
    };
    if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${body.length}`;

    res.writeHead(status, headers);

    // Simulate a mid-transfer drop: send a prefix, then destroy the socket so
    // the client sees a truncated body rather than a clean end.
    if (options.cutAfterBytes !== undefined && !cutUsed && slice.length > options.cutAfterBytes) {
      cutUsed = true;
      res.write(slice.subarray(0, options.cutAfterBytes));
      setTimeout(() => res.destroy(), 20);
      return;
    }

    res.end(slice);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: (name) => `http://127.0.0.1:${port}/${encodeURIComponent(name)}`,
    addFile: (name, body) => files.set(name, body),
    requestCount: () => requests,
    setOptions: (next) => {
      options = { ...options, ...next };
      failuresLeft = next.failFirst ?? failuresLeft;
      if (next.cutAfterBytes !== undefined) cutUsed = false;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** Deterministic pseudo-random content, so a truncated file is detectable. */
export function makeBlob(size: number, seed = 7): Buffer {
  const buffer = Buffer.alloc(size);
  let state = seed;
  for (let i = 0; i < size; i += 1) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    buffer[i] = state & 0xff;
  }
  return buffer;
}
