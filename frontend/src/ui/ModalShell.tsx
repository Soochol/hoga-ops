import { useEffect, type ReactNode } from 'react';

// Shared center-modal chrome: full-screen backdrop, Escape + backdrop-click
// dismissal, and the canon card (bg-card / border-strong / 6px / shadow). The
// optional `title` renders the standard header (title + ✕ 닫기). Callers supply
// the body (and footer) as children. Concentrates the modal dismissal contract
// in one place — consumed by ConfirmModal, LiveSettingsModal, IndicatorPanel.
export function ModalShell({ ariaLabel, title, width = 'w-[640px]', height, onClose, children }: {
  ariaLabel: string;
  title?: string;
  width?: string;
  /** Optional fixed-height classes (e.g. `h-[600px] max-h-[88vh]`). Omit to size
   *  to content. Required when the body has its own `overflow-auto` scroll region,
   *  which needs a bounded-height ancestor to clip against. */
  height?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div role="dialog" aria-modal="true" aria-label={ariaLabel} onClick={onClose}
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-[60]">
      <div onClick={(e) => e.stopPropagation()}
        className={`bg-bg-card border border-border-strong rounded-[6px] shadow-[0_8px_24px_rgba(0,0,0,0.4)] ${width} ${height ?? ''} max-w-[90vw] flex flex-col`}>
        {title && (
          <div className="flex items-center justify-between px-4 py-3 border-b border-border">
            <h2 className="text-fg text-base font-medium">{title}</h2>
            <button type="button" aria-label="닫기" onClick={onClose}
              className="text-fg-dim hover:text-fg text-lg leading-none">✕</button>
          </div>
        )}
        {children}
      </div>
    </div>
  );
}
