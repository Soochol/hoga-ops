import { useState } from 'react';
import { createPortal } from 'react-dom';
import { ToastCard } from '../ui/toast/ToastCard';
import { type useWatchlistTransfer } from './useWatchlistTransfer';

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
      variant={!transfer.busy && !transfer.succeeded ? 'error' : 'neutral'}
      title={transfer.message || shownMessage}
      onDismiss={transfer.busy ? undefined : transfer.dismiss}
      dismissLabel="이동 안내 닫기"
      onExited={() => setShownMessage('')}
      progress={transfer.timer.progress}
      {...transfer.timer.interactionProps}
      action={transfer.canUndo ? { label: '실행 취소', onClick: () => { void transfer.undo(); } } : undefined}
    />,
    viewport,
  );
}
