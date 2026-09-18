/**
 * Search ranking and result normalisation.
 *
 * The upstream API OR-matches every word in the query, so "the batman" returns
 * everything containing "the". The ranking below — and the rule that weak
 * matches are discarded whenever anything better exists — is what makes the
 * results usable. Ported from `circleftp_core.py::CircleFTP.search`.
 */
import type { MatchStrength, SearchResultDto, TitleKind } from '@cfj/shared';

import { fetchPost, rawSearch } from './client.js';
import { firstYear, normalizeText } from './text.js';
import type { RawPost, RawSeason } from './types.js';

/** Circle FTP's `type` field mapped to the coarse kind the UI filters on. */
const TYPE_TO_KIND: Record<string, TitleKind> = {
  series: 'series',
  singleVideo: 'movie',
  multiVideo: 'movie',
  singleFile: 'file',
  multiFile: 'file',
};

/** Ordered best-to-worst; the index is the sort key. */
const MATCH_BY_SCORE: readonly MatchStrength[] = ['exact', 'prefix', 'contains', 'title', 'weak'];
const WEAK_SCORE = 4;

export function kindOf(post: RawPost): TitleKind {
  return TYPE_TO_KIND[String(post.type)] ?? 'file';
}

/**
 * The genre to show on a card. Prefers a "main" category, ignoring the
 * "Featured Post" bucket, which is a placement and not a genre.
 */
export function mainCategory(post: RawPost): string {
  const categories = post.categories ?? [];
  const main = categories
    .filter((category) => category?.type === 'main')
    .map((category) => category.name)
    .filter((name): name is string => Boolean(name) && name!.toLowerCase() !== 'featured post');
  if (main[0]) return main[0];

  const any = categories.map((category) => category?.name).filter((name): name is string => Boolean(name));
  return any[0] ?? '';
}

function scoreOf(post: RawPost, normalizedQuery: string): number {
  const name = normalizeText(post.name ?? '');
  const title = normalizeText(post.title ?? '');
  if (name === normalizedQuery) return 0;
  if (name.startsWith(normalizedQuery)) return 1;
  if (name.includes(normalizedQuery)) return 2;
  if (title.includes(normalizedQuery)) return 3;
  return WEAK_SCORE;
}

/** Path on our own API, so the browser never requests plain-HTTP Circle FTP. */
function posterPath(post: RawPost): string | null {
  const filename = post.image ?? post.imageSm;
  return filename ? `/api/library/image/${encodeURIComponent(filename)}` : null;
}

export function toSearchResult(post: RawPost, match: MatchStrength): SearchResultDto {
  return {
    postId: Number(post.id),
    name: String(post.name ?? post.title ?? 'Untitled'),
    title: String(post.title ?? post.name ?? 'Untitled'),
    year: post.year ? String(post.year) : firstYear(post.title),
    quality: String(post.quality ?? ''),
    kind: kindOf(post),
    type: String(post.type ?? ''),
    category: mainCategory(post),
    watchTime: post.watchTime ? String(post.watchTime) : null,
    posterUrl: posterPath(post),
    match,
  };
}

export interface SearchOptions {
  kind?: 'any' | TitleKind;
  limit?: number;
}

export async function searchTitles(
  query: string,
  options: SearchOptions = {},
): Promise<SearchResultDto[]> {
  const trimmed = query.trim();
  if (trimmed.length === 0) return [];

  const kindFilter = options.kind ?? 'any';
  const limit = Math.max(1, options.limit ?? 24);
  const posts = await rawSearch(trimmed);
  const normalizedQuery = normalizeText(trimmed);

  const scored = posts
    .filter((post) => post?.id !== undefined)
    .filter((post) => kindFilter === 'any' || kindOf(post) === kindFilter)
    // The API's own ordering is the tiebreaker within a score band.
    .map((post, order) => ({ post, order, score: scoreOf(post, normalizedQuery) }))
    .sort((a, b) => a.score - b.score || a.order - b.order);

  const strong = scored.filter((entry) => entry.score < WEAK_SCORE);
  // Keep the noise only when nothing better matched, and then only a little.
  const chosen = strong.length > 0 ? strong : scored.slice(0, 5);

  return chosen
    .slice(0, limit)
    .map((entry) => toSearchResult(entry.post, MATCH_BY_SCORE[entry.score] ?? 'weak'));
}

/**
 * Fill in season and episode counts for series results.
 *
 * Best-effort by design: this needs one detail request per series, so a slow or
 * failing upstream must leave the counts absent rather than fail the search.
 */
export async function enrichSeries(
  results: SearchResultDto[],
  { concurrency = 6, timeoutMs = 10_000 } = {},
): Promise<void> {
  const targets = results.filter((result) => result.kind === 'series' && result.postId);
  if (targets.length === 0) return;

  const deadline = Date.now() + timeoutMs;
  const queue = [...targets];

  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length > 0 && Date.now() < deadline) {
      const result = queue.shift();
      if (!result) return;
      try {
        const post = await fetchPost(result.postId);
        const seasons = Array.isArray(post.content) ? (post.content as RawSeason[]) : [];
        result.seasonCount = seasons.length;
        result.episodeCount = seasons.reduce(
          (total, season) => total + (season?.episodes?.length ?? 0),
          0,
        );
        result.seasonNames = seasons
          .map((season) => String(season?.seasonName ?? ''))
          .filter(Boolean)
          .slice(0, 12);
      } catch {
        // Leave the counts undefined; the card renders without them.
      }
    }
  });

  await Promise.all(workers);
}
