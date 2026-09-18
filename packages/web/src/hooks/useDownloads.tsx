/**
 * Live download state, fed by the server's SSE stream.
 *
 * One EventSource for the whole app, held at the provider, so every page reads
 * the same live list rather than opening its own connection or polling.
 */
import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import type { DownloadDto, ServerEvent } from '@cfj/shared';
import { isActiveStatus } from '@cfj/shared';

import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';

interface DownloadsState {
  downloads: DownloadDto[];
  activeCount: number;
  /** False while the stream is down; the UI shows a reconnecting hint. */
  connected: boolean;
  /** Pull a fresh list, for actions whose effect is not streamed. */
  refresh: () => Promise<void>;
}

const DownloadsContext = createContext<DownloadsState | null>(null);

export function DownloadsProvider({ children }: { children: ReactNode }): JSX.Element {
  const { user } = useAuth();
  const [downloads, setDownloads] = useState<DownloadDto[]>([]);
  const [connected, setConnected] = useState(false);
  const sourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (!user) {
      // Signed out: drop the stream and the data with it.
      sourceRef.current?.close();
      sourceRef.current = null;
      setDownloads([]);
      setConnected(false);
      return;
    }

    const source = new EventSource('/api/events', { withCredentials: true });
    sourceRef.current = source;

    source.onopen = () => setConnected(true);

    source.onmessage = (message: MessageEvent<string>) => {
      let event: ServerEvent;
      try {
        event = JSON.parse(message.data) as ServerEvent;
      } catch {
        return; // A malformed frame is not worth tearing the stream down for.
      }
      setDownloads((current) => applyEvent(current, event));
    };

    source.onerror = () => {
      // EventSource reconnects on its own; just reflect the gap in the UI.
      setConnected(false);
    };

    return () => {
      source.close();
      sourceRef.current = null;
    };
  }, [user]);

  const refresh = useMemo(
    () => async () => {
      const result = await api.get<{ downloads: DownloadDto[] }>('/downloads?status=all&limit=100');
      setDownloads(result.downloads);
    },
    [],
  );

  const value = useMemo<DownloadsState>(
    () => ({
      downloads,
      activeCount: downloads.filter((download) => isActiveStatus(download.status)).length,
      connected,
      refresh,
    }),
    [downloads, connected, refresh],
  );

  return <DownloadsContext.Provider value={value}>{children}</DownloadsContext.Provider>;
}

/** Fold one server event into the current list. */
function applyEvent(current: DownloadDto[], event: ServerEvent): DownloadDto[] {
  switch (event.type) {
    case 'snapshot':
      return event.downloads;

    case 'download:created':
      return [event.download, ...current.filter((item) => item.id !== event.download.id)];

    case 'download:progress':
    case 'download:finished': {
      const index = current.findIndex((item) => item.id === event.download.id);
      // An update for something we have not seen (a job created in another tab)
      // is an insert, not a no-op.
      if (index === -1) return [event.download, ...current];
      const next = [...current];
      next[index] = event.download;
      return next;
    }

    case 'download:deleted':
      return current.filter((item) => item.id !== event.id);

    default:
      return current;
  }
}

export function useDownloads(): DownloadsState {
  const context = useContext(DownloadsContext);
  if (!context) throw new Error('useDownloads must be used inside a DownloadsProvider');
  return context;
}
