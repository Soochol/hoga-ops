import { useCallback, useEffect, useState } from 'react';
import type { SignalAlertEvent } from '../api/signalAlerts';
import type { PushEvent } from '../api/types';
import { subscribeEvents } from '../api/ws';
import { useJumpToLive } from '../live/useJumpToLive';
import { ToastCard } from '../ui/toast/ToastCard';
import { DEFAULT_TOAST_DURATION_MS, useToastTimer } from '../ui/toast/useToastTimer';

const TOAST_LIMIT = 3;
const TOAST_TTL_MS = DEFAULT_TOAST_DURATION_MS;

function isSignalAlert(event: PushEvent): event is SignalAlertEvent {
  return event.type === 'signal_alert';
}

function formatSignalSummary(event: SignalAlertEvent): string {
  return `매도 총잔량 ${event.value.toLocaleString()} · 기준 대비 ${event.ratio_pct.toFixed(1)}%`;
}

/**
 * 시그널 알림 토스트 스택. WS `signal_alert` 이벤트마다 카드를 push 하고,
 * 각 카드는 {@link SignalToastItem} 이 스스로 TTL·hover 정지·점프를 관리한다.
 * 위치/스택은 상위 ToastViewport 가 소유하므로 여기선 카드 리스트만 낸다.
 */
export default function SignalAlertToastHost() {
  const jumpToLive = useJumpToLive();
  const [events, setEvents] = useState<SignalAlertEvent[]>([]);

  useEffect(() => {
    return subscribeEvents((event) => {
      if (!isSignalAlert(event)) return;
      setEvents((current) => {
        // 같은 id 재수신은 최신으로 대체(맨 앞), 최대 TOAST_LIMIT 개 유지.
        const next = [event, ...current.filter((e) => e.id !== event.id)];
        return next.slice(0, TOAST_LIMIT);
      });
    });
  }, []);

  const remove = useCallback((id: string) => {
    setEvents((current) => current.filter((e) => e.id !== id));
  }, []);

  return (
    <>
      {events.map((event) => (
        <SignalToastItem
          key={event.id}
          event={event}
          onExited={() => remove(event.id)}
          onJump={() => jumpToLive(event.code, event.name)}
        />
      ))}
    </>
  );
}

type SignalToastItemProps = {
  event: SignalAlertEvent;
  /** exit 애니메이션 완료 후 리스트에서 실제 제거. */
  onExited: () => void;
  onJump: () => void;
};

/**
 * 한 시그널 토스트의 수명 소유: TTL 자동소멸 + hover 시 타이머/진행바 정지,
 * 클릭 시 점프. `visible` 을 내려 ToastCard 가 exit 애니메이션을 재생하게 한다.
 */
function SignalToastItem({ event, onExited, onJump }: SignalToastItemProps) {
  const [visible, setVisible] = useState(true);
  const timer = useToastTimer({ visible, resetKey: event.id, durationMs: TOAST_TTL_MS, onExpire: () => setVisible(false) });

  return (
    <ToastCard
      visible={visible}
      onExited={onExited}
      variant="neutral"
      title={event.name}
      ariaLabel={`${event.name} ${event.code} 알림 열기`}
      progress={timer.progress}
      {...timer.interactionProps}
      onClick={() => {
        onJump();
        setVisible(false);
      }}
    >
      {formatSignalSummary(event)}
    </ToastCard>
  );
}
