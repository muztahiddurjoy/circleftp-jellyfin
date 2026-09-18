/** Presentation helpers shared by the API (log lines) and the web client. */

const SIZE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

/** `2622265717` → `"2.4 GB"`. Whole numbers for B/KB, one decimal above that. */
export function humanSize(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return '—';
  let value = Math.max(0, bytes);
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < SIZE_UNITS.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const unit = SIZE_UNITS[unitIndex] ?? 'B';
  return unitIndex <= 1 ? `${Math.round(value)} ${unit}` : `${value.toFixed(1)} ${unit}`;
}

/** `1500000` → `"1.4 MB/s"`. */
export function humanSpeed(bytesPerSecond: number | null | undefined): string {
  if (!bytesPerSecond || !Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '—';
  return `${humanSize(bytesPerSecond)}/s`;
}

/** `3725` → `"1h 2m"`. Coarse on purpose: this is an ETA, not a stopwatch. */
export function humanDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) {
    return '—';
  }
  const total = Math.floor(seconds);
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m ${total % 60}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** Completion as a 0–100 integer. Unknown totals report 0 rather than NaN. */
export function percentComplete(downloaded: number, total: number | null | undefined): number {
  if (!total || total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((downloaded / total) * 100)));
}
