import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { STOCK_DATES_QUERY_KEY } from './stock-dates';
import { subscribeEvents, lastHeartbeat } from './ws';
import type { PushEvent } from './types';
import { markPromotion } from '../state/livePromotion';

export { lastHeartbeat };

/** 인벤토리 무효화 접기 창(ms).
 *
 *  `/api/stock-dates` 는 응답 하나가 parquet 트리 **전체** 순회다(코드 주석의 실측:
 *  warm 274ms / 15.9k행, cold 36.9s). 그런데 여기서는 `inventory_added` 하나마다
 *  무효화했다 — 캡처 100건 배치면 274ms 순회가 100회 나가고, Inventory·Capture
 *  페이지가 열려 있으면 그게 전부 실제 요청이 된다.
 *
 *  게다가 Linux inotify 는 meta.json 한 번 쓰기에 created+modified 두 이벤트를 낸다
 *  (hoga/api/events.py 는 "TanStack Query 가 같은 틱 무효화를 접으므로 괜찮다"고
 *  디바운스를 생략했는데, 그 전제는 **탭 1개일 때만** 성립한다 — 탭 N개면 독립
 *  쿼리클라이언트 N개가 각자 접어서 N개 요청을 낸다).
 *
 *  250ms 는 useCaptureQueue 의 FINISHED_INVALIDATE_COALESCE_MS 와 같은 값·같은
 *  근거다(사람이 "즉시"로 느끼는 상한 + 동시 워커 버스트를 한 번으로 모음). */
const INVENTORY_INVALIDATE_COALESCE_MS = 250;

export function useEventStream(): void {
  const qc = useQueryClient();
  useEffect(() => {
    let inventoryTimer: ReturnType<typeof setTimeout> | null = null;
    const invalidateInventoryCoalesced = (): void => {
      if (inventoryTimer !== null) return;  // 이미 예약됨 — 창이 끝날 때 한 번만 돈다
      inventoryTimer = setTimeout(() => {
        inventoryTimer = null;
        qc.invalidateQueries({ queryKey: STOCK_DATES_QUERY_KEY });
      }, INVENTORY_INVALIDATE_COALESCE_MS);
    };

    const unsubscribe = subscribeEvents((e: PushEvent) => {
      if (e.type === 'inventory_added' || e.type === 'inventory_removed') {
        invalidateInventoryCoalesced();
      } else if (e.type === 'promotion_completed') {
        // Delta today-range hooks refresh via the per-code stamp; simple
        // useRange consumers via invalidate (WS 푸시 승격 무효화).
        markPromotion(e.code, Date.now());
        qc.invalidateQueries({
          predicate: (q) =>
            Array.isArray(q.queryKey) && q.queryKey[0] === 'range' && q.queryKey[1] === e.code,
        });
      } else if (e.type === 'disconnected') {
        // Reconnect recovery (once per disconnect transition; ADR-0019).
        qc.invalidateQueries({ queryKey: STOCK_DATES_QUERY_KEY });
        qc.invalidateQueries({ queryKey: ['capture', 'queue'] });
        qc.invalidateQueries({
          predicate: (q) => Array.isArray(q.queryKey) && q.queryKey[0] === 'calendar',
        });
        // Promotions may have been missed while disconnected. The delta hooks'
        // 5-min fallback poll is the real safety net; this refreshes enabled/
        // simple range queries immediately on reconnect.
        qc.invalidateQueries({
          predicate: (q) => Array.isArray(q.queryKey) && q.queryKey[0] === 'range',
        });
      }
      // 'connected' → no query work; UI surfaces use it.
    });
    return () => {
      // 예약된 접기 타이머도 함께 취소한다 — 언마운트 뒤에 발화하면 이미 정리된
      // 클라이언트를 무효화하고, 테스트에서는 타이머가 새는 것으로 나타난다.
      if (inventoryTimer !== null) clearTimeout(inventoryTimer);
      unsubscribe();
    };
  }, [qc]);
}

export function subscribeToCaptureEvents(handler: (e: PushEvent) => void): () => void {
  return subscribeEvents((e: PushEvent) => {
    if (e.type.startsWith('capture_')) handler(e);
  });
}

/** 스크리너 갱신 job 이벤트 + disconnected(재연결 복구용) 필터. */
export function subscribeToScreenerUpdateEvents(handler: (e: PushEvent) => void): () => void {
  return subscribeEvents((e: PushEvent) => {
    if (e.type.startsWith('screener_update') || e.type === 'disconnected') handler(e);
  });
}

/** 키움 표시 슬롯 만석 + disconnected(stale 보류 목록 폐기용) 필터. */
export function subscribeToKiwoomFullHouseEvents(handler: (e: PushEvent) => void): () => void {
  return subscribeEvents((e: PushEvent) => {
    if (e.type === 'kiwoom_full_house' || e.type === 'disconnected') handler(e);
  });
}
