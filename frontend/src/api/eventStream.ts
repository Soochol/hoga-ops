import { useEffect } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { STOCK_DATES_QUERY_KEY } from './stock-dates';
import { WATCHLIST_KEY } from '../watchlist/watchlistKeys';
import { invalidateHeatmapDependents } from '../heatmap/heatmapKeys';
import { SCREENER_SAVES_KEY } from '../screener/screenerKeys';
import { STUDY_VIEW_SAVES_QUERY } from '../studyViews/studyViewKeys';
import { LIVE_LAYOUT_PRESETS_QUERY } from '../live/presets/liveLayoutPresetKeys';
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

/** 목록 동기화 축 — 서버가 브로드캐스트하는 이벤트 하나가 축 하나다
 *  (hoga/api/mutation_broadcast.py 의 event_type 손 미러, ADR-0004).
 *
 *  **테이블로 두는 이유는 재연결 복구와의 짝을 코드가 강제하게 하기 위해서다.**
 *  축마다 `else if` 를 늘리던 동안 복구 블록은 따로 관리됐고, 규율은 주석에만
 *  있었다 — 실제로 축을 추가하면서 복구를 빠뜨린 적이 있다(테스트가 잡았다).
 *  아래 두 소비 지점이 같은 배열을 읽으므로 이제 축을 추가하면 복구가 자동으로
 *  따라온다. 반대로 **여기서 빠진 축은 두 곳 모두에서 동시에 죽는다** — 무증상
 *  절반 동작(평상시엔 되는데 재연결 후에만 어긋남)이 생기지 않는다.
 *
 *  inventory·promotion 은 이 테이블에 없다. inventory 는 접기 창 상수가 다르고
 *  (요청 1회가 parquet 트리 순회라는 별개 비용 구조), promotion 은 무효화가
 *  아니라 코드별 스탬프다. 이건 "목록 동기화 축" 이지 "모든 이벤트" 가 아니다. */
interface ListSyncAxis {
  readonly event: PushEvent['type'];
  readonly invalidate: (qc: QueryClient) => void;
}

const byKey = (queryKey: readonly unknown[]) => (qc: QueryClient): void => {
  void qc.invalidateQueries({ queryKey });
};

export const LIST_SYNC_AXES: readonly ListSyncAxis[] = [
  { event: 'watchlist_changed', invalidate: byKey(WATCHLIST_KEY) },
  // 히트맵만 키가 둘이다(랭킹이 그룹 구성을 투영) — 로컬 mutation 과 같은 함수.
  { event: 'heatmap_changed', invalidate: invalidateHeatmapDependents },
  { event: 'screener_saves_changed', invalidate: byKey(SCREENER_SAVES_KEY) },
  { event: 'study_views_changed', invalidate: byKey(STUDY_VIEW_SAVES_QUERY) },
  { event: 'live_layout_presets_changed', invalidate: byKey(LIVE_LAYOUT_PRESETS_QUERY) },
];

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
      const listSyncAxis = LIST_SYNC_AXES.find((a) => a.event === e.type);
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
      } else if (listSyncAxis !== undefined) {
        // 다른 창(또는 다른 브라우저)이 목록을 바꿨다. 이 창이 스스로 바꾼 경우에도
        // 같은 신호가 돌아오는데, 그 무효화는 mutation 의 onSuccess 가 이미 낸 것과
        // 같은 결과라 무해하다(RQ 가 같은 틱 무효화를 접는다).
        coalesce(listSyncAxis.event, LIST_INVALIDATE_COALESCE_MS, () => {
          listSyncAxis.invalidate(qc);
        });
      } else if (e.type === 'disconnected') {
        // Reconnect recovery (once per disconnect transition; ADR-0019).
        qc.invalidateQueries({ queryKey: STOCK_DATES_QUERY_KEY });
        qc.invalidateQueries({ queryKey: ['capture', 'queue'] });
        // 끊겨 있던 동안의 목록 변경 신호는 재전송되지 않는다(EventBus 는 큐를
        // 연결에 매달아 두고, 끊긴 연결의 큐는 사라진다). 다시 읽지 않으면 그 사이
        // 다른 창이 바꾼 목록이 이 창에서만 영영 옛 상태로 남는다 — 축을 추가할 때
        // 가장 빠뜨리기 쉬운 자리라 **테이블을 순회한다**(LIST_SYNC_AXES 주석).
        for (const axis of LIST_SYNC_AXES) axis.invalidate(qc);
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
