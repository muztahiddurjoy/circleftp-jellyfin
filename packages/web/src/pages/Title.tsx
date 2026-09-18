/**
 * Title detail — where "Add to Jellyfin" happens.
 *
 * Shows exactly what will be downloaded and where it will land before anything
 * is queued, because a mistaken click here costs gigabytes and an hour.
 */
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';

import type { DownloadDto, TitleDetailDto } from '@cfj/shared';
import { humanSize } from '@cfj/shared';

import { ApiRequestError, api, query } from '../api/client';
import { EmptyState, Poster, Spinner } from '../components/common';
import { useDownloads } from '../hooks/useDownloads';
import { useToasts } from '../hooks/useToasts';

export function TitlePage(): JSX.Element {
  const { postId } = useParams<{ postId: string }>();
  const navigate = useNavigate();
  const { notify } = useToasts();
  const { refresh } = useDownloads();

  /** Season names the user ticked. Empty means "everything". */
  const [selectedSeasons, setSelectedSeasons] = useState<string[]>([]);
  const [probe, setProbe] = useState(false);

  const detail = useQuery({
    queryKey: ['title', postId, selectedSeasons, probe],
    queryFn: ({ signal }) =>
      api.get<TitleDetailDto>(
        `/library/title/${postId}${query({
          probe: probe ? 'true' : undefined,
          seasons: selectedSeasons.length > 0 ? selectedSeasons.join(',') : undefined,
        })}`,
        signal,
      ),
  });

  const add = useMutation({
    mutationFn: () =>
      api.post<DownloadDto>('/downloads', {
        postId: Number(postId),
        ...(selectedSeasons.length > 0 ? { seasons: selectedSeasons } : {}),
      }),
    onSuccess: async (download) => {
      notify(`“${download.title}” added to the queue`, 'success');
      await refresh();
      navigate('/downloads');
    },
    onError: (error: unknown) => {
      const message =
        error instanceof ApiRequestError ? error.message : 'Could not queue that download';
      notify(message, 'error');
      // An "already queued" conflict means the answer is on the Downloads page.
      if (error instanceof ApiRequestError && error.code === 'already_queued') {
        navigate('/downloads');
      }
    },
  });

  if (detail.isLoading) {
    return (
      <div className="page">
        <EmptyState icon="⏳" title="Loading title…" />
      </div>
    );
  }

  if (detail.isError || !detail.data) {
    return (
      <div className="page">
        <EmptyState icon="⚠️" title="Could not load that title" error>
          {detail.error instanceof Error ? detail.error.message : 'Unknown error'}
          <p>
            <Link to="/" className="button button--ghost button--small" style={{ marginTop: 14 }}>
              Back to library
            </Link>
          </p>
        </EmptyState>
      </div>
    );
  }

  const title = detail.data;
  const isSeries = title.kind === 'series' && title.seasons.length > 0;

  function toggleSeason(name: string): void {
    setSelectedSeasons((current) =>
      current.includes(name) ? current.filter((item) => item !== name) : [...current, name],
    );
  }

  const totalEpisodes = title.seasons.reduce((sum, season) => sum + season.episodeCount, 0);

  return (
    <div className="page">
      <Link to="/" className="button button--ghost button--small" style={{ marginBottom: 20 }}>
        ← Library
      </Link>

      <div className="title-layout">
        <div className="title-poster">
          <Poster src={title.posterUrl} alt={`Poster for ${title.name}`} />
        </div>

        <div>
          <h1 className="page__title">{title.name}</h1>

          <div className="title-meta">
            {title.year ? <span className="chip">{title.year}</span> : null}
            <span className="chip">{title.kind === 'series' ? 'Series' : 'Movie'}</span>
            {title.quality ? <span className="chip">{title.quality}</span> : null}
            {title.watchTime ? <span className="chip">{title.watchTime}</span> : null}
            {title.category ? <span className="chip">{title.category}</span> : null}
          </div>

          {title.description ? <p className="title-overview">{title.description}</p> : null}

          {title.alreadyQueued ? (
            <div className="panel" style={{ borderColor: 'var(--accent)' }}>
              <p style={{ margin: 0 }}>
                This title is already in the queue.{' '}
                <Link to="/downloads" style={{ color: 'var(--accent)' }}>
                  View progress →
                </Link>
              </p>
            </div>
          ) : null}

          {isSeries ? (
            <div className="panel">
              <h2 className="panel__title">
                Seasons
                <span style={{ color: 'var(--text-faint)', fontWeight: 400 }}>
                  {' '}
                  — {selectedSeasons.length === 0
                    ? `all ${title.seasons.length}, ${totalEpisodes} episodes`
                    : `${selectedSeasons.length} selected`}
                </span>
              </h2>
              <div className="season-list">
                {title.seasons.map((season) => {
                  const selected = selectedSeasons.includes(season.name);
                  return (
                    <label
                      key={season.name}
                      className={selected ? 'season season--selected' : 'season'}
                    >
                      <input
                        type="checkbox"
                        checked={selected}
                        onChange={() => toggleSeason(season.name)}
                      />
                      <span className="season__name">{season.name}</span>
                      <span className="season__count">
                        {season.episodeCount} episode{season.episodeCount === 1 ? '' : 's'}
                      </span>
                    </label>
                  );
                })}
              </div>
              <p style={{ color: 'var(--text-faint)', fontSize: 13, margin: 0 }}>
                Leave everything unticked to download the whole series.
              </p>
            </div>
          ) : null}

          <div className="panel">
            <h2 className="panel__title">
              {title.files.length} file{title.files.length === 1 ? '' : 's'} → {title.folderName}/
              {title.totalSize !== null ? (
                <span style={{ color: 'var(--text-faint)', fontWeight: 400 }}>
                  {' '}
                  — {humanSize(title.totalSize)} total
                </span>
              ) : null}
            </h2>

            {title.files.length === 0 ? (
              <p style={{ color: 'var(--text-dim)', margin: 0 }}>
                Circle FTP lists no downloadable files for this selection.
              </p>
            ) : (
              <div className="file-list">
                {title.files.map((file) => (
                  <div className="file-row" key={file.relPath}>
                    <span className="file-row__path">{file.relPath}</span>
                    <span className="file-row__size">
                      {file.size !== null ? humanSize(file.size) : '—'}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {!probe && title.files.length > 0 ? (
              <button className="disclosure" type="button" onClick={() => setProbe(true)}>
                Check file sizes first (asks the file host — takes a moment)
              </button>
            ) : null}
            {probe && detail.isFetching ? (
              <p style={{ color: 'var(--text-faint)', fontSize: 13, marginBottom: 0 }}>
                Checking sizes…
              </p>
            ) : null}
          </div>

          <div className="actions">
            <button
              className="button"
              type="button"
              disabled={add.isPending || title.files.length === 0 || title.alreadyQueued}
              onClick={() => add.mutate()}
            >
              {add.isPending ? <Spinner /> : null}
              {add.isPending ? 'Adding…' : 'Add to Jellyfin'}
            </button>
            <span style={{ color: 'var(--text-faint)', fontSize: 13 }}>
              Downloads into <code>{title.folderName}/</code>
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
