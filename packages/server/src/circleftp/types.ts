/**
 * Shapes returned by the Circle FTP JSON API.
 *
 * The API is undocumented — these were reverse-engineered from the site's React
 * bundle and confirmed against live responses. Everything is optional because
 * the server is under no obligation to keep its shape stable, and a missing
 * field must degrade the UI rather than throw.
 */

export interface RawCategory {
  id?: number;
  name?: string;
  /** "main" is the human-facing genre; "sub" is a year/section bucket. */
  type?: string;
  parentId?: number | null;
}

/** One episode inside a season of a `series` post. */
export interface RawEpisode {
  link?: string;
  title?: string;
}

/** One season of a `series` post. */
export interface RawSeason {
  seasonName?: string;
  episodes?: RawEpisode[];
}

/** One part of a `multiVideo` / `multiFile` post. */
export interface RawPart {
  link?: string;
  title?: string;
}

/**
 * `content` is polymorphic and keyed off `type`:
 *   series                    → RawSeason[]
 *   singleVideo | singleFile  → a bare URL string
 *   multiVideo  | multiFile   → RawPart[]
 */
export type RawContent = string | RawSeason[] | RawPart[] | null | undefined;

export interface RawPost {
  id?: number;
  /** Long form, e.g. "Inception (2010) 1080p BluRay Dual Audio". */
  title?: string;
  /** Short form, e.g. "Inception". Absent on some older posts. */
  name?: string;
  type?: string;
  year?: string | number | null;
  quality?: string;
  /** Runtime as free text, e.g. "2h 28m". */
  watchTime?: string;
  /** Plot summary. */
  metaData?: string;
  /** Filename under CIRCLEFTP_IMAGE_BASE. */
  image?: string;
  imageSm?: string;
  cover?: string | null;
  categories?: RawCategory[];
  tags?: string;
  content?: RawContent;
  createdAt?: string;
  updatedAt?: string;
}

export interface RawSearchResponse {
  posts?: RawPost[];
}

/** Raised for any failure talking to Circle FTP. */
export class CircleFtpError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'CircleFtpError';
    this.status = status;
  }
}
