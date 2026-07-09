import type { DepthHeatmapPointWire } from '../api/types';

export type DepthHeatmapLevel = { price: number; qty: number };
export type DepthHeatmapPoint = {
  tMs: number;
  asks: DepthHeatmapLevel[];
  bids: DepthHeatmapLevel[];
  asksMax: DepthHeatmapLevel[];
  bidsMax: DepthHeatmapLevel[];
};

function levels(pairs: readonly [number, number][]): DepthHeatmapLevel[] {
  return pairs.map(([price, qty]) => ({ price, qty }));
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
