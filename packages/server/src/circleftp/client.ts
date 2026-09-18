/**
 * Circle FTP API client.
 *
 * Base URL, image base and timeout all come from env so the upstream can move
 * without a code change. Every call is wrapped so a network failure surfaces as
 * a `CircleFtpError` the route layer can turn into a 502.
 */
import { request } from 'undici';

import { env } from '../env.js';
import { metadataDispatcher } from '../lib/httpClient.js';
import { logger } from '../lib/logger.js';
import { CircleFtpError, type RawPost, type RawSearchResponse } from './types.js';

const USER_AGENT = 'circleftp-jellyfin/0.1 (+self-hosted)';

/** Transient failures worth a second attempt. */
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;

async function getJson<T>(path: string, params?: Record<string, string>): Promise<T> {
  const url = new URL(env.CIRCLEFTP_API_BASE.replace(/\/$/, '') + path);
  for (const [key, value] of Object.entries(params ?? {})) {
    url.searchParams.set(key, value);
  }

  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await request(url, {
        method: 'GET',
        headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
        headersTimeout: env.CIRCLEFTP_TIMEOUT_MS,
        bodyTimeout: env.CIRCLEFTP_TIMEOUT_MS,
        dispatcher: metadataDispatcher,
      });

      if (response.statusCode === 404) {
        // Consume the body so the connection returns to the pool.
        await response.body.dump();
        throw new CircleFtpError('Not found on Circle FTP', 404);
      }

      if (response.statusCode >= 400) {
        await response.body.dump();
        if (RETRYABLE_STATUS.has(response.statusCode) && attempt < MAX_ATTEMPTS) {
          await delay(attempt * 400);
          continue;
        }
        throw new CircleFtpError(
          `Circle FTP returned HTTP ${response.statusCode}`,
          response.statusCode,
        );
      }

      const text = await response.body.text();

      // Circle FTP answers a request for a post that does not exist with
      // "200 OK" and an empty body rather than a 404. Retrying that would burn
      // three round trips and then report the server as unreachable, so an
      // empty body is treated as the not-found it actually is.
      if (text.trim().length === 0) {
        throw new CircleFtpError('Not found on Circle FTP', 404);
      }

      try {
        return JSON.parse(text) as T;
      } catch {
        // A non-JSON body is an upstream contract change, not a blip; retrying
        // will not fix it.
        throw new CircleFtpError('Circle FTP returned a response we could not read');
      }
    } catch (error) {
      // A definitive answer, whether or not we liked it. Do not retry.
      if (error instanceof CircleFtpError) throw error;
      lastError = error;
      if (attempt < MAX_ATTEMPTS) {
        logger.debug({ err: error, url: url.toString(), attempt }, 'Circle FTP request failed, retrying');
        await delay(attempt * 400);
        continue;
      }
    }
  }

  if (lastError instanceof CircleFtpError) throw lastError;
  throw new CircleFtpError(
    `Circle FTP is unreachable (${lastError instanceof Error ? lastError.message : 'unknown error'})`,
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Raw, unranked search results straight from the API. */
export async function rawSearch(query: string): Promise<RawPost[]> {
  const data = await getJson<RawSearchResponse | RawPost[]>('/posts', {
    searchTerm: query,
    order: 'desc',
  });
  const posts = Array.isArray(data) ? data : data.posts;
  return Array.isArray(posts) ? posts : [];
}

/** Full detail for one post, including its `content` payload. */
export async function fetchPost(postId: number): Promise<RawPost> {
  const data = await getJson<RawPost>(`/posts/${Math.trunc(postId)}`);
  if (!data || typeof data !== 'object' || data.id === undefined) {
    throw new CircleFtpError(`Post ${postId} was not found on Circle FTP`, 404);
  }
  return data;
}

/** Absolute upstream URL for a poster filename. */
export function imageUrl(filename: string): string {
  return `${env.CIRCLEFTP_IMAGE_BASE.replace(/\/$/, '')}/${encodeURIComponent(filename)}`;
}
