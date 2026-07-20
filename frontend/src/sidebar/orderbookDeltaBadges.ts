import { useRef } from 'react';
import { isContinuousBook, type ObSnapshot } from '../live/bucketHogaSeries';
import { sameDeltaChain } from '../live/depthDelta';

/** 10호가 카드의 HTS식 순간 증감 뱃지 상태.
 *
 * 연속된 두 라이브 스냅샷을 **같은 가격끼리** diff 해(차트 증감 지표와 동일 규칙:
 * side 분리·가격 교집합·venue 전환 차단) 각 호가 단 잔량 옆에 "+1,200"/"−800" 을
 * 잠깐 표시하고 페이드아웃한다. 값의 의미는 "직전 수신 스냅샷 대비" — WS push 가
 * 절사되므로 놓친 중간 전환은 담기지 않는다(그건 차트 지표의 버킷 합이 담당).
 */
export type OrderbookDeltaBadge = {
  delta: number;
  /** 뱃지 생성 벽시계(ms) — 페이드 애니메이션 재시작 키. 스냅샷 t_ms 는 초 해상도라
   *  같은 초의 연속 틱을 구분 못해 쓰지 않는다. */
  atMs: number;
};

/** key = `a:${price}` | `b:${price}` */
export type OrderbookDeltaBadges = ReadonlyMap<string, OrderbookDeltaBadge>;

/** 페이드 길이와 동기화된 보관 상한 — CSS `.book-delta-flash` (1.5s) 이후의 뱃지는
 *  다음 갱신에서 정리한다(불투명도 0 이라 어차피 안 보임). */
export const BADGE_TTL_MS = 1_500;

/** 연속 스냅샷 쌍의 가격별 증감. 차트 지표(foldLevelDiff)와 같은 3규칙:
 *  - side 분리: 매도는 매도끼리, 매수는 매수끼리(현재가 이동으로 단이 넘어간 가격 배제).
 *  - 가격 교집합: 한쪽에만 있는 가격은 관측창 이동이지 주문 변화가 아니다.
 *  - 체인 차단: 동시호가/VI 붕괴책(구조 술어)·venue 전환이면 diff 하지 않는다.
 *  카드용이라 09:00 하한(isIndicatorEligibleBook)은 걸지 않는다 — NXT 프리마켓
 *  (08:00~)에서도 호가창은 살아 있어야 한다. */
export function computeOrderbookDeltas(
  prev: ObSnapshot,
  cur: ObSnapshot,
): Map<string, number> {
  const out = new Map<string, number>();
  if (!prev.asks || !prev.bids || !cur.asks || !cur.bids) return out;
  if (!isContinuousBook(prev) || !isContinuousBook(cur)) return out;
  if (!sameDeltaChain(prev, cur)) return out;
  for (const [tag, prevLvls, curLvls] of [
    ['a', prev.asks, cur.asks],
    ['b', prev.bids, cur.bids],
  ] as const) {
    const prevByPrice = new Map<number, number>();
    for (const l of prevLvls) if (l.price > 0) prevByPrice.set(l.price, l.qty);
    for (const l of curLvls) {
      if (l.price <= 0) continue;
      const pq = prevByPrice.get(l.price);
      if (pq === undefined) continue;
      const d = l.qty - pq;
      if (d !== 0) out.set(`${tag}:${l.price}`, d);
    }
  }
  return out;
}

/** 뱃지 누적 한 스텝(순수 — 훅과 테스트가 공유). 새 증감은 기존 뱃지를 교체하고
 *  (페이드 재시작), TTL 을 넘긴 뱃지는 정리한다. 변화가 없으면 `state` 그대로 반환
 *  (참조 안정 → 하류 memo 유지). */
export function advanceBadges(
  state: OrderbookDeltaBadges,
  deltas: ReadonlyMap<string, number>,
  nowMs: number,
): OrderbookDeltaBadges {
  let expired = false;
  for (const b of state.values()) {
    if (nowMs - b.atMs > BADGE_TTL_MS) {
      expired = true;
      break;
    }
  }
  if (deltas.size === 0 && !expired) return state;
  const next = new Map<string, OrderbookDeltaBadge>();
  for (const [k, b] of state) {
    if (nowMs - b.atMs <= BADGE_TTL_MS) next.set(k, b);
  }
  for (const [k, delta] of deltas) next.set(k, { delta, atMs: nowMs });
  return next;
}

const EMPTY: OrderbookDeltaBadges = new Map();
const NO_DELTAS: ReadonlyMap<string, number> = new Map();

/** 라이브 스냅샷 버퍼 → 현재 뱃지 맵. `enabled=false`(스팟 커서 등)면 null 을 주고
 *  상태를 비운다 — 과거 시점을 보는 동안 낡은 뱃지가 남지 않게.
 *
 *  렌더 중 ref 갱신 패턴(useLiveBundle 의 deltaSessionRef 관용구): 버퍼 push 가
 *  이미 카드 재렌더를 일으키므로 별도 구독이 필요 없고, 같은 cur 스냅샷을 두 번
 *  처리하지 않게 마지막 처리 참조로 멱등화한다(StrictMode 이중 렌더 안전). */
export function useOrderbookDeltaBadges(
  ob: readonly ObSnapshot[],
  enabled: boolean,
): OrderbookDeltaBadges | null {
  const stateRef = useRef<OrderbookDeltaBadges>(EMPTY);
  const lastCurRef = useRef<ObSnapshot | null>(null);
  if (!enabled) {
    stateRef.current = EMPTY;
    lastCurRef.current = null;
    return null;
  }
  // 버퍼 꼬리에서 호가장을 실은 마지막 두 스냅샷을 찾는다(totals-only 틱 건너뜀).
  let cur: ObSnapshot | null = null;
  let prev: ObSnapshot | null = null;
  for (let i = ob.length - 1; i >= 0 && prev === null; i -= 1) {
    const s = ob[i];
    if (!s.asks || !s.bids) continue;
    if (cur === null) cur = s;
    else prev = s;
  }
  const nowMs = Date.now();
  if (cur !== null && prev !== null && cur !== lastCurRef.current) {
    lastCurRef.current = cur;
    stateRef.current = advanceBadges(stateRef.current, computeOrderbookDeltas(prev, cur), nowMs);
  } else {
    stateRef.current = advanceBadges(stateRef.current, NO_DELTAS, nowMs);
  }
  return stateRef.current;
}
