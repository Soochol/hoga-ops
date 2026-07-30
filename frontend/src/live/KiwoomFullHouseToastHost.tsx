import { useEffect } from 'react';
import { ToastCard } from '../ui/toast/ToastCard';
import { subscribeToKiwoomFullHouseEvents } from '../api/eventStream';
import { useKiwoomFullHouseStore } from '../state/kiwoomFullHouse';

/** 토스트 본문에 나열할 종목 수 — 넘치면 "외 N개"로 접는다. */
const VISIBLE_CODES = 3;

/**
 * 키움 표시(온디맨드) 슬롯 만석 알림.
 *
 * 이 토스트가 없으면 만석에 걸린 창은 **무증상으로** 멈춘 차트만 보여 준다 —
 * 사용자는 "시장이 조용한 것"과 "내 창이 데이터를 못 받는 것"을 구별할 수 없다.
 * 백엔드는 만석 시 등록을 보류 상태로 장부에 남기고 watchdog 이 슬롯 반환 시 자동
 * 배정하므로(kiwoom_session.on_view_subscribe), 안내 문구는 복구 조건(창을 닫으면
 * 풀린다)만 알려 주면 된다. 스택/위치는 ToastViewport 소유.
 */
export default function KiwoomFullHouseToastHost() {
  const pendingCodes = useKiwoomFullHouseStore((s) => s.pendingCodes);
  const toastDismissed = useKiwoomFullHouseStore((s) => s.toastDismissed);
  const dismissToast = useKiwoomFullHouseStore((s) => s.dismissToast);
  const notifyFullHouse = useKiwoomFullHouseStore((s) => s.notifyFullHouse);
  const clear = useKiwoomFullHouseStore((s) => s.clear);

  useEffect(() => {
    return subscribeToKiwoomFullHouseEvents((e) => {
      if (e.type === 'kiwoom_full_house') notifyFullHouse(e.code);
      // 재연결 시 프론트가 전 종목을 재구독하고 백엔드가 만석을 다시 판정한다 —
      // 그 전에 stale 목록을 버려야 이미 풀린 종목이 남아 있지 않다.
      else if (e.type === 'disconnected') clear();
    });
  }, [notifyFullHouse, clear]);

  const visible = pendingCodes.length > 0 && !toastDismissed;
  const shown = pendingCodes.slice(0, VISIBLE_CODES).join(', ');
  const overflow = pendingCodes.length - VISIBLE_CODES;

  return (
    <ToastCard visible={visible} variant="warn" role="status">
      <div className="flex items-start justify-between gap-2">
        <div className="text-sm font-medium text-fg">실시간 구독 슬롯 부족</div>
        <button
          type="button"
          aria-label="닫기"
          onClick={dismissToast}
          className="-mr-1 -mt-0.5 shrink-0 text-base leading-none text-fg-dim hover:text-fg"
        >
          ✕
        </button>
      </div>
      <div className="mt-1 text-xs text-fg-dim">
        {shown}
        {overflow > 0 ? ` 외 ${overflow}개` : ''}
        의 실시간 수신이 대기 중입니다. 다른 창을 닫으면 자동으로 연결됩니다.
      </div>
    </ToastCard>
  );
}
