import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';

/**
 * A small dialog. Closes on Escape and on a backdrop click, and takes focus so
 * a keyboard user is not left tabbing around the page behind it.
 */
export function Modal({
  title,
  subtitle,
  onClose,
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
}): JSX.Element {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);

    // Focus the first control, or the panel itself when there is none.
    const focusable = panelRef.current?.querySelector<HTMLElement>(
      'input, select, textarea, button',
    );
    focusable?.focus();

    // Stop the page behind scrolling while the dialog is open.
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose]);

  return (
    <div
      className="modal-backdrop"
      onClick={(event) => {
        // Only a click on the backdrop itself closes, not one that started
        // inside the panel and drifted out.
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="modal" ref={panelRef} role="dialog" aria-modal="true" aria-label={title}>
        <h2 className="modal__title">{title}</h2>
        {subtitle ? <p className="modal__subtitle">{subtitle}</p> : null}
        {children}
      </div>
    </div>
  );
}

/**
 * A value shown exactly once — a generated password or a reset link. Selectable
 * and copyable, because being copied accurately is its whole job.
 */
export function SecretBox({ value, label }: { value: string; label: string }): JSX.Element {
  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // Clipboard access needs a secure context, and this app is reachable over
      // plain HTTP. The value is select-all styled, so copying by hand works.
    }
  }

  return (
    <>
      <div className="secret">
        <code className="secret__value" aria-label={label}>
          {value}
        </code>
        <button className="button button--small" type="button" onClick={() => void copy()}>
          Copy
        </button>
      </div>
      <p className="secret__warning">
        This is shown once. Copy it now — it cannot be retrieved later.
      </p>
    </>
  );
}
