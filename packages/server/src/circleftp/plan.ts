/**
 * Turns a Circle FTP post into the concrete list of files to download and the
 * paths they land at. Ported from `circleftp_core.py::build_plan`.
 *
 * The layout is what Jellyfin's scanner expects:
 *   movies : "<Name (Year)>/<file>"
 *   series : "<Name (Year)>/Season 01/<Show> S01E02 - <file>"
 */
import { firstYear, filenameFromUrl, folderTitle, parseEpisodeNumber, parseSeasonNumber, sanitize, seasonMatches } from './text.js';
import type { RawPart, RawPost, RawSeason } from './types.js';

export interface PlannedFile {
  url: string;
  /** Path relative to the title folder. Always uses forward slashes. */
  relPath: string;
  label: string;
  season: string | null;
  episode: number | null;
}

export interface SeasonSummary {
  name: string;
  number: number | null;
  episodeCount: number;
}

export interface DownloadPlan {
  /** Destination folder name, e.g. "Inception (2010)". */
  folder: string;
  files: PlannedFile[];
  /** Every season the post offers — not just the selected ones. */
  seasons: SeasonSummary[];
  type: string;
}

/** Already contains an SxxEyy marker, so prefixing one would be noise. */
const HAS_EPISODE_MARKER = /\bs\d{1,3}\s*[._ -]?e\d{1,4}\b/i;

/**
 * Build the download plan.
 *
 * `wantedSeasons` filters series content by season name or number; an empty
 * list means every season. It never affects the reported `seasons` list, so the
 * UI can still show what was not selected.
 */
export function buildPlan(post: RawPost, wantedSeasons: readonly string[] = []): DownloadPlan {
  const type = String(post.type ?? '');
  const folder = folderTitle(post);
  const show = sanitize(post.name ?? post.title ?? '', 'Show');
  const files: PlannedFile[] = [];
  const seasons: SeasonSummary[] = [];

  if (type === 'series') {
    const rawSeasons = Array.isArray(post.content) ? (post.content as RawSeason[]) : [];

    for (const season of rawSeasons) {
      if (!season || typeof season !== 'object') continue;

      const seasonName = String(season.seasonName ?? '').trim();
      const seasonNumber = parseSeasonNumber(seasonName);
      const episodes = (season.episodes ?? []).filter((episode) => Boolean(episode?.link));

      seasons.push({
        name: seasonName || `Season ${seasons.length + 1}`,
        number: seasonNumber,
        episodeCount: episodes.length,
      });

      if (!seasonMatches(seasonName, seasonNumber, wantedSeasons)) continue;

      const seasonDir =
        seasonNumber !== null
          ? `Season ${String(seasonNumber).padStart(2, '0')}`
          : sanitize(seasonName, 'Season 01');

      episodes.forEach((episode, index) => {
        const url = String(episode.link).trim();
        const label = String(episode.title ?? '').trim();
        const episodeNumber = parseEpisodeNumber(label, index + 1);

        let filename = filenameFromUrl(url, label || `episode ${index + 1}`);
        // Jellyfin needs SxxEyy to place an episode. Many uploads already carry
        // it; only add the prefix when the filename lacks one.
        if (!HAS_EPISODE_MARKER.test(filename) && seasonNumber !== null) {
          const marker = `S${String(seasonNumber).padStart(2, '0')}E${String(episodeNumber).padStart(2, '0')}`;
          filename = `${show} ${marker} - ${filename}`;
        }

        files.push({
          url,
          relPath: `${seasonDir}/${filename}`,
          label: label || filename,
          season: seasonName || seasonDir,
          episode: episodeNumber,
        });
      });
    }
  } else if (type === 'singleVideo' || type === 'singleFile') {
    if (typeof post.content === 'string' && post.content.trim()) {
      const url = post.content.trim();
      files.push({
        url,
        relPath: filenameFromUrl(url, folder),
        label: String(post.title ?? folder),
        season: null,
        episode: null,
      });
    }
  } else if (type === 'multiVideo' || type === 'multiFile') {
    const parts = Array.isArray(post.content) ? (post.content as RawPart[]) : [];
    parts.forEach((part, index) => {
      if (!part?.link) return;
      const url = String(part.link).trim();
      const label = String(part.title ?? `part ${index + 1}`);
      files.push({
        url,
        relPath: filenameFromUrl(url, label),
        label,
        season: null,
        episode: null,
      });
    });
  } else if (typeof post.content === 'string' && post.content.startsWith('http')) {
    // Unknown type with a usable URL: be generous rather than dropping it.
    const url = post.content.trim();
    files.push({
      url,
      relPath: filenameFromUrl(url, folder),
      label: folder,
      season: null,
      episode: null,
    });
  }

  return { folder, files: deduplicatePaths(files), seasons, type };
}

/**
 * Two episodes can resolve to the same filename (identical upload names in
 * different seasons, or repeated parts). Suffix the later ones so nothing
 * silently overwrites anything.
 */
function deduplicatePaths(files: PlannedFile[]): PlannedFile[] {
  const seen = new Map<string, number>();

  for (const file of files) {
    const count = seen.get(file.relPath);
    if (count === undefined) {
      seen.set(file.relPath, 1);
      continue;
    }
    const next = count + 1;
    seen.set(file.relPath, next);

    const dot = file.relPath.lastIndexOf('.');
    const slash = file.relPath.lastIndexOf('/');
    // Only treat a dot in the final segment as an extension separator.
    const hasExtension = dot > slash && dot !== -1;
    file.relPath = hasExtension
      ? `${file.relPath.slice(0, dot)} (${next})${file.relPath.slice(dot)}`
      : `${file.relPath} (${next})`;
  }

  return files;
}

/** Plot summary and other display fields, normalised for the title page. */
export function describePost(post: RawPost): {
  name: string;
  title: string;
  year: string | null;
  quality: string;
  watchTime: string | null;
  description: string | null;
} {
  return {
    name: String(post.name ?? post.title ?? 'Untitled'),
    title: String(post.title ?? post.name ?? 'Untitled'),
    year: post.year ? String(post.year) : firstYear(post.title),
    quality: String(post.quality ?? ''),
    watchTime: post.watchTime ? String(post.watchTime) : null,
    description: post.metaData ? String(post.metaData) : null,
  };
}
