import {
  LineSeries,
  type LineData,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import type { ProgramTradePoint, QuoteRatioPoint, RangeBundle } from '../../api/types';
import { type VirtualAxis } from '../../util/virtualAxis';
import { resolveTokensThemed } from '../../util/tokens';
import { formatKoreanWonEok } from '../../util/koreanNumber';
import type { PaneSpec } from '../RangeSeriesPane';
import { isSyntheticHogaGapPoint } from '../util/hogaGapHide';
import { LINE_HIDDEN_COLOR, maskOutgoingConnector } from '../util/auctionHide';
import { addZeroBaselineGuide, includeZeroAutoscale } from '../util/zeroBaseline';
import { lowerBoundT } from './pastCachedProjector';

const TOKEN_SPEC = {
  line: ['--accent', '#F0B429'],
  // 0선은 데이터가 아니라 참조선이므로 중립색 — 호가비 pane 과 동일 토큰.
  baseline: ['--fg-dimmer', '#63636F'],
} as const;

// Color is series-level (thunked in the spec below); the data is value-only.
const lineOptions = () => ({
  color: resolveTokensThemed(TOKEN_SPEC).line,
  lineWidth: 2,
  priceFormat: {
    type: 'custom' as const,
    formatter: (v: number) => formatKoreanWonEok(v),
    minMove: 1,
  },
  priceScaleId: 'right' as const,
  // net_amount 는 당일 **누적** 순매수라 한쪽으로만 쌓인 구간을 확대하면 0 이
  // 보이는 범위 밖으로 밀린다 — 정작 부호를 읽어야 할 때 기준선이 사라진다.
  autoscaleInfoProvider: includeZeroAutoscale,
  // 라이브러리 기본 수평선 + 가격축 최신값 칩을 둘 다 끈다(DESIGN.md 2026-05-23).
  // 값은 Pane Legend 로 읽는다 — 커서가 있으면 그 시점, 없으면 최신(2026-08-18 에
  // `LEGEND_CELL_PANES` 에 이 pane 을 넣었다). 축 칩을 같이 켜 두면 갱신 주기가 달라
  // 같은 시리즈가 두 숫자로 보인다.
  priceLineVisible: false,
  lastValueVisible: false,
});

/**
 * 한 세그먼트에서 **점마다 다시 계산하지 않아도 되는 것**을 미리 뽑아 둔 것.
 *
 * 종전엔 점 하나마다 `bundle.segments.find(...)` 를 돌렸고, 그것도 세 군데
 * (`bucketTime`·`segmentDate`·`isKrxRegularProgramTime`)에서 각각 돌렸다. 세그먼트가
 * 날짜순이라 `.find()` 는 평균 S/2 를 훑으므로 전체가 O(N×S) 였다 — 90일(35,100점 ·
 * 90세그먼트) 실측 3.78ms/틱이 이 조회에만 들었다. 게다가 `regularSessionBoundsForDate`
 * 는 날짜 문자열 파싱이라 점마다 정규식 + `Date.UTC` 를 다시 냈다.
 *
 * 세그먼트당 한 번 계산해 두면 점당 비용이 이진 탐색 O(log S) + 산술로 떨어진다.
 */
type SegmentMeta = {
  openMs: number;
  closeMs: number;
  date: string;
  /** KRX 정규장 하한(그 날짜 00:00 UTC 기준). 날짜가 YYYYMMDD 가 아니면 null =
   *  "정규장 경계를 모름" → 종전과 같이 시간 필터를 통과시킨다. */
  regularOpen: number | null;
  /** 마감 동시호가 시작(정규장 마감 −10분). `regularOpen` 과 항상 짝이다. */
  regularAuctionStart: number;
};

/** `bundle.segments` 배열 **식별자**로 메타를 캐시한다 — segments 는 chartBundle 에서
 *  오고 SSE 틱에 안정이라, 틱당 재계산이 사라진다. WeakMap 이라 번들 교체 시 자동 GC. */
const metaCache = new WeakMap<object, SegmentMeta[]>();

function segmentMetas(segments: RangeBundle['segments']): SegmentMeta[] {
  const hit = metaCache.get(segments);
  if (hit) return hit;
  const metas = segments.map((s) => {
    const regular = regularSessionBoundsForDate(s.date);
    return {
      openMs: s.session_open_ms,
      closeMs: s.session_close_ms,
      date: s.date,
      regularOpen: regular ? regular.open : null,
      regularAuctionStart: regular ? regular.close - 10 * 60_000 : 0,
    };
  });
  metaCache.set(segments, metas);
  return metas;
}

/**
 * `t` 를 품는 세그먼트의 index, 없으면 -1. **`segments.find(...)` 와 글자 그대로 같은
 * 판정**(`openMs <= t && t <= closeMs`, 마감 포함)이되 이진 탐색이다.
 *
 * 전제는 세그먼트가 **`session_open_ms` 오름차순 · 서로 겹치지 않음** — `buildChartBundle`
 * 이 거래일 날짜를 `sort()` 한 뒤 오늘을 뒤에 붙여 만들므로 구조적으로 성립한다.
 * 세그먼트 사이 **간극**(장 마감~다음 개장)의 `t` 는 `.find()` 가 undefined 를 주므로
 * 여기서도 -1 이어야 한다 — 그래서 "직전 세그먼트" 를 찾은 뒤 `t <= closeMs` 로 **한 번 더
 * 확인**한다. 이 확인을 빼면 간극의 점이 직전 세그먼트로 빨려 들어가 조용히 값이 바뀐다.
 */
export function findSegmentIdxByTime(metas: readonly SegmentMeta[], t: number): number {
  let lo = 0;
  let hi = metas.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (metas[mid].openMs <= t) lo = mid + 1;
    else hi = mid;
  }
  const i = lo - 1; // openMs <= t 인 마지막 세그먼트
  return i >= 0 && t <= metas[i].closeMs ? i : -1;
}

