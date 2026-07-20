import { useEffect, useRef, useState } from 'react';
import { ToastCard } from '../ui/toast/ToastCard';
import { useDrawingsStore } from '../state/drawings';

const AUTO_DISMISS_MS = 6000;

/**
 * Undo-toast for "모두 지우기" (clearAll). Subscribes to the store's reactive
 * `clearToast` slot; when set, shows a card with an 실행취소 action that
 * `restore`s the pre-clear snapshot (a normal, itself-undoable mutation — not
 * an undo-stack pop, so it stays correct even if the user switched symbol or
 * timeframe, or drew more shapes, while the toast was up). Auto-dismisses
 * after 6s.
 *
 * Toast is a host-owned model (mirrors SignalAlertToastHost): the store owns
 * the trigger data, this host owns presentation + the auto-dismiss timer, and
 * ToastViewport owns stacking/position. See ADR-0107.
 */
export default function DrawingClearToastHost() {
  const clearToast = useDrawingsStore((s) => s.clearToast);
  const restore = useDrawingsStore((s) => s.restore);
  const dismissClearToast = useDrawingsStore((s) => s.dismissClearToast);

  // Latch the payload so the card keeps its label/handler through the exit
  // animation after the store slot is cleared to null.
  const [shown, setShown] = useState<typeof clearToast>(null);
  const paused = useRef(false);

  useEffect(() => {
    if (clearToast == null) return;
    setShown(clearToast);
    const timer = setTimeout(() => {
      if (!paused.current) dismissClearToast();
    }, AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [clearToast, dismissClearToast]);

  const visible = clearToast != null;
  const payload = shown;

  return (
    <ToastCard
      visible={visible}
      variant="neutral"
      role="status"
      progress={visible ? { durationMs: AUTO_DISMISS_MS, paused: false } : null}
      onMouseEnter={() => (paused.current = true)}
      onMouseLeave={() => (paused.current = false)}
      onExited={() => setShown(null)}
      action={
        payload
          ? {
              label: '실행취소',
              onClick: () => {
                restore(payload.scope, payload.snapshot);
                dismissClearToast();
              },
            }
          : undefined
      }
    >
      <div className="text-sm font-medium text-fg">그림 {payload?.count ?? 0}개 삭제됨</div>
    </ToastCard>
  );
}
