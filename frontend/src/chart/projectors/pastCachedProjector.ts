import type { RangeBundle } from '../../api/types';
import type { VirtualAxis } from '../../util/virtualAxis';

/**
 * /live 호가 보조지표(호가비·총잔량·체결강도)의 틱당 풀-배열 재투영을 없애는
 * 과거/당일 분리 캐시. (CONTEXT.md "라이브 호가 보조지표 — 과거/당일 분리 캐시")
 *
 * 동기: SSE 틱(150ms)마다 `bundle.quote_ratio.points` / `fill_strength.points`
 * 전체(과거+당일)를 재투영했다. 과거 points는 장중 불변(5분 `/api/range` refetch
 * 또는 좌측 팬 때만 변함)인데도 매 틱 다시 그려, 90일 딥스크롤에서 36ms/틱(244ms/초)을
 * 태웠다(측정). 당일 세그먼트만 매 틱 변하므로, 과거 투영을 캐시하고 당일만 재투영하면
 * 틱당 비용이 히스토리 깊이와 무관해진다(측정 ~33× — hogaIndicators.perf.test.ts [E]).
 *
 * 정확성 불변식: 캐시 경로의 `project(past) ++ project(today)` 는 풀 배열 투영과
 * 바이트 동일해야 한다. 기본 가정은 projector가 하루 경계 너머 상태를 들고 가지
 * 않는다는 것인데, synthetic hidden-gap sentinel처럼 "당일 첫 visible emit이
 * 직전 emitted 점의 OUTGOING connector를 소급 마스킹"하는 1점 lookback은 예외다.
 * 그런 projector는 `boundaryLookbackPatch` 로 경계의 마지막 과거 emit만 같은
 * 숨김 색으로 패치한다. 누적 체결강도(projectCumulativeNetFill)는 runningSum이
 * 후속 전부에 의존하므로 이 헬퍼로 감싸지 않는다 — 세그먼트 단위 캐시를 따로 쓴다.
 *
 * 캐시 키 = (axis 식별자, ctx 식별자, 과거 점 개수, 과거 마지막 t). axis는 segments에서
 * 파생되어 줌/팬에 안정(LiveChartRoot per-viewKey memo)하고 좌측 팬으로 과거가 늘면 새
 * 객체가 된다. ctx는 useShallow로 안정. 과거 점 개수+마지막 t는 refetch 증분/팬 prepend를
 * 잡는다. (가정: 과거 버킷은 promote 후 불변 — 길이 불변인 채 중간 값만 바뀌는 백필은
 * 이 데이터 모델에 없음. bucketHogaSeries는 append-only 라이브 버퍼에서만 증분.)
 */

interface CacheEntry<Ctx, D> {
  ctx: Ctx;
  pastLen: number;
  pastLastT: number;
  pastData: D[];
}

interface BoundaryLookbackPatch<P extends { t: number }, D> {
  shouldPatchBoundary: (firstVisibleTodayPoint: P) => boolean;
  patchPastTail: Partial<D>;
}

interface SliceExpansionArgs<P extends { t: number }> {
  bundle: RangeBundle;
  points: readonly P[];
  allPoints: readonly P[];
  fromT?: number;
  toT?: number;
  splitT?: number;
}

type SliceExpander<P extends { t: number }> = (args: SliceExpansionArgs<P>) => readonly P[];

/** points[i].t >= t 인 첫 index (points는 t 오름차순). 이진 탐색. */
export function lowerBoundT<P extends { t: number }>(points: readonly P[], t: number): number {
  let lo = 0;
  let hi = points.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (points[mid].t < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function makePastCachedProjector<P extends { t: number }, Ctx, D>(
  projectPoints: (points: readonly P[], axis: VirtualAxis, ctx: Ctx) => D[],
  getPoints: (bundle: RangeBundle) => readonly P[],
  boundaryLookbackPatch?: BoundaryLookbackPatch<P, D>,
  expandPoints?: SliceExpander<P>,
): (bundle: RangeBundle, axis: VirtualAxis, ctx: Ctx) => D[] {
  // axis 식별자별 캐시(WeakMap → 차트/뷰 교체 시 자동 GC, 동시 차트 간 충돌 없음).
  const cache = new WeakMap<VirtualAxis, CacheEntry<Ctx, D>>();
  const expandSlice: SliceExpander<P> = expandPoints ?? (({ points }) => points);
  return (bundle, axis, ctx) => {
    const points = getPoints(bundle);
    const segs = bundle.segments;
    // 세그먼트가 1개 이하면 "과거"가 없어 분리 이득이 없다 — 풀 투영.
    if (segs.length < 2) {
      return projectPoints(expandSlice({ bundle, points, allPoints: points }), axis, ctx);
    }

    const todayOpen = segs[segs.length - 1].session_open_ms;
    const splitIdx = lowerBoundT(points, todayOpen);
    const past = points.slice(0, splitIdx);
    const today = points.slice(splitIdx);
    const pastLen = past.length;
    const pastLastT = pastLen > 0 ? past[pastLen - 1].t : 0;

    let entry = cache.get(axis);
    if (!entry || entry.ctx !== ctx || entry.pastLen !== pastLen || entry.pastLastT !== pastLastT) {
      const expandedPast = expandSlice({
        bundle,
        points: past,
        allPoints: points,
        toT: todayOpen,
        splitT: todayOpen,
      });
      entry = { ctx, pastLen, pastLastT, pastData: projectPoints(expandedPast, axis, ctx) };
      cache.set(axis, entry);
    }
    const expandedToday = expandSlice({
      bundle,
      points: today,
      allPoints: points,
      fromT: todayOpen,
      splitT: todayOpen,
    });
    const todayData = projectPoints(expandedToday, axis, ctx);
    if (boundaryLookbackPatch && entry.pastData.length > 0) {
      const firstVisibleTodayPoint = expandedToday.find((p) => axis.contains(p.t));
      if (firstVisibleTodayPoint && boundaryLookbackPatch.shouldPatchBoundary(firstVisibleTodayPoint)) {
        const patchedPastTail = {
          ...entry.pastData[entry.pastData.length - 1],
          ...boundaryLookbackPatch.patchPastTail,
        } as D;
        return entry.pastData.slice(0, -1).concat(patchedPastTail, todayData);
      }
    }
    // 과거(동결) + 당일(매 틱 재투영). concat은 O(N) 참조 복사이나 투영보다 훨씬 싸다.
    return entry.pastData.concat(todayData);
  };
}
