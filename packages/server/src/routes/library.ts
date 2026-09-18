/**
 * The Circle FTP proxy.
 *
 * The browser never talks to Circle FTP: search, detail and posters all come
 * through here, behind the app's own authentication.
 */
import {
  postIdSchema,
  searchQuerySchema,
  titleDetailQuerySchema,
  type SeasonSummaryDto,
  type TitleDetailDto,
} from '@cfj/shared';
import { Router } from 'express';

import { requireAuth } from '../auth/middleware.js';
import { fetchPost } from '../circleftp/client.js';
import { getPoster, isValidImageName } from '../circleftp/imageCache.js';
import { buildPlan, describePost } from '../circleftp/plan.js';
import { probeSizes, totalKnownSize } from '../circleftp/probe.js';
import { enrichSeries, kindOf, mainCategory, searchTitles } from '../circleftp/search.js';
import { CircleFtpError } from '../circleftp/types.js';
import { prisma } from '../lib/db.js';
import { ApiError } from '../lib/errors.js';
import { asyncHandler, parseQuery } from '../lib/http.js';

export const libraryRouter: Router = Router();

/** Any upstream failure becomes a 502 with a message worth showing a user. */
function rethrowUpstream(error: unknown): never {
  if (error instanceof CircleFtpError) {
    if (error.status === 404) throw ApiError.notFound('That title is no longer on Circle FTP');
    throw ApiError.upstream(error.message);
  }
  throw error;
}

libraryRouter.get(
  '/library/search',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { q, kind, limit } = parseQuery(searchQuerySchema, req.query);

    const results = await searchTitles(q, { kind, limit }).catch(rethrowUpstream);
    // Season counts make series cards useful; a slow upstream just omits them.
    await enrichSeries(results);

    res.json({ query: q, kind, results });
  }),
);

libraryRouter.get(
  '/library/title/:postId',
  requireAuth,
  asyncHandler(async (req, res) => {
    const parsedId = postIdSchema.safeParse(req.params.postId);
    if (!parsedId.success) throw ApiError.badRequest('Invalid title id');
    const postId = parsedId.data;

    const { seasons: wantedSeasons, probe } = parseQuery(titleDetailQuerySchema, req.query);

    const post = await fetchPost(postId).catch(rethrowUpstream);
    const plan = buildPlan(post, wantedSeasons);
    const description = describePost(post);

    // Probing is opt-in: it costs one request per file against the file hosts.
    const sizes = probe
      ? await probeSizes(plan.files, { concurrency: 8, totalTimeoutMs: 30_000 })
      : new Map();

    const files = plan.files.map((file) => ({
      relPath: file.relPath,
      label: file.label,
      season: file.season,
      episode: file.episode,
      size: sizes.get(file.url)?.size ?? null,
    }));

    // Surface an in-flight job so the UI can offer "view progress" instead of
    // a second identical download.
    const active = await prisma.download.findFirst({
      where: { postId, status: { in: ['QUEUED', 'RUNNING'] } },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });

    const seasonSummaries: SeasonSummaryDto[] = plan.seasons.map((season) => ({
      name: season.name,
      number: season.number,
      episodeCount: season.episodeCount,
    }));

    const detail: TitleDetailDto = {
      postId,
      ...description,
      kind: kindOf(post),
      type: String(post.type ?? ''),
      category: mainCategory(post),
      posterUrl: post.image ? `/api/library/image/${encodeURIComponent(post.image)}` : null,
      folderName: plan.folder,
      seasons: seasonSummaries,
      files,
      totalSize: probe ? totalKnownSize(files.map((file) => file.size)) : null,
      alreadyQueued: Boolean(active),
      activeDownloadId: active?.id ?? null,
    };

    res.json(detail);
  }),
);

/**
 * Poster proxy.
 *
 * Authenticated like everything else, so the app cannot be used as an open
 * image relay for Circle FTP.
 */
libraryRouter.get(
  '/library/image/:filename',
  requireAuth,
  asyncHandler(async (req, res) => {
    const filename = String(req.params.filename ?? '');
    if (!isValidImageName(filename)) throw ApiError.badRequest('Invalid image name');

    const image = await getPoster(filename);
    if (!image) throw ApiError.notFound('Poster not available');

    res.setHeader('Content-Type', image.contentType);
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(image.body);
  }),
);
