import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router-dom';

import { ApiRequestError } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { Spinner } from '../components/common';

/** Invite redemption — the only way to create an account over HTTP. */
export function InvitePage(): JSX.Element {
  const { user, redeem } = useAuth();
  const [params] = useSearchParams();

  // A shared link can carry the code, saving the recipient a retype.
  const [code, setCode] = useState(params.get('code') ?? '');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<ApiRequestError | Error | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (user) return <Navigate to="/" replace />;

  const fieldError = (field: string): string | undefined =>
    error instanceof ApiRequestError ? error.fieldError(field) : undefined;

  async function onSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await redeem({ code: code.trim().toUpperCase(), name, email, password });
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error('Something went wrong'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="auth">
      <form className="auth__card" onSubmit={onSubmit}>
        <div className="auth__brand">
          <span className="header__mark" aria-hidden="true">
            ▶
          </span>
          Create your account
        </div>
        <p className="auth__tagline">You will need an invite code</p>

        {error && !(error instanceof ApiRequestError && error.details) ? (
          <div className="auth__error" role="alert">
            {error.message}
          </div>
        ) : null}

        <div className="field">
          <label className="field__label" htmlFor="code">
            Invite code
          </label>
          <input
            id="code"
            className={fieldError('code') ? 'input input--error' : 'input'}
            required
            autoFocus
            value={code}
            onChange={(event) => setCode(event.target.value)}
            style={{ fontFamily: 'ui-monospace, monospace', letterSpacing: '0.06em' }}
          />
          {fieldError('code') ? <div className="field__error">{fieldError('code')}</div> : null}
        </div>

        <div className="field">
          <label className="field__label" htmlFor="name">
            Your name
          </label>
          <input
            id="name"
            className={fieldError('name') ? 'input input--error' : 'input'}
            required
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          {fieldError('name') ? <div className="field__error">{fieldError('name')}</div> : null}
        </div>

        <div className="field">
          <label className="field__label" htmlFor="invite-email">
            Email
          </label>
          <input
            id="invite-email"
            className={fieldError('email') ? 'input input--error' : 'input'}
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
          {fieldError('email') ? <div className="field__error">{fieldError('email')}</div> : null}
        </div>

        <div className="field">
          <label className="field__label" htmlFor="invite-password">
            Password
          </label>
          <input
            id="invite-password"
            className={fieldError('password') ? 'input input--error' : 'input'}
            type="password"
            autoComplete="new-password"
            required
            minLength={10}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          <div className="field__error" style={{ color: 'var(--text-faint)' }}>
            {fieldError('password') ?? 'At least 10 characters'}
          </div>
        </div>

        <button className="button button--block" type="submit" disabled={submitting}>
          {submitting ? <Spinner /> : null}
          {submitting ? 'Creating…' : 'Create account'}
        </button>

        <p className="auth__footer">
          Already have an account? <Link to="/login">Sign in</Link>
        </p>
      </form>
    </div>
  );
}
