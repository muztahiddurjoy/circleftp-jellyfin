import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link, Navigate, useLocation } from 'react-router-dom';

import { ApiRequestError } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { Spinner } from '../components/common';

export function LoginPage(): JSX.Element {
  const { user, loading, login } = useAuth();
  const location = useLocation();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (loading) return <div className="auth" />;
  if (user) {
    // Send the user back where they were headed before the redirect to login.
    const from = (location.state as { from?: string } | null)?.from ?? '/';
    return <Navigate to={from} replace />;
  }

  async function onSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login(email, password);
    } catch (caught) {
      setError(
        caught instanceof ApiRequestError ? caught.message : 'Something went wrong. Try again.',
      );
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
          Circle FTP → Jellyfin
        </div>
        <p className="auth__tagline">Sign in to browse and queue downloads</p>

        {error ? (
          <div className="auth__error" role="alert">
            {error}
          </div>
        ) : null}

        <div className="field">
          <label className="field__label" htmlFor="email">
            Email
          </label>
          <input
            id="email"
            className="input"
            type="email"
            autoComplete="username"
            required
            autoFocus
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </div>

        <div className="field">
          <label className="field__label" htmlFor="password">
            Password
          </label>
          <input
            id="password"
            className="input"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </div>

        <button className="button button--block" type="submit" disabled={submitting}>
          {submitting ? <Spinner /> : null}
          {submitting ? 'Signing in…' : 'Sign in'}
        </button>

        <p className="auth__footer">
          Have an invite code? <Link to="/invite">Create an account</Link>
        </p>
        <p className="auth__footer" style={{ marginTop: 8 }}>
          {/*
            No mail server is configured, so there is no self-service reset.
            An admin issues a one-time link instead.
          */}
          Forgotten your password? Ask an administrator to send you a reset link.
        </p>
      </form>
    </div>
  );
}
