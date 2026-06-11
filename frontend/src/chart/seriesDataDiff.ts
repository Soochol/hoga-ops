import type { SeriesDataItemTypeMap, SeriesType } from 'lightweight-charts';

/**
 * /live 호가 보조지표의 틱당 `setData(전체)` 렌더 비용을 없애는 generic tail-diff.
 * (CONTEXT.md "라이브 호가 보조지표 — 증분 setData")
 *
 * 동기: P0가 *투영 계산*은 캐시했지만, RangeSeriesPane은 여전히 매 틱 `setData(전체)`를
 * 호출한다. 실측(브라우저 lwc v5.2.0, 90일 35k점×6시리즈): `setData(전체)` 동기 JS만
 * 틱당 ~66ms. update(tail)은 ~1ms. 평상시(09:00–15:20 연속거래)엔 마지막 버킷 하나만
 * 변하므로, 새 투영 배열을 직전 push와 정확 비교해 "마지막만 변경/1개 append"면
 * `series.update(tail)`로, 그 외엔 `setData(전체)`로 폴백한다.
 *
 * 안전성: update는 **이전 원소가 하나도 안 바뀐 게 증명될 때만** 호출 → setData와 동치.
 * 따라서 경매창 마스킹의 소급 color 재작성(이전 원소 변경), 일경계 break/anchor(2개+
 * append), 좌측 팬/타임프레임/ctx 변경(다수 변경)은 전부 setData로 자동 폴백된다.
 * 틀린 차트는 구조상 불가능 — 최악도 "이득 없음".
 *
 * 비용: prefix를 전부 비교하지만 (1) P0 캐시로 past 원소는 틱 간 같은 객체 참조라
 * `a === b` 즉시 통과, (2) 당일 ~390점만 필드 비교. 6시리즈 합쳐도 <1ms로,
 * 대체 대상인 ~66ms setData보다 훨씬 싸다.
 */

type Item = Record<string, unknown>;
type SeriesItem = SeriesDataItemTypeMap[SeriesType];

export type DataChange =
  | { kind: 'skip' }
  | { kind: 'update'; point: SeriesItem }
  | { kind: 'setData' };

/** 두 데이터 포인트의 모든 own-enumerable 필드가 같은가. `a === b` 참조 fast-path로
 * P0 캐시의 past 원소를 즉시 통과시키고, 다른 참조면 키 집합 + 값(===)을 전부 비교한다.
 * 모든 필드를 비교하므로 color/OHLC/topLineColor 등 어떤 시리즈 타입의 필드도 놓치지 않음. */
function itemsEqual(a: Item, b: Item): boolean {
  if (a === b) return true;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (a[k] !== b[k]) return false;
  }
  return true;
}

/** value/OHLC가 없는 whitespace(시간만) 포인트인가. lwc의 update()로 whitespace를
 * 밀어넣는 건 시리즈 타입별 동작이 미묘해 위험 → whitespace tail은 update 대신 setData. */
function isWhitespace(item: Item): boolean {
  return (
    item.value === undefined &&
    item.close === undefined &&
    item.open === undefined &&
    item.high === undefined &&
    item.low === undefined
  );
}

export function classifyDataChange(
  prev: readonly SeriesItem[] | null,
  next: readonly SeriesItem[],
): DataChange {
  if (prev === null) return { kind: 'setData' };
  if (prev.length === 0) {
    // 빈 시리즈 → 데이터: fresh load. 빈 시리즈에 update()는 동작이 미묘 → setData.
    return next.length === 0 ? { kind: 'skip' } : { kind: 'setData' };
  }

  if (next.length === prev.length) {
    const last = next.length - 1;
    // prefix [0..last-1]가 하나라도 다르면 깨끗한 tail 변경이 아님 → setData.
    for (let i = 0; i < last; i++) {
      if (!itemsEqual(prev[i] as unknown as Item, next[i] as unknown as Item)) return { kind: 'setData' };
    }
    // prefix 동일. 마지막도 같으면 변화 없음.
    const pLast = prev[last] as unknown as Item;
    const nLast = next[last] as unknown as Item;
    if (itemsEqual(pLast, nLast)) return { kind: 'skip' };
    // time이 바뀌면 update() 불가 — lwc의 update({time})는 time > 현재 마지막이면 replace가
    // 아니라 append라, 같은 길이인데 시리즈가 +1 바 늘어 모델과 어긋난다(phantom bar).
    // 같은 길이의 tail 변경은 같은 버킷의 value/color 변경(time 동일)일 때만 update.
    if (pLast.time !== nLast.time) return { kind: 'setData' };
    if (isWhitespace(nLast)) return { kind: 'setData' };
    return { kind: 'update', point: next[last] };
  }

  if (next.length === prev.length + 1) {
    // prefix [0..prev.length-1] 동일하면 1개 append.
    for (let i = 0; i < prev.length; i++) {
      if (!itemsEqual(prev[i] as unknown as Item, next[i] as unknown as Item)) return { kind: 'setData' };
    }
    const appended = next[next.length - 1];
    if (isWhitespace(appended as unknown as Item)) return { kind: 'setData' };
    return { kind: 'update', point: appended };
  }

  // 길이 축소, 2개+ append, 그 외 모든 변화 → 안전하게 전체 교체.
  return { kind: 'setData' };
}

/** syncSeriesData 가 구동하는 최소 sink — 호출하는 lwc 메서드 딱 둘. 전체
 *  `ISeriesApi<SeriesType>` 로 타이핑하지 않는 이유: lightweight-charts 의 union-typed
 *  `setData` 가 `SeriesType` 분배 하에서 파라미터가 `never` 로 붕괴한다(차트 시리즈
 *  타입 결함). 호출자의 `ISeriesApi<any>` 는 이 구조적 모양을 만족하므로 그대로 넘긴다. */
export interface SeriesDataSink {
  setData(data: SeriesItem[]): void;
  update(point: SeriesItem): void;
}

/**
 * 새 투영을 가장 싼 올바른 방법으로 시리즈에 적용하고, 다음 diff 를 위해 캐시할 값을
 * 돌려준다. 이 함수가 데이터 effect 가 건너는 **seam** 이다 — skip/update/setData
 * **결정**(classifyDataChange), 시리즈 **변경**, **캐시 갱신**이 전부 여기 모여,
 * "캐시 배열 == 시리즈가 현재 들고 있는 데이터" 불변식이 React effect 에 흩어지지 않고
 * 한 곳에서 강제·테스트된다. skip 이면 `prev` 를 그대로 돌려준다(시리즈가 이미 그 값을
 * 들고 있으므로 캐시 불변), update/setData 후엔 `next` 를 돌려준다.
 *
 * 적용은 classifyDataChange 의 안전성 보증을 그대로 물려받는다: update 는 이전 원소가
 * 하나도 안 바뀐 게 증명될 때만 호출되므로 setData 와 동치, 틀린 차트는 구조상 불가능.
 */
export function syncSeriesData(
  sink: SeriesDataSink,
  prev: readonly SeriesItem[] | null,
  next: SeriesItem[],
): readonly SeriesItem[] | null {
  const decision = classifyDataChange(prev, next);
  if (decision.kind === 'skip') return prev;
  if (decision.kind === 'update') sink.update(decision.point);
  else sink.setData(next);
  return next;
}
