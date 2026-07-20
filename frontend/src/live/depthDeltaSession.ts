import type { DepthDeltaPointWire } from '../api/types';
import type { DepthDeltaPoint } from './depthDelta';

/** 세션 누적: 15분 슬라이딩 버퍼가 버린 과거 버킷을 살려 둔다.
 *
 * `bucketDepthDelta`(및 증분 미러)의 입력인 `live.ob` 는 `RETENTION_MS = 15분`
 * 시간창이라, 그 출력만 그리면 지표 커버리지가 "오늘"이 아니라 **"최근 15분"** 이 된다.
 * 자매 지표인 히트맵은 `mergeDepthHeatmapToday` 가 백엔드 range(과거일+오늘) 와 봉합해
 * 하루를 커버하지만, 증감은 과거일 소스가 없어 그 봉합 상대가 없다. 그래서 프론트가
 * 세션 동안 계산된 버킷을 직접 누적한다 — 보관하는 것은 **버킷 결과뿐**이고 원본
 * 스냅샷은 그대로 버려지므로 메모리는 분당 point 1개 수준이다.
 *
 * ⚠️ 이 누적은 `IncrementalHogaBucketer` **바깥**에 있어야 한다. 버킷터 안에 두면
 * "오라클 파리티는 현재 배열에 대해서만 정의된다"는 계약(buildLiveBundle)이 깨진다.
 * 버킷터는 계속 현재 창만 보고 오라클과 일치하고, 그 출력을 여기서 흡수한다.
 */

/** 확정 버킷은 **이전 값을 지킨다**. 버퍼가 앞을 잘라내면 그 버킷은 남은 스냅샷만으로
 *  재계산돼 값이 줄어드는데(baseline 도 사라짐), 그 부분값이 완전값을 덮으면 과거
 *  구간의 증감이 시간이 갈수록 야금야금 작아진다. 활성(최신) 버킷만 fresh 로 갱신한다 —
 *  그쪽은 계속 자라는 중이라 항상 fresh 가 더 완전하다.
 *
 *  반환은 변화가 없으면 `prev` 를 **그대로** 돌려준다(참조 안정 → 하류 memo 유지).
 *  fresh 가 비면(콜드 홀드·비분봉) 누적본을 지우지 않고 그대로 유지한다. */
export function mergeDepthDeltaSession(
  prev: readonly DepthDeltaPoint[],
  fresh: readonly DepthDeltaPoint[],
): readonly DepthDeltaPoint[] {
  if (fresh.length === 0) return prev;

  // fresh 는 tMs 오름차순이라 마지막이 활성 버킷.
  const activeT = fresh[fresh.length - 1].tMs;
  const byT = new Map<number, DepthDeltaPoint>();
  for (const p of prev) byT.set(p.tMs, p);

  let changed = false;
  for (const p of fresh) {
    const existing = byT.get(p.tMs);
    if (existing === undefined) {
      byT.set(p.tMs, p);
      changed = true;
      continue;
    }
    // 확정 버킷: 이전 값 유지(재계산 축소분이 덮지 않게).
    if (p.tMs < activeT) continue;
    // 활성 버킷: 내용이 실제로 바뀌었을 때만 교체 — 버킷터가 미변경 버킷에 안정적인
    // 참조를 주므로 참조 비교로 충분하다.
    if (existing !== p) {
      byT.set(p.tMs, p);
      changed = true;
    }
  }
  if (!changed) return prev;

  return [...byT.values()].sort((a, b) => a.tMs - b.tMs);
}

// wire→domain 변환 캐시 — 백엔드 point 는 chartBundle 갱신 시에만 새 참조가 되므로
// (SSE 틱 무관), 미변경 wire point 의 도메인 객체를 재할당하지 않는다
// (depthHeatmapWire 의 _domainCache 관용구).
const _domainCache = new WeakMap<DepthDeltaPointWire, DepthDeltaPoint>();

/** 백엔드 DepthDeltaPointWire[] → 도메인. [price, in, out] 트리플을 레벨 객체로. */
export function depthDeltaFromWire(
  points: readonly DepthDeltaPointWire[] | null | undefined,
): DepthDeltaPoint[] {
  return (points ?? []).map((p) => {
    const cached = _domainCache.get(p);
    if (cached) return cached;
    const domain: DepthDeltaPoint = {
      tMs: p.t_ms,
      askDelta: p.asks.map(([price, inQty, outQty]) => ({ price, inQty, outQty })),
      bidDelta: p.bids.map(([price, inQty, outQty]) => ({ price, inQty, outQty })),
      askTick: p.ask_tick,
      bidTick: p.bid_tick,
    };
    _domainCache.set(p, domain);
    return domain;
  });
}

/** 백엔드(캡처 ~10s 샘플) 버킷 위에 라이브 세션 누적(WS 틱 정밀)을 얹는다.
 *
 * 겹치는 버킷은 **라이브가 이긴다** — 단, 라이브의 첫 버킷만 예외다. 페이지를 연
 * 시점이 버킷 중간이면 라이브 첫 버킷은 앞부분 틱을 놓친 부분값인데, 백엔드는 그
 * 버킷 전체를 (성긴 표본으로나마) 커버한다. "부분 정밀값 vs 전체 성긴값" 중
 * 전체 쪽이 사용자 기대(그 분의 증감)에 가깝다. 둘째 버킷부터는 라이브가 완전하고
 * 더 정밀하므로 라이브가 덮는다.
 *
 * 참조 안정: 입력이 안 바뀌면(useMemo 대상) 호출부가 재호출하지 않으므로 여기서는
 * 병합 결과만 새로 만든다 — 미변경 point 참조는 양쪽 입력의 것이 그대로 흐른다. */
export function combineDepthDeltaBackendLive(
  backend: readonly DepthDeltaPoint[],
  live: readonly DepthDeltaPoint[],
): DepthDeltaPoint[] {
  if (live.length === 0) return [...backend];
  if (backend.length === 0) return [...live];
  const liveFirstT = live[0].tMs;
  const byT = new Map<number, DepthDeltaPoint>();
  for (const p of backend) byT.set(p.tMs, p);
  for (const p of live) {
    if (p.tMs === liveFirstT && byT.has(p.tMs)) continue; // 라이브 첫(부분) 버킷은 백엔드 유지
    byT.set(p.tMs, p);
  }
  return [...byT.values()].sort((a, b) => a.tMs - b.tMs);
}
