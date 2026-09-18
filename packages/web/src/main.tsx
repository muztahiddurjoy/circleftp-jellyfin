import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { App } from './App';
import { ApiRequestError } from './api/client';
import { AuthProvider } from './auth/AuthContext';
import { ToastProvider } from './hooks/useToasts';
import './styles.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Refetching on every tab focus would re-hit Circle FTP constantly for no
      // benefit — search results do not change minute to minute.
      refetchOnWindowFocus: false,
      retry: (failureCount, error) => {
        // Never retry an auth or client error; the answer will not change.
        if (error instanceof ApiRequestError && error.status > 0 && error.status < 500) return false;
        return failureCount < 2;
      },
    },
  },
});

const container = document.getElementById('root');
if (!container) throw new Error('Root element is missing from index.html');

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <ToastProvider>
            <App />
          </ToastProvider>
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