/** 한 청크(과거 또는 당일)의 방출 결과. `lastDate`·`maskedPrevAtStart` 는 청크 경계를
 *  넘겨야 하는 상태다 — 날짜가 바뀌는 지점에서 **직전 방출점의 나가는 선**을 투명으로
 *  덮는 규칙이 청크를 가로지르기 때문. 자세한 근거는 `makeCachedProgramTradeProjector`. */
type ProgramChunk = {
  out: LineData<Time>[];
  lastDate: string | null;
  /** 이 청크의 **첫 동작**이 "직전 점 마스킹" 이었는가. 청크 안엔 덮을 직전 점이 없으니
   *  호출부가 과거 청크의 꼬리를 대신 덮는다. */
  maskedPrevAtStart: boolean;
};

function projectProgramChunk(
  quotePoints: readonly QuoteRatioPoint[],
  byBucket: ReadonlyMap<number, number>,
  metas: readonly SegmentMeta[],
  bucketMs: number,
  axis: VirtualAxis,
  initialLastDate: string | null,
): ProgramChunk {
  const out: LineData<Time>[] = [];
  const seenHogaT = new Set<number>();
  let lastEmittedDate = initialLastDate;
  let maskedPrevAtStart = false;
  const maskPrev = (): void => {
    if (out.length === 0) maskedPrevAtStart = true;
    else maskOutgoingConnector(out, LINE_HIDDEN_COLOR);
  };
  for (const p of quotePoints) {
    const si = findSegmentIdxByTime(metas, p.t);
    if (si < 0) continue;
    const meta = metas[si];
    const hogaT = meta.openMs + Math.floor((p.t - meta.openMs) / bucketMs) * bucketMs;
    if (seenHogaT.has(hogaT)) continue;
    seenHogaT.add(hogaT);
    // 축 조회 1회 — `classifyAndProject` 가 `contains`·`inClosingAuctionWindow`·`toVirtual`
    // 을 한 번의 이진 탐색으로 준다. 근거·실측은 `chart/util/auctionHide.ts` 의
    // `isAuctionHidden` 경고 참조. 계약은 `candle.perf.test.ts` 가 호출 횟수로 잠근다.
    const at = axis.classifyAndProject(hogaT);
    if (!at.contained) continue;
    const time = (at.virtual / 1000) as UTCTimestamp;
    if (isSyntheticHogaGapPoint(p)) {
      maskPrev();
      out.push({ time, value: 0, ...LINE_HIDDEN_COLOR });
      continue;
    }
    const value = byBucket.get(hogaT);
    if (value == null) continue;
    // 종전엔 `segmentDate(bundle, hogaT)` 로 다시 찾았다. `hogaT` 는 같은 세그먼트의
    // 버킷 시작(`openMs <= hogaT <= p.t <= closeMs`)이라 `meta.date` 와 항상 같다.
    const date = meta.date;
    if (lastEmittedDate != null && date !== lastEmittedDate) maskPrev();
    out.push({ time, value });
    lastEmittedDate = date;
  }
  return { out, lastDate: lastEmittedDate, maskedPrevAtStart };
}

