/** Small presentational pieces shared across pages. */
import type { ReactNode } from 'react';

import type { DownloadStatus } from '@cfj/shared';

export function Spinner(): JSX.Element {
  return <span className="spinner" role="status" aria-label="Loading" />;
}

export function EmptyState({
  icon,
  title,
  children,
  error = false,
}: {
  icon: string;
  title: string;
  children?: ReactNode;
  error?: boolean;
}): JSX.Element {
  return (
    <div className={error ? 'state state--error' : 'state'}>
      <div className="state__icon" aria-hidden="true">
        {icon}
      </div>
      <div className="state__title">{title}</div>
      {children ? <div>{children}</div> : null}
    </div>
  );
}

/** Placeholder grid shown while a search is in flight. */
export function CardSkeletons({ count = 12 }: { count?: number }): JSX.Element {
  return (
    <div className="grid" aria-hidden="true">
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="skeleton skeleton--card" />
      ))}
    </div>
  );
}

export function StatusBadge({ status }: { status: DownloadStatus }): JSX.Element {
  return <span className={`status status--${status}`}>{status.toLowerCase()}</span>;
}

/**
 * Progress bar. A job whose total size is unknown gets an indeterminate bar
 * rather than a misleading 0%.
 */
export function ProgressBar({
  percent,
  status,
  indeterminate = false,
}: {
  percent: number;
  status: DownloadStatus;
  indeterminate?: boolean;
}): JSX.Element {
  return (
    <div
      className="progress__bar"
      role="progressbar"
      aria-valuenow={indeterminate ? undefined : percent}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        className={`progress__fill progress__fill--${status}${
          indeterminate ? ' progress__fill--unknown' : ''
        }`}
        style={indeterminate ? undefined : { width: `${percent}%` }}
      />
    </div>
  );
}

/** A poster with a graceful fallback when the image is missing or blocked. */
export function Poster({
  src,
  alt,
  className,
}: {
  src: string | null;
  alt: string;
  className?: string;
}): JSX.Element {
  if (!src) {
    return (
      <div className={`${className ?? ''} card__poster--empty`} aria-hidden="true">
        🎬
      </div>
    );
  }
  return <img src={src} alt={alt} loading="lazy" className={className} />;
}
