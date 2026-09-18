/**
 * Session state for the whole app.
 *
 * The session lives in an httpOnly cookie the client cannot read, so "am I
 * signed in?" is answered by asking the server once on load and then tracking
 * the result locally.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

import type { UserDto } from '@cfj/shared';

import { ApiRequestError, api } from '../api/client';

interface AuthState {
  user: UserDto | null;
  /** True until the initial `/auth/me` call settles. */
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  redeem: (input: { code: string; name: string; email: string; password: string }) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }): JSX.Element {
  const [user, setUser] = useState<UserDto | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    api
      .get<{ user: UserDto }>('/auth/me')
      .then((result) => {
        if (!cancelled) setUser(result.user);
      })
      .catch(() => {
        // A 401 here is the normal "not signed in" case, not an error worth
        // surfacing — the router will show the login page.
        if (!cancelled) setUser(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const result = await api.post<{ user: UserDto }>('/auth/login', { email, password });
    setUser(result.user);
  }, []);

  const redeem = useCallback(
    async (input: { code: string; name: string; email: string; password: string }) => {
      const result = await api.post<{ user: UserDto }>('/auth/redeem', input);
      setUser(result.user);
    },
    [],
  );

  const logout = useCallback(async () => {
    try {
      await api.post('/auth/logout');
    } catch (error) {
      // Already signed out server-side is a fine outcome for a logout.
      if (!(error instanceof ApiRequestError) || !error.isUnauthenticated) throw error;
    } finally {
      setUser(null);
    }
  }, []);

  const value = useMemo<AuthState>(
    () => ({ user, loading, login, redeem, logout }),
    [user, loading, login, redeem, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside an AuthProvider');
  return context;
}
