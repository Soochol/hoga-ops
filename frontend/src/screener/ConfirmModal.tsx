import { type ReactNode } from 'react';
import { ModalShell } from '../ui/ModalShell';

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
  return (
    <ModalShell ariaLabel={confirmLabel} width="w-[360px]" onClose={onClose}>
      <div className="px-4 py-4 text-sm text-fg leading-relaxed">{message}</div>
      <div className="flex justify-end gap-2 px-4 py-3 border-t border-border">
        <button type="button" onClick={onClose}
          className="px-3 py-1.5 text-sm bg-bg-input hover:bg-bg-input-hover text-fg rounded">취소</button>
        <button type="button" onClick={onConfirm}
          className="px-3 py-1.5 text-sm rounded font-semibold"
          style={tone === 'destructive'
            ? { background: 'var(--error)', color: 'var(--fg)' }
            : { background: 'var(--accent)', color: 'var(--accent-fg)' }}>
          {confirmLabel}
        </button>
      </div>
    </ModalShell>
  );
}
