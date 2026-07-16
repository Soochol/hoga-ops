import { useEffect, useState, type ReactNode } from 'react';

// Shared center-modal chrome: full-screen backdrop, Escape + backdrop-click
// dismissal, and the canon card (bg-card / border-strong / 6px / shadow). The
// optional `title` renders the standard header (title + ✕ 닫기). Callers supply
// the body (and footer) as children. Concentrates the modal dismissal contract
// in one place — consumed by ConfirmModal, LiveSettingsModal, IndicatorPanel.
//
// `side='right'` turns it into a right-anchored, full-height drawer (slides in)
// with a lighter dim so the chart stays visible on the left — immediate-apply
// settings reflect live behind it (ADR-0116, /live 지표 드로어). Default 'center'
// keeps every existing caller unchanged.
export function ModalShell({ ariaLabel, title, width = 'w-[640px]', height, side = 'center', onClose, children }: {
  ariaLabel: string;
  title?: string;
  width?: string;
  /** Optional fixed-height classes (e.g. `h-[600px] max-h-[88vh]`). Omit to size
   *  to content. Required when the body has its own `overflow-auto` scroll region,
   *  which needs a bounded-height ancestor to clip against. Ignored for side='right'
   *  (drawer is always full-height). */
  height?: string;
  /** 'center' (default) = centered card; 'right' = full-height right drawer. */
  side?: 'center' | 'right';
  onClose: () => void;
  children: ReactNode;
}) {
  const isDrawer = side === 'right';
  // Slide-in on mount (drawer only). No exit animation — unmount is immediate.
  const [shown, setShown] = useState(!isDrawer);
  useEffect(() => {
    if (isDrawer) setShown(true);
  }, [isDrawer]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const backdropClass = isDrawer
    ? 'fixed inset-0 bg-black/30 flex items-stretch justify-end z-[60]'
    : 'fixed inset-0 bg-black/50 flex items-center justify-center z-[60]';
  const cardClass = isDrawer
    ? `bg-bg-card border-l border-border-strong shadow-overlay ${width} h-full max-w-[95vw] flex flex-col transition-transform duration-150 ease-out ${shown ? 'translate-x-0' : 'translate-x-full'}`
    : `bg-bg-card border border-border-strong rounded-[6px] shadow-overlay ${width} ${height ?? ''} max-w-[90vw] flex flex-col`;

  return (
    <div role="dialog" aria-modal="true" aria-label={ariaLabel} onClick={onClose}
      className={backdropClass}>
      <div onClick={(e) => e.stopPropagation()} className={cardClass}>
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
