import { useState } from 'react';
import { createPortal } from 'react-dom';
import { ToastCard } from '../ui/toast/ToastCard';
import { WATCHLIST_TRANSFER_NOTICE_MS, type useWatchlistTransfer } from './useWatchlistTransfer';

/** 패널이 이동/되돌리기를 소유하고, 공용 viewport가 위치와 쌓임을 소유한다. */
export function WatchlistTransferToast({ transfer }: { transfer: ReturnType<typeof useWatchlistTransfer> }) {
  const viewport = document.getElementById('toast-viewport');
  const [shownMessage, setShownMessage] = useState('');
  if (transfer.message && transfer.message !== shownMessage) {
    setShownMessage(transfer.message);
  }

  if (!viewport) return null;
  return createPortal(
    <ToastCard
      visible={!!transfer.message}
      role="status"
      ariaLabel="종목 이동 안내"
      variant="neutral"
      onExited={() => setShownMessage('')}
      progress={transfer.succeeded && !transfer.busy && transfer.message
        ? { durationMs: WATCHLIST_TRANSFER_NOTICE_MS, paused: false } : null}
      action={transfer.canUndo ? { label: '실행취소', onClick: () => { void transfer.undo(); } } : undefined}
    >
      <div className="flex items-start gap-2">
        <span className="min-w-0 break-words text-sm font-medium text-fg">{transfer.message || shownMessage}</span>
        {!transfer.busy && <button type="button" aria-label="이동 안내 닫기"
          className="shrink-0 text-fg-dim hover:text-fg" onClick={transfer.dismiss}>×</button>}
      </div>
    </ToastCard>,
    viewport,
  );
}