/** 프로그램 순매수 버킷 맵 — `t` → 그 버킷의 당일 누적 순매수(원). 같은 버킷에 여러 점이
 *  오면 **뒤에 오는 것이 이긴다**(종전 `byBucket.set` 과 동일). */
function programByBucket(
  points: readonly ProgramTradePoint[],
  metas: readonly SegmentMeta[],
  bucketMs: number,
  axis: VirtualAxis,
): Map<number, number> {
  const byBucket = new Map<number, number>();
  for (const p of points) {
    if (p.net_amount == null) continue;
    const si = findSegmentIdxByTime(metas, p.t);
    if (si < 0) continue;
    const meta = metas[si];
    // KRX 정규장 창 필터. 경계를 모르면(날짜 형식 이상) 통과 — 종전과 동일.
    if (meta.regularOpen != null && !(p.t >= meta.regularOpen && p.t < meta.regularAuctionStart)) continue;
    const t = meta.openMs + Math.floor((p.t - meta.openMs) / bucketMs) * bucketMs;
    if (!axis.contains(t)) continue;
    byBucket.set(t, p.net_amount);
  }
  return byBucket;
}

export function projectProgramTradeNetAmount(
  bundle: RangeBundle,
  axis: VirtualAxis,
): LineData<Time>[] {
  const points = bundle.program_trade?.points ?? [];
  if (points.length === 0) return [];
  const metas = segmentMetas(bundle.segments);
  const bucketMs = Math.max(1, bundle.bucket_ms || 1);
  const byBucket = programByBucket(points, metas, bucketMs, axis);
  // 종전엔 여기서 `[...bundle.quote_ratio.points].sort(...)` 로 방어 정렬을 했다.
  // quote_ratio 는 t 오름차순이라는 리포 전역 불변식 위에 있고(`lowerBoundT` 이진탐색이
  // 이미 같은 전제다) 이 복사·정렬이 90일에서 0.44ms/틱을 태웠다 — PR #1427 과 같은 정리.
  return projectProgramChunk(bundle.quote_ratio.points, byBucket, metas, bucketMs, axis, null).out;
}

