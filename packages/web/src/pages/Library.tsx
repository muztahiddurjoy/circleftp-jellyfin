/**
 * The library — a search-driven proxy of Circle FTP.
 *
 * Circle FTP has no browsable index, only a search endpoint, so the page opens
 * on a prompt rather than a listing.
 */
import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';

import type { SearchResultDto, TitleKind } from '@cfj/shared';

import { api, query } from '../api/client';
import { CardSkeletons, EmptyState, Poster } from '../components/common';

type KindFilter = 'any' | TitleKind;

const FILTERS: { value: KindFilter; label: string }[] = [
  { value: 'any', label: 'All' },
  { value: 'movie', label: 'Movies' },
  { value: 'series', label: 'Series' },
];

export function LibraryPage(): JSX.Element {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();

  // The URL is the source of truth, so a search can be linked and survives
  // navigating into a title and back.
  const searchTerm = params.get('q') ?? '';
  const kind = (params.get('kind') as KindFilter | null) ?? 'any';

  const [draft, setDraft] = useState(searchTerm);
  useEffect(() => setDraft(searchTerm), [searchTerm]);

  const results = useQuery({
    queryKey: ['search', searchTerm, kind],
    enabled: searchTerm.trim().length > 0,
    // Keeps the previous grid on screen while a new search runs, instead of
    // flashing back to skeletons on every keystroke-driven refetch.
    placeholderData: keepPreviousData,
    staleTime: 60_000,
    queryFn: ({ signal }) =>
      api.get<{ results: SearchResultDto[] }>(
        `/library/search${query({ q: searchTerm, kind, limit: 36 })}`,
        signal,
      ),
  });

  function submit(event: FormEvent): void {
    event.preventDefault();
    const next = draft.trim();
    if (!next) return;
    setParams({ q: next, ...(kind !== 'any' ? { kind } : {}) });
  }

  function setKind(next: KindFilter): void {
    setParams(searchTerm ? { q: searchTerm, ...(next !== 'any' ? { kind: next } : {}) } : {});
  }

  return (
    <div className="page">
      <h1 className="page__title">Library</h1>
      <p className="page__subtitle">Search Circle FTP and send anything straight to Jellyfin.</p>

      <form className="search" onSubmit={submit} role="search">
        <input
          className="input search__input"
          type="search"
          placeholder="Search for a movie or series…"
          aria-label="Search Circle FTP"
          value={draft}
          autoFocus
          onChange={(event) => setDraft(event.target.value)}
        />
        <div className="filters" role="group" aria-label="Filter by type">
          {FILTERS.map((filter) => (
            <button
              key={filter.value}
              type="button"
              className={
                kind === filter.value ? 'filters__option filters__option--active' : 'filters__option'
              }
              aria-pressed={kind === filter.value}
              onClick={() => setKind(filter.value)}
            >
              {filter.label}
            </button>
          ))}
        </div>
        <button className="button" type="submit" disabled={!draft.trim()}>
          Search
        </button>
      </form>

      {!searchTerm ? (
        <EmptyState icon="🔍" title="Search to get started">
          Try a title like <em>Inception</em>, <em>Breaking Bad</em> or <em>Dune</em>.
        </EmptyState>
      ) : results.isLoading ? (
        <CardSkeletons />
      ) : results.isError ? (
        <EmptyState icon="⚠️" title="Search failed" error>
          {results.error instanceof Error ? results.error.message : 'Something went wrong'}
        </EmptyState>
      ) : (results.data?.results.length ?? 0) === 0 ? (
        <EmptyState icon="🕳️" title={`Nothing found for “${searchTerm}”`}>
          Circle FTP matches on title words — try a shorter or differently spelled query.
        </EmptyState>
      ) : (
        <>
          <p className="page__subtitle" aria-live="polite">
            {results.data!.results.length} result
            {results.data!.results.length === 1 ? '' : 's'} for “{searchTerm}”
          </p>
          <div className="grid">
            {results.data!.results.map((result) => (
              <TitleCard
                key={result.postId}
                result={result}
                onOpen={() => navigate(`/title/${result.postId}`)}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function TitleCard({
  result,
  onOpen,
}: {
  result: SearchResultDto;
  onOpen: () => void;
}): JSX.Element {
  const meta = [
    result.year,
    result.kind === 'series' && result.seasonCount
      ? `${result.seasonCount} season${result.seasonCount === 1 ? '' : 's'}`
      : result.quality,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <article
      className="card"
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onOpen();
        }
      }}
      tabIndex={0}
      role="button"
      aria-label={`${result.name}${result.year ? `, ${result.year}` : ''}`}
    >
      <div className="card__poster">
        <Poster src={result.posterUrl} alt="" />
        {result.kind === 'series' ? <span className="card__tag">Series</span> : null}
      </div>
      <div className="card__body">
        <div className="card__name">{result.name}</div>
        <div className="card__meta">{meta || result.category}</div>
      </div>
    </article>
  );
}
