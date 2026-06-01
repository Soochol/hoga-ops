import { useEffect, type ReactNode } from 'react';

// Presentational center confirm modal. Mirrors the LiveSettingsModal /
// IndicatorPanel pattern (backdrop + Escape useEffect; no useDismissablePopover).
// Holds NO mutation/anchor logic — the parent's onConfirm does that.
export function ConfirmModal({ message, confirmLabel, tone, onConfirm, onClose }: {
  message: ReactNode;
  confirmLabel: string;
  tone: 'primary' | 'destructive';
  onConfirm: () => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div role="dialog" aria-modal="true" onClick={onClose}
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-[60]">
      <div onClick={(e) => e.stopPropagation()}
        className="bg-bg-card border border-border-strong rounded-[6px] shadow-[0_8px_24px_rgba(0,0,0,0.4)] w-[360px] max-w-[90vw] flex flex-col">
        <div className="px-4 py-4 text-sm text-fg leading-relaxed">{message}</div>
        <div className="flex justify-end gap-2 px-4 py-3 border-t border-border">
          <button type="button" onClick={onClose}
            className="px-3 py-1.5 text-sm bg-bg-input hover:bg-bg-input-hover text-fg rounded">취소</button>
          <button type="button" onClick={onConfirm}
            className="px-3 py-1.5 text-sm rounded font-semibold"
            style={tone === 'destructive'
              ? { background: 'var(--error)', color: '#fff' }
              : { background: 'var(--accent)', color: 'var(--accent-fg)' }}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
