/** Transient notifications for action outcomes. */
import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

type ToastKind = 'success' | 'error' | 'info';

interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
}

interface ToastState {
  notify: (message: string, kind?: ToastKind) => void;
}

const ToastContext = createContext<ToastState | null>(null);

let nextId = 1;

export function ToastProvider({ children }: { children: ReactNode }): JSX.Element {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const notify = useCallback((message: string, kind: ToastKind = 'info') => {
    const id = nextId++;
    setToasts((current) => [...current, { id, kind, message }]);
    // Errors linger a little longer, since they usually need reading.
    setTimeout(() => {
      setToasts((current) => current.filter((toast) => toast.id !== id));
    }, kind === 'error' ? 6000 : 3500);
  }, []);

  const value = useMemo<ToastState>(() => ({ notify }), [notify]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast toast--${toast.kind}`}>
            {toast.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToasts(): ToastState {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToasts must be used inside a ToastProvider');
  return context;
}
