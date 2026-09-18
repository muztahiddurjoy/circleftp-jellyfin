/**
 * Your own account: display name, password, and the sessions you have open.
 */
import { useState } from 'react';
import type { FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { UserDto } from '@cfj/shared';

import { ApiRequestError, api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { Spinner } from '../components/common';
import { useToasts } from '../hooks/useToasts';

interface SessionRow {
  id: string;
  userAgent: string | null;
  ip: string | null;
  createdAt: string;
  expiresAt: string;
}

export function AccountPage(): JSX.Element {
  const { user } = useAuth();

  return (
    <div className="page">
      <h1 className="page__title">Your account</h1>
      <p className="page__subtitle">
        Signed in as {user?.email}
        {user?.role === 'ADMIN' ? ' · administrator' : ''}
      </p>

      <div className="stack">
        <ProfilePanel />
        <PasswordPanel />
        <SessionsPanel />
      </div>
    </div>
  );
}

function ProfilePanel(): JSX.Element {
  const { user, refreshUser } = useAuth();
  const { notify } = useToasts();
  const [name, setName] = useState(user?.name ?? '');

  const save = useMutation({
    mutationFn: () => api.patch<{ user: UserDto }>('/account/profile', { name: name.trim() }),
    onSuccess: async () => {
      notify('Name updated', 'success');
      await refreshUser();
    },
    onError: (error: unknown) =>
      notify(error instanceof ApiRequestError ? error.message : 'Could not save', 'error'),
  });

  const unchanged = name.trim() === (user?.name ?? '') || name.trim().length === 0;

  return (
    <section className="panel">
      <h2 className="panel__title">Display name</h2>
      <form
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          if (!unchanged) save.mutate();
        }}
      >
        <div className="field">
          <input
            className="input"
            value={name}
            maxLength={80}
            onChange={(event) => setName(event.target.value)}
            aria-label="Display name"
          />
          <p className="hint">Shown next to downloads you request.</p>
        </div>
        <button className="button" type="submit" disabled={unchanged || save.isPending}>
          {save.isPending ? <Spinner /> : null}
          Save
        </button>
      </form>
    </section>
  );
}

function PasswordPanel(): JSX.Element {
  const { notify } = useToasts();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<ApiRequestError | null>(null);

  const change = useMutation({
    mutationFn: () =>
      api.post('/account/password', { currentPassword: current, newPassword: next }),
    onSuccess: () => {
      notify('Password changed. Other devices have been signed out.', 'success');
      setCurrent('');
      setNext('');
      setConfirm('');
      setError(null);
    },
    onError: (caught: unknown) => {
      if (caught instanceof ApiRequestError) {
        setError(caught);
        if (!caught.details) notify(caught.message, 'error');
      } else {
        notify('Could not change your password', 'error');
      }
    },
  });

  // Checked here as well as server-side so the user finds out before submitting.
  const mismatch = confirm.length > 0 && next !== confirm;
  const tooShort = next.length > 0 && next.length < 10;
  const canSubmit =
    current.length > 0 && next.length >= 10 && next === confirm && !change.isPending;

  return (
    <section className="panel">
      <h2 className="panel__title">Change password</h2>
      <form
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          if (canSubmit) change.mutate();
        }}
      >
        <div className="field">
          <label className="field__label" htmlFor="current-password">
            Current password
          </label>
          <input
            id="current-password"
            className={error?.fieldError('currentPassword') ? 'input input--error' : 'input'}
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(event) => setCurrent(event.target.value)}
          />
          {error?.fieldError('currentPassword') ? (
            <div className="field__error">{error.fieldError('currentPassword')}</div>
          ) : null}
        </div>

        <div className="field">
          <label className="field__label" htmlFor="new-password">
            New password
          </label>
          <input
            id="new-password"
            className={tooShort || error?.fieldError('newPassword') ? 'input input--error' : 'input'}
            type="password"
            autoComplete="new-password"
            value={next}
            onChange={(event) => setNext(event.target.value)}
          />
          <p className={tooShort ? 'field__error' : 'hint'}>
            {error?.fieldError('newPassword') ?? 'At least 10 characters'}
          </p>
        </div>

        <div className="field">
          <label className="field__label" htmlFor="confirm-password">
            Confirm new password
          </label>
          <input
            id="confirm-password"
            className={mismatch ? 'input input--error' : 'input'}
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
          />
          {mismatch ? <div className="field__error">Passwords do not match</div> : null}
        </div>

        <button className="button" type="submit" disabled={!canSubmit}>
          {change.isPending ? <Spinner /> : null}
          Change password
        </button>
        <p className="hint">
          Changing your password signs you out on every other device. This one stays signed in.
        </p>
      </form>
    </section>
  );
}

function SessionsPanel(): JSX.Element {
  const { notify } = useToasts();
  const queryClient = useQueryClient();

  const sessions = useQuery({
    queryKey: ['account', 'sessions'],
    queryFn: () => api.get<{ sessions: SessionRow[] }>('/account/sessions'),
  });

  const revoke = useMutation({
    mutationFn: () => api.post<{ endedCount: number }>('/account/sessions/revoke-others'),
    onSuccess: async (result) => {
      notify(
        result.endedCount === 0
          ? 'No other sessions were open'
          : `Signed out ${result.endedCount} other session${result.endedCount === 1 ? '' : 's'}`,
        'success',
      );
      await queryClient.invalidateQueries({ queryKey: ['account', 'sessions'] });
    },
    onError: () => notify('Could not sign the other sessions out', 'error'),
  });

  const rows = sessions.data?.sessions ?? [];

  return (
    <section className="panel">
      <h2 className="panel__title">Signed-in devices</h2>

      {sessions.isLoading ? (
        <p className="hint">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="hint">No active sessions.</p>
      ) : (
        <div>
          {rows.map((session) => (
            <div className="session-row" key={session.id}>
              <span className="session-row__agent" title={session.userAgent ?? ''}>
                {describeAgent(session.userAgent)}
                {session.ip ? ` · ${session.ip}` : ''}
              </span>
              <span className="session-row__when">
                {new Date(session.createdAt).toLocaleString()}
              </span>
            </div>
          ))}
        </div>
      )}

      <button
        className="button button--ghost"
        type="button"
        style={{ marginTop: 14 }}
        disabled={revoke.isPending || rows.length < 2}
        onClick={() => revoke.mutate()}
      >
        {revoke.isPending ? <Spinner /> : null}
        Sign out other devices
      </button>
    </section>
  );
}

/** Turn a user-agent string into something worth showing in a row. */
function describeAgent(userAgent: string | null): string {
  if (!userAgent) return 'Unknown device';

  const browser =
    /\bEdg\//.test(userAgent) ? 'Edge'
    : /\bOPR\//.test(userAgent) ? 'Opera'
    : /\bFirefox\//.test(userAgent) ? 'Firefox'
    // Chrome's UA also contains "Safari", so Chrome has to be tested first.
    : /\bChrome\//.test(userAgent) ? 'Chrome'
    : /\bSafari\//.test(userAgent) ? 'Safari'
    : /\bcurl\//.test(userAgent) ? 'curl'
    : 'Browser';

  const platform =
    /Android/.test(userAgent) ? 'Android'
    : /iPhone|iPad|iOS/.test(userAgent) ? 'iOS'
    : /Windows/.test(userAgent) ? 'Windows'
    : /Mac OS X|Macintosh/.test(userAgent) ? 'macOS'
    : /Linux/.test(userAgent) ? 'Linux'
    : '';

  return platform ? `${browser} on ${platform}` : browser;
}
