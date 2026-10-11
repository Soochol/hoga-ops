import { useEffect } from 'react';
import { ToastCard } from '../ui/toast/ToastCard';
import { subscribeToKiwoomFullHouseEvents } from '../api/eventStream';
import { useKiwoomFullHouseStore } from '../state/kiwoomFullHouse';

const VISIBLE_CODES = 3;

function SubscriptionToast({ codes, dismissed, dismiss, title, message }: {
  codes: string[]; dismissed: boolean; dismiss: () => void; title: string; message: string;
}) {
  const shown = codes.slice(0, VISIBLE_CODES).join(', ');
  const overflow = codes.length - VISIBLE_CODES;
  return (
    <ToastCard visible={codes.length > 0 && !dismissed} variant="warn" role="status" ariaLabel={title}>
      <div className="flex items-start justify-between gap-2">
        <div className="text-sm font-medium text-fg">{title}</div>
        <button type="button" aria-label="닫기" onClick={dismiss}
          className="-mr-1 -mt-0.5 shrink-0 text-base leading-none text-fg-dim hover:text-fg">✕</button>
      </div>
      <div className="mt-1 text-xs text-fg-dim">
        {shown}{overflow > 0 ? ` 외 ${overflow}개` : ''}: {message}
      </div>
    </ToastCard>
  );
}

/** Vendor slot exhaustion and application reference limits have different recovery paths. */
export default function KiwoomFullHouseToastHost() {
  const pendingCodes = useKiwoomFullHouseStore((s) => s.pendingCodes);
  const toastDismissed = useKiwoomFullHouseStore((s) => s.toastDismissed);
  const dismissToast = useKiwoomFullHouseStore((s) => s.dismissToast);
  const notifyFullHouse = useKiwoomFullHouseStore((s) => s.notifyFullHouse);
  const resolveFullHouse = useKiwoomFullHouseStore((s) => s.resolveFullHouse);
  const referenceLimitCodes = useKiwoomFullHouseStore((s) => s.referenceLimitCodes);
  const referenceLimitDismissed = useKiwoomFullHouseStore((s) => s.referenceLimitDismissed);
  const dismissReferenceLimit = useKiwoomFullHouseStore((s) => s.dismissReferenceLimit);
  const notifyReferenceLimit = useKiwoomFullHouseStore((s) => s.notifyReferenceLimit);
  const clear = useKiwoomFullHouseStore((s) => s.clear);

  useEffect(() => subscribeToKiwoomFullHouseEvents((e) => {
    if (e.type === 'kiwoom_full_house') notifyFullHouse(e.code);
    else if (e.type === 'kiwoom_full_house_resolved') resolveFullHouse(e.code);
    else if (e.type === 'live_subscription_limit') notifyReferenceLimit(e.code);
    else if (e.type === 'disconnected') clear();
  }), [notifyFullHouse, resolveFullHouse, notifyReferenceLimit, clear]);

  return <>
    <SubscriptionToast codes={pendingCodes} dismissed={toastDismissed} dismiss={dismissToast}
      title="키움 실시간 구독 슬롯 부족"
      message="실시간 등록이 보류됐습니다. 다른 창이나 브라우저 탭을 닫아 슬롯이 반환되면 자동으로 연결됩니다." />
    <SubscriptionToast codes={referenceLimitCodes} dismissed={referenceLimitDismissed} dismiss={dismissReferenceLimit}
      title="앱 화면 구독 한도 초과"
      message="앱의 구독 관리 한도에 도달했습니다. 불필요한 브라우저 탭이나 목록을 닫은 뒤 이 탭을 새로고침해 주세요." />
  </>;
}