/**
 * `projectProgramTradeNetAmount` 의 과거/당일 분리 캐시판.
 *
 * 이 pane 은 분봉 기본 ON 인데 **캐시가 없는 마지막 pane 프로젝터였다** — SSE 틱(150ms)
 * 마다 과거+당일 전체를 재투영했다. 90일(35,100점·90세그먼트) 실측 13.95ms/틱이고,
 * 단일 지배 항목이 없다(세그먼트 조회 3.78 · Set/Map 4.85 · 정렬 0.44 · 방출 나머지).
 * 전부 O(N) 이라 상수를 깎는 것만으론 한계가 있고, 분리 캐시가 넷을 한꺼번에 O(오늘)로
 * 만든다.
 *
 * **`makePastCachedProjector` 를 쓸 수 없는 이유**: 그 헬퍼는 배열 **하나**를 가르는데
 * 이 프로젝터는 둘(`program_trade.points` + `quote_ratio.points`)을 읽는다. 같은 모양의
 * 선례가 `makeCachedBrokerLateEntryProjector` 라 그 관용구를 따른다.
 *
 * 정확성 불변식 — `cachedPast ++ project(today) === 풀 투영`. 청크를 가로지르는 상태가
 * **둘** 있고 각각 이렇게 옮긴다:
 *  1. `lastEmittedDate` — 날짜가 바뀌면 직전 방출점의 나가는 선을 투명으로 덮는 규칙의
 *     기준. 과거 청크의 최종 값을 캐시에 실어 당일 청크의 시작값으로 넘긴다.
 *  2. **경계 마스킹** — 당일 첫 방출이 곧 날짜 변경이라 거의 항상 "직전 점"(= 과거 청크의
 *     꼬리)을 덮어야 한다. 당일 청크 안엔 덮을 점이 없으므로 `maskedPrevAtStart` 로
 *     올려 보내 호출부가 과거 꼬리 **사본**을 덮는다(캐시 배열 자체는 불변으로 둔다).
 *     이 처리를 빼면 이음매에서 전날 마지막 값이 오늘 첫 값으로 **비스듬히 이어진다**.
 *
 * 분리가 안전한 나머지 근거:
 *  - `seenHogaT` 중복 제거는 청크별로 나눠도 같다 — 버킷 t 는 자기 세그먼트 안에서
 *    만들어지므로 과거 버킷과 당일 버킷이 겹칠 수 없다.
 *  - `byBucket` 도 같은 이유로 분할 가능하고, 같은 버킷 내 "뒤가 이긴다" 는 청크 안에서
 *    배열 순서가 보존되므로 유지된다.
 *
 * 실시간 병합은 새 program_trade 배열을 만든다. 전체 배열 식별자 대신 과거 원소
 * 참조를 비교해 꼬리 변경에서는 과거를 재사용한다. 과거 프로그램/호가 원소가
 * 교체되면 중간 정정·결손 마스킹 변경도 재투영한다. 입력 원소는 불변이며,
 * 참조 비교와 최종 concat은 O(N), 버킷 계산·축 투영은 캐시 적중 시 당일만 수행한다.
 */
