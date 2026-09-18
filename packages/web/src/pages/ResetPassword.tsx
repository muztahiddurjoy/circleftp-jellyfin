/**
 * Redeeming an admin-issued reset link.
 *
 * The token in the URL is the credential, so this page is unauthenticated. It
 * checks the link before showing the form — a dead link should say why rather
 * than failing after the user has typed a password twice.
 */
import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';

import type { UserDto } from '@cfj/shared';

import { ApiRequestError, api, query } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { Spinner } from '../components/common';

interface ResetCheck {
  valid: boolean;
  reason?: string;
  userName?: string;
  userEmail?: string;
}

export function ResetPasswordPage(): JSX.Element {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const { setUser } = useAuth();

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [done, setDone] = useState(false);

  const check = useQuery({
    queryKey: ['reset-check', token],
    enabled: token.length > 0,
    retry: false,
    queryFn: () => api.get<ResetCheck>(`/account/reset/check${query({ token })}`),
  });

  const submit = useMutation({
    mutationFn: () => api.post<{ user: UserDto }>('/account/reset', { token, newPassword: password }),
    onSuccess: (result) => {
      // The server signs them in as part of redeeming, so adopt that session
      // rather than bouncing them to a login form they have just proven past.
      setUser(result.user);
      setDone(true);
    },
  });

  if (done) return <Navigate to="/" replace />;

  if (!token) {
    return (
      <ResetShell title="Reset your password">
        <div className="auth__error">This link is missing its token.</div>
        <p className="auth__footer">
          Ask an administrator for a new reset link. <Link to="/login">Back to sign in</Link>
        </p>
      </ResetShell>
    );
  }

  if (check.isLoading) {
    return (
      <ResetShell title="Reset your password">
        <p className="auth__tagline">Checking your link…</p>
      </ResetShell>
    );
  }

  if (check.isError || !check.data?.valid) {
    return (
      <ResetShell title="That link cannot be used">
        <div className="auth__error">
          {check.data?.reason ?? 'This reset link is not valid.'}
        </div>
        <p className="auth__footer">
          Reset links are single-use and expire. Ask an administrator for a new one.{' '}
          <Link to="/login">Back to sign in</Link>
        </p>
      </ResetShell>
    );
  }

  const mismatch = confirm.length > 0 && password !== confirm;
  const canSubmit = password.length >= 10 && password === confirm && !submit.isPending;

  return (
    <ResetShell title="Choose a new password">
      <p className="auth__tagline">
        For {check.data.userName} ({check.data.userEmail})
      </p>

      {submit.isError ? (
        <div className="auth__error" role="alert">
          {submit.error instanceof ApiRequestError
            ? submit.error.message
            : 'Could not set your password'}
        </div>
      ) : null}

      <form
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          if (canSubmit) submit.mutate();
        }}
      >
        <div className="field">
          <label className="field__label" htmlFor="reset-password">
            New password
          </label>
          <input
            id="reset-password"
            className="input"
            type="password"
            autoComplete="new-password"
            autoFocus
            required
            minLength={10}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          <p className="hint">At least 10 characters</p>
        </div>

        <div className="field">
          <label className="field__label" htmlFor="reset-confirm">
            Confirm new password
          </label>
          <input
            id="reset-confirm"
            className={mismatch ? 'input input--error' : 'input'}
            type="password"
            autoComplete="new-password"
            required
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
          />
          {mismatch ? <div className="field__error">Passwords do not match</div> : null}
        </div>

        <button className="button button--block" type="submit" disabled={!canSubmit}>
          {submit.isPending ? <Spinner /> : null}
          Set password and sign in
        </button>
      </form>

      <p className="auth__footer">
        This signs you out on every other device.
      </p>
    </ResetShell>
  );
}

function ResetShell({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div className="auth">
      <div className="auth__card">
        <div className="auth__brand">
          <span className="header__mark" aria-hidden="true">
            ▶
          </span>
          {title}
        </div>
        {children}
      </div>
    </div>
  );
}
