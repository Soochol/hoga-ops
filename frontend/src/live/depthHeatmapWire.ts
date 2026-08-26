import type { DepthHeatmapPointWire } from '../api/types';

export type DepthHeatmapLevel = { price: number; qty: number };
export type DepthHeatmapPoint = {
  tMs: number;
  asks: DepthHeatmapLevel[];
  bids: DepthHeatmapLevel[];
  asksMax: DepthHeatmapLevel[];
  bidsMax: DepthHeatmapLevel[];
  /** 가격대마다 따로 잰 최댓값(wire `asks_price_max`). `asksMax` 와 **축이 다르다** —
   *  저쪽은 총잔량이 최대였던 순간의 사진 한 장이고 이쪽은 가격마다 자기 최고점이다.
   *  길이가 10 고정이 아니다. wire 가 optional 이라(구 디스크 캐시·구 백엔드) 여기서도
   *  optional 이다 — 없으면 그 모드의 셀이 없다. */
  asksPriceMax?: DepthHeatmapLevel[];
  bidsPriceMax?: DepthHeatmapLevel[];
};

function levels(pairs: readonly [number, number][]): DepthHeatmapLevel[] {
  return pairs.map(([price, qty]) => ({ price, qty }));
}

/**
 * 히트맵이 그릴 수 있는 세 소스.
 *
 * - `close` — 분봉 **종가** 호가창(기본).
 * - `peakSnapshot` — 그 분에서 **총잔량**이 최대였던 순간의 호가창 **한 장**.
 * - `perPriceMax` — **가격대마다 따로** 잰 최댓값. 「당일 최대벽」과 같은 값이지만
 *   한 세로줄이 실제로 동시에 존재한 호가창은 아니다.
 *
 * 앞 둘은 실재한 호가창이고 셋째는 합성이다 — 그 교환이 이 모드의 전부다.
 */
export type DepthHeatmapSource = 'close' | 'peakSnapshot' | 'perPriceMax';

/** 두 토글 → 소스. 자식(`perPriceMax`)은 부모(`intraMax`) 아래에 게이트돼 있으므로
 *  부모가 꺼진 상태의 자식 값은 **무의미하고, 여기서 그 사실이 강제된다**. UI 는
 *  `enabledBy` 로 그 조합을 못 만들지만, 이 함수를 쓰는 쪽은 그걸 몰라도 된다. */
export function depthHeatmapSourceOf(
  intraMax: boolean,
  perPriceMax: boolean,
): DepthHeatmapSource {
  if (!intraMax) return 'close';
  return perPriceMax ? 'perPriceMax' : 'peakSnapshot';
}

/**
 * 한 point 에서 소스에 맞는 레벨 배열을 고른다 — **셀 빌드·레전드·강도 정규화·
 * halfTick 이 전부 이 함수를 통과해야 한다.**
 *
 * 종전엔 네 곳이 각자 `intraMax ? pt.asksMax : pt.asks` 를 적고 있었고, 셋째 소스가
 * 생기면 그 삼항식 넷이 각자 갈릴 자리다. 특히 강도 정규화는 셀이 쓰는 소스와
 * 어긋나는 순간 색 스케일이 조용히 틀어진다(`depthHeatmapAlpha` 머리말의 불변식).
 */
export function depthLevelsOf(
  point: DepthHeatmapPoint,
  side: 'ask' | 'bid',
  source: DepthHeatmapSource,
): DepthHeatmapLevel[] {
  if (side === 'ask') {
    if (source === 'perPriceMax') return point.asksPriceMax ?? [];
    return source === 'peakSnapshot' ? point.asksMax : point.asks;
  }
  if (source === 'perPriceMax') return point.bidsPriceMax ?? [];
  return source === 'peakSnapshot' ? point.bidsMax : point.bids;
}

// wire→domain 변환 캐시. SSE 틱마다 merge 로 새 배열이 만들어져도 원소(wire point)
// 참조는 안정적이므로(과거는 pastBundle 통과·오늘은 IncrementalHogaBucketer 안정
// point → depthPointToWire WeakMap), 미변경 point 는 domain 객체를 재할당하지 않는다.
// 틱당 신규 도메인 객체 = 실제 바뀐 버킷뿐(기존: 전 구간 재변환).
const _domainCache = new WeakMap<DepthHeatmapPointWire, DepthHeatmapPoint>();

export function depthHeatmapFromWire(
  points: readonly DepthHeatmapPointWire[] | null | undefined,
): DepthHeatmapPoint[] {
  return (points ?? []).map((p) => {
    const cached = _domainCache.get(p);
    if (cached) return cached;
    const domain: DepthHeatmapPoint = {
      tMs: p.t_ms,
      asks: levels(p.asks),
      bids: levels(p.bids),
      asksMax: levels(p.asks_max ?? []),
      bidsMax: levels(p.bids_max ?? []),
      asksPriceMax: levels(p.asks_price_max ?? []),
      bidsPriceMax: levels(p.bids_price_max ?? []),
    };
    _domainCache.set(p, domain);
    return domain;
  });
}

function pairs(ls: readonly DepthHeatmapLevel[]): [number, number][] {
  return ls.map((l) => [l.price, l.qty]);
}

// domain→wire 변환 캐시. IncrementalHogaBucketer 가 미변경 버킷에 안정적인 point
// 참조를 주므로(위 불변식), 매 틱 mergeDepthHeatmapToday 가 오늘 전 버킷을 재변환하던
// 것을 실제 바뀐 버킷 1개로 줄인다.
const _wireCache = new WeakMap<DepthHeatmapPoint, DepthHeatmapPointWire>();

/** Live domain depth-heatmap point → wire (camelCase levels → [price, qty]). */
export function depthPointToWire(p: DepthHeatmapPoint): DepthHeatmapPointWire {
  const cached = _wireCache.get(p);
  if (cached) return cached;
  const wire: DepthHeatmapPointWire = {
    t_ms: p.tMs,
    asks: pairs(p.asks),
    bids: pairs(p.bids),
    asks_max: pairs(p.asksMax),
    bids_max: pairs(p.bidsMax),
    asks_price_max: pairs(p.asksPriceMax ?? []),
    bids_price_max: pairs(p.bidsPriceMax ?? []),
  };
  _wireCache.set(p, wire);
  return wire;
}

/** Overlay today's live-ratcheted depth buckets on top of the sidecar's
 * PAST+today-so-far wire array. Dedup by `t_ms`, ascending; today (live) wins
 * per overlapping bucket — mirrors `api/range.ts`'s depth_heatmap uniqueBy
 * latest-wins and the `mergePriceLevelHits` overlay. Past wire points pass
 * through untouched (same reference); today domain points convert to wire. */
export function mergeDepthHeatmapToday(
  past: readonly DepthHeatmapPointWire[] | undefined,
  today: readonly DepthHeatmapPoint[],
): DepthHeatmapPointWire[] {
  const byT = new Map<number, DepthHeatmapPointWire>();
  for (const p of past ?? []) byT.set(p.t_ms, p);
  for (const p of today) byT.set(p.tMs, depthPointToWire(p)); // today wins
  return [...byT.values()].sort((a, b) => a.t_ms - b.t_ms);
}