export function makeCachedProgramTradeProjector(): (
  bundle: RangeBundle,
  axis: VirtualAxis,
) => LineData<Time>[] {
  const cache = new WeakMap<VirtualAxis, {
    code: string;
    pastProgram: readonly ProgramTradePoint[];
    pastQuotePoints: readonly QuoteRatioPoint[];
    segments: RangeBundle['segments'];
    bucketMs: number;
    todayOpen: number;
    pastQuoteLen: number;
    pastQuoteLastT: number;
    pastData: LineData<Time>[];
    pastLastDate: string | null;
  }>();
  return (bundle, axis) => {
    const programPoints = bundle.program_trade?.points ?? [];
    if (programPoints.length === 0) return [];
    const segs = bundle.segments;
    // 세그먼트가 1개 이하면 "과거" 가 없어 분리 이득이 없다 — 풀 투영.
    if (!segs || segs.length < 2) return projectProgramTradeNetAmount(bundle, axis);

    const metas = segmentMetas(segs);
    const bucketMs = Math.max(1, bundle.bucket_ms || 1);
    const todayOpen = segs[segs.length - 1].session_open_ms;
    const quotePoints = bundle.quote_ratio.points;
    const splitIdx = lowerBoundT(quotePoints, todayOpen);
    const pastQuoteLen = splitIdx;
    const pastQuoteLastT = pastQuoteLen > 0 ? quotePoints[pastQuoteLen - 1].t : 0;

    let entry = cache.get(axis);
    let samePastProgram = entry !== undefined;
    let pastProgramCount = 0;
    const todayProgram: ProgramTradePoint[] = [];
    // 입력 순서를 보존한다. 같은 버킷의 last-wins는 원시/저장뷰 입력에서도 동일해야 한다.
    for (const point of programPoints) {
      if (point.t < todayOpen) {
        if (entry?.pastProgram[pastProgramCount] !== point) samePastProgram = false;
        pastProgramCount += 1;
      } else todayProgram.push(point);
    }
    if (
      !entry
      || entry.code !== bundle.code
      || !samePastProgram || entry.pastProgram.length !== pastProgramCount
      || !sameQuotePrefix(entry.pastQuotePoints, quotePoints, splitIdx)
      || entry.segments !== segs
      || entry.bucketMs !== bucketMs
      || entry.todayOpen !== todayOpen
      || entry.pastQuoteLen !== pastQuoteLen
      || entry.pastQuoteLastT !== pastQuoteLastT
    ) {
      const pastProgram = programPoints.filter((p) => p.t < todayOpen);
      const pastQuotePoints = quotePoints.slice(0, splitIdx);
      const pastChunk = projectProgramChunk(
        pastQuotePoints,
        programByBucket(pastProgram, metas, bucketMs, axis),
        metas, bucketMs, axis, null,
      );
      entry = {
        code: bundle.code, pastProgram, pastQuotePoints, segments: segs, bucketMs, todayOpen,
        pastQuoteLen, pastQuoteLastT,
        pastData: pastChunk.out, pastLastDate: pastChunk.lastDate,
      };
      cache.set(axis, entry);
    }

    const today = projectProgramChunk(
      quotePoints.slice(splitIdx),
      programByBucket(todayProgram, metas, bucketMs, axis),
      metas, bucketMs, axis, entry.pastLastDate,
    );
    if (today.maskedPrevAtStart && entry.pastData.length > 0) {
      const tail = { ...entry.pastData[entry.pastData.length - 1], ...LINE_HIDDEN_COLOR };
      return entry.pastData.slice(0, -1).concat(tail, today.out);
    }
    return entry.pastData.concat(today.out);
  };
}

function sameQuotePrefix(
  previous: readonly QuoteRatioPoint[],
  points: readonly QuoteRatioPoint[],
  length: number,
): boolean {
  if (previous.length !== length) return false;
  for (let i = 0; i < length; i += 1) if (previous[i] !== points[i]) return false;
  return true;
}

function regularSessionBoundsForDate(yyyymmdd: string): { open: number; close: number } | null {
  if (!/^\d{8}$/.test(yyyymmdd)) return null;
  const y = Number(yyyymmdd.slice(0, 4));
  const m = Number(yyyymmdd.slice(4, 6));
  const d = Number(yyyymmdd.slice(6, 8));
  const open = Date.UTC(y, m - 1, d, 0, 0, 0);
  return { open, close: open + 6.5 * 3600 * 1000 };
}

// 모듈 레벨 1개 인스턴스 — 내부 캐시는 axis 식별자별 WeakMap 이라 동시 차트 간 충돌이 없다
// (ratio·quoteTotals 와 같은 배치).
const programTradeCachedData = makeCachedProgramTradeProjector();

export const PROGRAM_TRADE_SPEC = {
  name: 'program-trade' as const,
  bundleKind: 'live', // quote_ratio 를 읽는 라이브 pane
  stretch: 0.35,
  legendToggleKey: 'programTradeEnabled',
  series: [
    {
      type: LineSeries,
      options: lineOptions,
      data: (bundle: RangeBundle, axis: VirtualAxis) => programTradeCachedData(bundle, axis),
      legend: {
        label: '프로그램 순매수',
        color: () => resolveTokensThemed(TOKEN_SPEC).line,
        format: formatKoreanWonEok, // 억 단위 (라인 축과 동일)
      },
      // 0 = 프로그램 매수/매도 우위의 경계. 누적값이라 이 선을 언제 되돌아
      // 넘는지가 그 자체로 신호다.
      afterAdd: (series) =>
        addZeroBaselineGuide(series, resolveTokensThemed(TOKEN_SPEC).baseline),
    },
  ],
} satisfies PaneSpec;
