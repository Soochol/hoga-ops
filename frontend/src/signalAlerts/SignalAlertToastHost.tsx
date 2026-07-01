import { useEffect, useMemo, useRef, useState } from 'react';
import type { SignalAlertEvent } from '../api/signalAlerts';
import type { PushEvent } from '../api/types';
import { subscribeEvents } from '../api/ws';
import { useJumpToLive } from '../live/useJumpToLive';

const TOAST_LIMIT = 3;
const TOAST_TTL_MS = 5000;

type ToastState = {
  event: SignalAlertEvent;
  timeoutId: ReturnType<typeof window.setTimeout>;
};

function isSignalAlert(event: PushEvent): event is SignalAlertEvent {
  return event.type === 'signal_alert';
}

function formatSignalSummary(event: SignalAlertEvent): string {
  return `매도 총잔량 ${event.value.toLocaleString()} · 기준 대비 ${event.ratio_pct.toFixed(1)}%`;
}

export default function SignalAlertToastHost() {
  const jumpToLive = useJumpToLive();
  const [toasts, setToasts] = useState<ToastState[]>([]);
  const toastsRef = useRef<ToastState[]>([]);

  useEffect(() => {
    toastsRef.current = toasts;
  }, [toasts]);

  useEffect(() => {
    return subscribeEvents((event) => {
      if (!isSignalAlert(event)) return;

      const timeoutId = window.setTimeout(() => {
        setToasts((current) => current.filter((toast) => toast.event.id !== event.id));
      }, TOAST_TTL_MS);

      setToasts((current) => {
        const replaced = current.filter((toast) => toast.event.id === event.id);
        replaced.forEach((toast) => window.clearTimeout(toast.timeoutId));
        const next = [{ event, timeoutId }, ...current.filter((toast) => toast.event.id !== event.id)];
        const overflow = next.slice(TOAST_LIMIT);
        overflow.forEach((toast) => window.clearTimeout(toast.timeoutId));
        return next.slice(0, TOAST_LIMIT);
      });
    });
  }, []);

  useEffect(() => () => {
    toastsRef.current.forEach((toast) => window.clearTimeout(toast.timeoutId));
  }, []);

  const visibleToasts = useMemo(() => toasts.map((toast) => toast.event), [toasts]);

  if (visibleToasts.length === 0) return null;

  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed right-[calc(var(--rail-w)+12px)] top-[calc(var(--h-top-nav)+12px)] z-[90] flex w-[18rem] flex-col gap-2"
    >
      {visibleToasts.map((toast) => (
        <button
          key={toast.id}
          type="button"
          aria-label={`${toast.name} ${toast.code} 알림 열기`}
          className="pointer-events-auto rounded border border-border bg-bg-card px-3 py-2 text-left shadow-lg transition hover:border-line-strong hover:bg-bg-input"
          onClick={() => {
            setToasts((current) => {
              const next = current.filter((entry) => entry.event.id !== toast.id);
              current
                .filter((entry) => entry.event.id === toast.id)
                .forEach((entry) => window.clearTimeout(entry.timeoutId));
              return next;
            });
            jumpToLive(toast.code, toast.name);
          }}
        >
          <div className="truncate text-sm font-medium text-fg">{toast.name}</div>
          <div className="mt-1 text-xs text-fg-dim">{formatSignalSummary(toast)}</div>
        </button>
      ))}
    </div>
  );
}
