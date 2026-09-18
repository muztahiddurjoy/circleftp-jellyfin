import { Navigate, NavLink, Outlet, Route, Routes, useLocation } from 'react-router-dom';

import { useAuth } from './auth/AuthContext';
import { EmptyState } from './components/common';
import { DownloadsProvider, useDownloads } from './hooks/useDownloads';
import { DownloadsPage } from './pages/Downloads';
import { InvitePage } from './pages/Invite';
import { LibraryPage } from './pages/Library';
import { LoginPage } from './pages/Login';
import { TitlePage } from './pages/Title';

export function App(): JSX.Element {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/invite" element={<InvitePage />} />
      <Route element={<ProtectedShell />}>
        <Route path="/" element={<LibraryPage />} />
        <Route path="/title/:postId" element={<TitlePage />} />
        <Route path="/downloads" element={<DownloadsPage />} />
      </Route>
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}

/** Everything inside here requires a session and gets the live download feed. */
function ProtectedShell(): JSX.Element {
  const { user, loading } = useAuth();
  const location = useLocation();

  // Wait for /auth/me before deciding, or a reload would bounce a signed-in
  // user to the login page for a frame.
  if (loading) {
    return (
      <div className="app-shell">
        <EmptyState icon="⏳" title="Loading…" />
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }

  return (
    <DownloadsProvider>
      <div className="app-shell">
        <Header />
        <Outlet />
      </div>
    </DownloadsProvider>
  );
}

function Header(): JSX.Element {
  const { user, logout } = useAuth();
  const { activeCount } = useDownloads();

  const linkClass = ({ isActive }: { isActive: boolean }): string =>
    isActive ? 'header__link header__link--active' : 'header__link';

  return (
    <header className="header">
      <div className="header__brand">
        <span className="header__mark" aria-hidden="true">
          ▶
        </span>
        <span>Circle FTP → Jellyfin</span>
      </div>

      <nav className="header__nav">
        <NavLink to="/" className={linkClass} end>
          Library
        </NavLink>
        <NavLink to="/downloads" className={linkClass}>
          Downloads
          {activeCount > 0 ? <span className="header__badge">{activeCount}</span> : null}
        </NavLink>
      </nav>

      <div className="header__spacer" />

      <div className="header__user">
        <span>{user?.name}</span>
        <button className="button button--ghost button--small" type="button" onClick={() => void logout()}>
          Sign out
        </button>
      </div>
    </header>
  );
}

function NotFound(): JSX.Element {
  return (
    <div className="page">
      <EmptyState icon="🧭" title="Page not found">
        <NavLink to="/" className="button button--ghost button--small">
          Back to the library
        </NavLink>
      </EmptyState>
    </div>
  );
}
