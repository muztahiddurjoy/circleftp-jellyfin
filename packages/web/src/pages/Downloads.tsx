/**
 * The download queue, updating live from the SSE stream.
 *
 * No polling and no manual refresh: the list here is whatever the server last
 * pushed.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';

import type { DownloadDto } from '@cfj/shared';
import { humanDuration, humanSize, humanSpeed, isTerminalStatus, percentComplete } from '@cfj/shared';

import { ApiRequestError, api, query } from '../api/client';
import { EmptyState, Poster, ProgressBar, StatusBadge } from '../components/common';
import { useDownloads } from '../hooks/useDownloads';
import { useToasts } from '../hooks/useToasts';

type Filter = 'all' | 'active' | 'done';

const FILTERS: { value: Filter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'done', label: 'Finished' },
];

export function DownloadsPage(): JSX.Element {
  const { downloads, connected, refresh } = useDownloads();
  const [filter, setFilter] = useState<Filter>('all');

  const visible = downloads.filter((download) => {
    if (filter === 'active') return !isTerminalStatus(download.status);
    if (filter === 'done') return isTerminalStatus(download.status);
    return true;
  });

  return (
    <div className="page">
      <h1 className="page__title">Downloads</h1>
      <p className="page__subtitle">
        {connected ? (
          'Progress updates live.'
        ) : (
          <span style={{ color: 'var(--warn)' }}>Reconnecting to the live feed…</span>
        )}
      </p>

      <div className="search">
        <div className="filters" role="group" aria-label="Filter downloads">
          {FILTERS.map((option) => (
            <button
              key={option.value}
              type="button"
              className={
                filter === option.value
                  ? 'filters__option filters__option--active'
                  : 'filters__option'
              }
              aria-pressed={filter === option.value}
              onClick={() => setFilter(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      {visible.length === 0 ? (
        <EmptyState icon="📭" title={filter === 'all' ? 'Nothing queued yet' : 'Nothing here'}>
          <Link to="/" className="button button--ghost button--small" style={{ marginTop: 14 }}>
            Find something to download
          </Link>
        </EmptyState>
      ) : (
        visible.map((download) => (
          <JobCard key={download.id} download={download} onChanged={refresh} />
        ))
      )}
    </div>
  );
}

function JobCard({
  download,
  onChanged,
}: {
  download: DownloadDto;
  onChanged: () => Promise<void>;
}): JSX.Element {
  const { notify } = useToasts();
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);

  const percent = percentComplete(download.downloadedBytes, download.totalBytes);
  const running = download.status === 'RUNNING';
  const active = !isTerminalStatus(download.status);
  // A running job with no known total gets an indeterminate bar rather than a
  // bar stuck at 0% that looks broken.
  const indeterminate = running && download.totalBytes === null;

  async function act(
    action: () => Promise<unknown>,
    successMessage: string,
    confirmMessage?: string,
  ): Promise<void> {
    if (confirmMessage && !window.confirm(confirmMessage)) return;
    setBusy(true);
    try {
      await action();
      notify(successMessage, 'success');
      await onChanged();
    } catch (error) {
      notify(
        error instanceof ApiRequestError ? error.message : 'That did not work',
        'error',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="job">
      <div className="job__head">
        <Poster src={download.posterUrl} alt="" className="job__poster" />

        <div className="job__info">
          <div className="job__title">
            <Link to={`/title/${download.postId}`}>{download.title}</Link>
          </div>
          <div className="job__sub">
            <StatusBadge status={download.status} />{' '}
            {download.seasons.length > 0 ? `${download.seasons.join(', ')} · ` : ''}
            {download.completedFileCount}/{download.fileCount} files
            {download.requestedBy ? ` · ${download.requestedBy.name}` : ''}
          </div>
        </div>

        <div className="job__actions">
          {active ? (
            <button
              className="button button--ghost button--small"
              type="button"
              disabled={busy}
              onClick={() => act(() => api.post(`/downloads/${download.id}/cancel`), 'Cancelled')}
            >
              Cancel
            </button>
          ) : null}

          {!active && download.status !== 'COMPLETED' ? (
            <button
              className="button button--small"
              type="button"
              disabled={busy}
              onClick={() => act(() => api.post(`/downloads/${download.id}/retry`), 'Retrying')}
            >
              Retry
            </button>
          ) : null}

          {!active ? (
            <button
              className="button button--danger button--small"
              type="button"
              disabled={busy}
              onClick={() =>
                act(
                  () => api.delete(`/downloads/${download.id}${query({ deleteFiles: 'true' })}`),
                  'Removed',
                  `Remove “${download.title}” and delete its files from disk?`,
                )
              }
            >
              Delete
            </button>
          ) : null}
        </div>
      </div>

      <div className="progress">
        <ProgressBar percent={percent} status={download.status} indeterminate={indeterminate} />
        <div className="progress__meta">
          <span>
            {humanSize(download.downloadedBytes)}
            {download.totalBytes !== null ? ` of ${humanSize(download.totalBytes)}` : ''}
            {!indeterminate && download.totalBytes !== null ? ` · ${percent}%` : ''}
          </span>
          <span>
            {running && download.speedBps
              ? `${humanSpeed(download.speedBps)}${
                  download.etaSeconds !== null ? ` · ${humanDuration(download.etaSeconds)} left` : ''
                }`
              : download.finishedAt
                ? new Date(download.finishedAt).toLocaleString()
                : ''}
          </span>
        </div>
      </div>

      {download.error ? <div className="job__error">{download.error}</div> : null}

      {download.files && download.files.length > 1 ? (
        <>
          <button className="disclosure" type="button" onClick={() => setExpanded(!expanded)}>
            {expanded ? '▾ Hide' : '▸ Show'} {download.files.length} files
          </button>
          {expanded ? (
            <div className="job__files">
              {download.files.map((file) => (
                <div className="job__file" key={file.id}>
                  <StatusBadge status={file.status as never} />
                  <span className="job__file-name" title={file.relPath}>
                    {file.relPath}
                  </span>
                  <span className="job__file-size">
                    {file.status === 'RUNNING' && file.sizeBytes
                      ? `${percentComplete(file.downloadedBytes, file.sizeBytes)}%`
                      : humanSize(file.sizeBytes)}
                  </span>
                </div>
              ))}
            </div>
          ) : null}
        </>
      ) : null}
    </article>
  );
}
