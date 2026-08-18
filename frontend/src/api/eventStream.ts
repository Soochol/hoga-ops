import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { STOCK_DATES_QUERY_KEY } from './stock-dates';
import { WATCHLIST_KEY } from '../watchlist/watchlistKeys';
import { invalidateHeatmapDependents } from '../heatmap/heatmapKeys';
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

/** 관심목록·히트맵 변경 브로드캐스트 접기 창(ms).
 *
 *  다중 선택 이동·연속 재정렬은 변경 라우트를 짧은 시간에 여러 번 친다. 서버는
 *  **라우트마다** 신호를 하나씩 내므로(hoga/api/mutation_broadcast.py), 접지 않으면
 *  열려 있는 창 전부가 그 횟수만큼 GET 을 낸다 — 비용이 창 수 × 변경 수로 곱해진다.
 *
 *  값은 인벤토리와 같고 근거의 절반(사람이 "즉시" 로 느끼는 상한)도 같다. 그래도
 *  상수를 따로 두는 것은 두 축의 **비용 구조가 다르기 때문**이다: 인벤토리는 요청
 *  1회가 parquet 트리 전체 순회(warm 274ms)라 창을 줄이면 즉시 아프고, 목록 GET 은
 *  가벼워 그렇지 않다. 한 상수를 공유하면 한쪽 사정으로 값을 옮길 때 다른 쪽이
 *  말없이 따라간다. */
const LIST_INVALIDATE_COALESCE_MS = 250;

export function useEventStream(): void {
  const qc = useQueryClient();
  useEffect(() => {
    // 축(axis)별 접기 타이머. 축이 셋(인벤토리·관심목록·히트맵)이라 클로저 변수를
    // 축마다 늘리는 대신 맵 하나로 든다 — 정리도 한 곳에서 끝난다.
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const coalesce = (axis: string, ms: number, run: () => void): void => {
      if (timers.has(axis)) return;  // 이미 예약됨 — 창이 끝날 때 한 번만 돈다
      timers.set(axis, setTimeout(() => { timers.delete(axis); run(); }, ms));
    };
    const invalidateInventoryCoalesced = (): void => {
      coalesce('inventory', INVENTORY_INVALIDATE_COALESCE_MS, () => {
        qc.invalidateQueries({ queryKey: STOCK_DATES_QUERY_KEY });
      });
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
      } else if (e.type === 'watchlist_changed') {
        // 다른 창(또는 다른 브라우저)이 관심목록을 바꿨다. 이 창이 스스로 바꾼
        // 경우에도 같은 신호가 돌아오는데, 그 무효화는 mutation 의 onSuccess 가
        // 이미 낸 것과 같은 결과라 무해하다(RQ 가 같은 틱 무효화를 접는다).
        coalesce('watchlist', LIST_INVALIDATE_COALESCE_MS, () => {
          qc.invalidateQueries({ queryKey: WATCHLIST_KEY });
        });
      } else if (e.type === 'heatmap_changed') {
        // 무효화 집합은 이 창의 히트맵 mutation 과 **같은 함수**를 쓴다 — 손으로
        // 복제하면 원격 창에서만 index-sector-rankings 가 스테일해진다.
        coalesce('heatmap', LIST_INVALIDATE_COALESCE_MS, () => {
          invalidateHeatmapDependents(qc);
        });
      } else if (e.type === 'disconnected') {
        // Reconnect recovery (once per disconnect transition; ADR-0019).
        qc.invalidateQueries({ queryKey: STOCK_DATES_QUERY_KEY });
        qc.invalidateQueries({ queryKey: ['capture', 'queue'] });
        // 끊겨 있던 동안의 목록 변경 신호는 재전송되지 않는다(EventBus 는 큐를
        // 연결에 매달아 두고, 끊긴 연결의 큐는 사라진다). 다시 읽지 않으면 그
        // 사이 다른 창이 바꾼 관심목록·히트맵이 이 창에서만 영영 옛 상태로 남는다.
        qc.invalidateQueries({ queryKey: WATCHLIST_KEY });
        invalidateHeatmapDependents(qc);
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
      timers.forEach((t) => clearTimeout(t));
      timers.clear();
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
