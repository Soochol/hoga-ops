// 당일 최대벽 세그먼트 빌드 — **매도·매수 공용**(순수).
//
// 두 방향은 계산이 **완전히 같다.** 종전엔 `LiveAskPeakSegments` 와 `LiveBidPeakSegments`
// 에 169줄이 바이트 단위로 중복돼 있었고(정규화 diff 실측), 그 중복이 진짜 비대칭을 가렸다 —
// 매수의 「보이는 영역 최대벽」 노브가 강조 색 없이 한 달 넘게 살아 있던 것이 그 결과다
// (#1505 에서 제거). **한 벌만 두면 비대칭이 숨을 곳이 없다.**
//
// side 를 인자로 받지 않는 이유: 방향은 이미 **호출자가 넘기는 데이터와 필터 안에** 있다.
// `PeakMaFilter`/`PeakDailyMaFilter` 가 자기 `side` 를 들고 다니고(매도는 MA 위, 매수는
// 아래), 세그먼트 좌표·라벨·랭킹은 방향을 구별하지 않는다. 화살표 방향처럼 **그리기에서만**
// 갈리는 것은 그리기 계층(`peakWallRankArrows`)이 side 를 받는다.
//
// ⚠ wire 미러(`api/types.ts` 의 `AskPeak`/`BidPeak`)는 **합치지 않는다** — 백엔드 모델이
// 둘이라 ADR-0004 의 손 미러 계약이 두 이름을 요구한다. 여기서 하나로 보는 것은 **그리기
// 계층이 필요로 하는 구조**뿐이고, 그게 아래 `PeakWallInput` 이다.

import type { Time } from 'lightweight-charts';
import type { AskPeakCandidate, Candle, PeakBase, RangeSegment } from '../api/types';
import type { VirtualAxis } from '../util/virtualAxis';
import {
  inlinePeakWallSegmentsForDocking,
  type PeakWallSegment,
} from '../chart/PeakWallSegmentsPrimitive';
import { formatPriceQty } from './peakLegendValues';
import { applyPeakVisibleTimeCutoff, type VisibleTimeCutoff } from './peakWallVisibleCutoff';
import { filterPeaksAgainstMa, type PeakMaFilter } from './peakWallMaFilter';
import { filterPeaksAgainstDailyMa, type PeakDailyMaFilter } from './peakWallDailyMaFilter';

/** 그리기 계층이 보는 최대벽. `AskPeak` 과 `BidPeak` 이 둘 다 이 구조를 만족한다. */
export type PeakWallInput = PeakBase & {
  traded_peaks?: AskPeakCandidate[];
  traded_max_peaks?: AskPeakCandidate[];
  traded_record_peaks?: AskPeakCandidate[];
  traded_record_max_peaks?: AskPeakCandidate[];
  all_peaks?: AskPeakCandidate[];
  all_max_peaks?: AskPeakCandidate[];
  unreached_peaks?: AskPeakCandidate[];
};

function allCandidate(
  price: number | null | undefined,
  qty: number | null | undefined,
  tMs: number | null | undefined,
): AskPeakCandidate | null {
  return finiteNumber(price) && finiteNumber(qty) && finiteNumber(tMs)
    ? { price, qty, t_ms: tMs }
    : null;
}

/**
 * 전체 벽(`all_*` 패밀리, 터치 무관)을 **traded carrier 자리로 옮긴 사본**을 만든다 —
 * 「전체 최대벽」 선의 입력. 파이프라인(expandBaselinePeaks · applyPeakVisibleTimeCutoff ·
 * MA 필터)은 전부 traded carrier 를 읽으므로, 자리만 바꾸면 한 벌이 그대로 재사용된다.
 *
 * 데이터의 두 모양을 다 다룬다:
 * - **과거일**(/api/range seed): `all_price/qty/t_ms` 스칼라만 있고 배열은 비어 온다
 *   (bundle._without_all_peak_rankings). → carrier 는 스칼라, `traded_peaks` 는
 *   **undefined 로 남긴다**. `[]` 를 넣으면 applyPeakVisibleTimeCutoff 의 chooseCandidate
 *   가 스칼라 폴백을 타지 못해 컷오프 아래에서 그날이 통째로 사라진다(=== undefined 검사).
 * - **오늘**(attachFamilies): `all_peaks`/`all_max_peaks` 배열이 있다. → rank-1 이 carrier,
 *   배열은 traded_peaks 로 옮겨 컷오프가 후보 재선택을 할 수 있게 한다.
 *
 * `all_*` 가 전혀 없는 날(legacy payload)은 건너뛴다 — 그날만 선이 빠진다.
 * record 필드는 옮기지 않는다(전체 벽 선은 강도 pane 계단에 참여하지 않는다).
 */
export function toAllWallPeakInputs(peaks: readonly PeakWallInput[]): PeakWallInput[] {
  const out: PeakWallInput[] = [];
  for (const p of peaks) {
    const closeArr = p.all_peaks?.length ? p.all_peaks : undefined;
    const maxArr = p.all_max_peaks?.length ? p.all_max_peaks : undefined;
    const close = closeArr?.[0] ?? allCandidate(p.all_price, p.all_qty, p.all_t_ms);
    const max = maxArr?.[0]
      ?? allCandidate(p.all_max_price, p.all_max_qty, p.all_max_t_ms)
      ?? close;
    if (!close && !max) continue;
    out.push({
      date: p.date,
      price: close?.price ?? null,
      qty: close?.qty ?? null,
      t_ms: close?.t_ms ?? null,
      max_price: max?.price ?? null,
      max_qty: max?.qty ?? null,
      max_t_ms: max?.t_ms ?? null,
      traded_peaks: closeArr,
      traded_max_peaks: maxArr,
    });
  }
  return out;
}

/**
 * 미도달 벽(`unreached_*`)을 traded carrier 자리로 옮긴 사본 — toAllWallPeakInputs 와
 * 같은 리맵 패턴. **cont 단일 계열**이라 close/max 구분이 없어 양쪽에 같은 값을 싣는다
 * (intraMax 토글이 이 선에는 무효 — 백엔드 AskPeakDualRow 주석의 대우).
 * 과거일 배열은 range 에서 벗기지 않으므로(최대 3개) 배열이 오면 그대로 옮기고,
 * 없으면 스칼라 폴백 — `traded_peaks: undefined` 규약은 toAllWallPeakInputs 와 동일
 * (`[]` 를 넣으면 컷오프의 chooseCandidate 스칼라 폴백이 죽는다).
 */
export function toUnreachedWallPeakInputs(peaks: readonly PeakWallInput[]): PeakWallInput[] {
  const out: PeakWallInput[] = [];
  for (const p of peaks) {
    const arr = p.unreached_peaks?.length ? p.unreached_peaks : undefined;
    const rankOne = arr?.[0]
      ?? allCandidate(p.unreached_price, p.unreached_qty, p.unreached_t_ms);
    if (!rankOne) continue;
    out.push({
      date: p.date,
      price: rankOne.price,
      qty: rankOne.qty,
      t_ms: rankOne.t_ms,
      max_price: rankOne.price,
      max_qty: rankOne.qty,
      max_t_ms: rankOne.t_ms,
      traded_peaks: arr,
      traded_max_peaks: arr,
    });
  }
  return out;
}

export type PeakWallLineStyle = {
  color: string;
  lineWidth: number;
};

/** 「체결된 벽 표시 개수」 pref 값을 좁힌다. 저장된 값이 범위 밖이면 1(기본). */
export function toPeakRankLimit(value: number): 1 | 2 | 3 {
  return value === 2 || value === 3 ? value : 1;
}

/** 선 위 인라인 라벨을 비운다 — 라벨은 도킹 라벨 primitive 가 그린다(두 번 그리면 겹친다). */
export function preparePeakWallSegmentsForRender(
  segments: readonly PeakWallSegment[],
): PeakWallSegment[] {
  return inlinePeakWallSegmentsForDocking(segments);
}

/** peak 시각(ms)을 그 시각이 속한 캔들(버킷)의 ts_ms로 스냅. 캔들은 버킷 시작에 놓이는데
 *  (downsample_candles: ts_ms = floor(ts_ms/bucket)*bucket), peak.t_ms는 그 버킷의 마지막
 *  연속거래 스냅샷(버킷 끝 근처)이라 그대로 두면 lwc가 가상시각을 다음 캔들 쪽으로 거의 보간해
 *  점이 1캔들 옆으로 밀린다(총잔량 급증 마커는 버킷정렬 bucket_intra_ms를 써서 안 밀림 — 동일하게 맞춤).
 *  candles는 ts_ms 오름차순 → tMs 이하 마지막 캔들이 그 버킷. tMs가 첫 캔들보다 앞서면(미로드 구간)
 *  null을 내 호출부가 원시 t_ms로 폴백(primitive의 보간 폴백이 처리). */
function snapPeakMsToCandle(tMs: number, candles: readonly Candle[]): number | null {
  let lo = 0;
  let hi = candles.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid].ts_ms <= tMs) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans >= 0 ? candles[ans].ts_ms : null;
}

/** 라벨은 「가격, 잔량」. 레전드·도킹 라벨과 **같은 함수**를 쓴다 — 두 표면이 갈리면 같은
 *  벽이 화면 두 곳에서 다르게 읽힌다(#839 가 그 사고였다).
 *
 *  ⚠ 칩 폭이 잔량만일 때의 약 2.5배가 된다. 밀집은 **줌 예산**이 받는다
 *  (`peakLabelBudgetForBarSpacing`). 가격은 축약하지 않는다: Y축 정밀도가 이 값의
 *  요점이라 `934.0k` 로 줄이면 못 읽는다. */
function formatPeakWallLabel(price: number, qty: number): string {
  return formatPriceQty(price, qty);
}

/** 거래일별 최대벽을 그날 구간의 수평 세그먼트 좌표로 변환(순수). 각 peak.date를
 *  segment(session open/close)에 매핑 → x0=open, x1=close(과거일) 또는 라이브 엣지(오늘=마지막 캔들).
 *  segment 없는 날·축 빈 경우는 건너뛴다. 시각은 axis.toVirtual(ms)/1000(가상 초, 라인과 동일 좌표). */
export function buildPeakWallSegments(
  peaks: readonly PeakWallInput[],
  segments: readonly RangeSegment[],
  candles: readonly Candle[],
  axis: VirtualAxis,
  todayKst: string,
  color: string,
  lineWidth: number,
  intraMax: boolean,
): PeakWallSegment[] {
  const byDate = new Map(segments.map((s) => [s.date, s]));
  const lastCandleMs = candles.length > 0 ? candles[candles.length - 1].ts_ms : null;
  const out: PeakWallSegment[] = [];
  for (const p of peaks) {
    const seg = byDate.get(p.date);
    if (!seg) continue;
    const isToday = p.date === todayKst;
    const endMs = isToday && lastCandleMs !== null ? lastCandleMs : seg.session_close_ms;
    const peakPrice = intraMax ? p.max_price : p.price;
    const peakQty = intraMax ? p.max_qty : p.qty;
    const peakTMs = intraMax ? p.max_t_ms : p.t_ms;
    if (!finiteNumber(peakPrice) || !finiteNumber(peakQty) || !finiteNumber(peakTMs)) continue;
    // peak 점은 그 시각이 속한 캔들(버킷)에 스냅 → 점이 그 캔들 위에 정확히 놓인다(1캔들 밀림 방지).
    const peakMs = snapPeakMsToCandle(peakTMs, candles) ?? peakTMs;
    out.push({
      time0: (axis.toVirtual(seg.session_open_ms) / 1000) as Time,
      time1: (axis.toVirtual(endMs) / 1000) as Time,
      // peak이 실제 걸린 시점(속한 캔들에 스냅) — 그 x에 점을 찍어 언제 최대벽이었는지 표시.
      peakTime: (axis.toVirtual(peakMs) / 1000) as Time,
      price: peakPrice,
      qty: peakQty,
      label: formatPeakWallLabel(peakPrice, peakQty),
      color,
      lineWidth,
      live: isToday,
    });
  }
  return out;
}

function finiteNumber(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function selectedQty(p: PeakWallInput, intraMax: boolean): number {
  const qty = intraMax ? p.max_qty : p.qty;
  return finiteNumber(qty) ? qty : Number.NEGATIVE_INFINITY;
}

function selectedTMs(p: PeakWallInput, intraMax: boolean): number {
  const tMs = intraMax ? p.max_t_ms : p.t_ms;
  return finiteNumber(tMs) ? tMs : Number.POSITIVE_INFINITY;
}

function selectedPrice(p: PeakWallInput, intraMax: boolean): number {
  const price = intraMax ? p.max_price : p.price;
  return finiteNumber(price) ? price : Number.NaN;
}

function candidateFromPeakFields(
  peak: PeakWallInput,
  mode: 'close' | 'max',
): AskPeakCandidate | null {
  const price = mode === 'max' ? peak.max_price : peak.price;
  const qty = mode === 'max' ? peak.max_qty : peak.qty;
  const tMs = mode === 'max' ? peak.max_t_ms : peak.t_ms;
  if (!finiteNumber(price) || !finiteNumber(qty) || !finiteNumber(tMs)) return null;
  return { price, qty, t_ms: tMs };
}

function peakWallFromCandidates(
  base: PeakWallInput,
  closeCandidate: AskPeakCandidate,
  maxCandidate: AskPeakCandidate,
): PeakWallInput {
  return {
    ...base,
    price: closeCandidate.price,
    qty: closeCandidate.qty,
    t_ms: closeCandidate.t_ms,
    max_price: maxCandidate.price,
    max_qty: maxCandidate.qty,
    max_t_ms: maxCandidate.t_ms,
  };
}

function expandBaselinePeaks(
  peaks: readonly PeakWallInput[],
  limit: 1 | 2 | 3,
  intraMax: boolean,
  stepHistory = false,
): PeakWallInput[] {
  const byDate = new Map<string, PeakWallInput[]>();
  for (const p of peaks) {
    // stepHistory: 계단(as-of running max)용 후보 = 기록 갱신 시퀀스 ∪ top-3.
    // 기록만으로 안 되는 이유: 백엔드 cap(128)이 꼬리를 자를 수 있고 구백엔드는
    // 기록이 없다 — top-3 과의 합집합이 두 경우 다 최종 최대를 보존한다.
    const recordCandidates = stepHistory
      ? (intraMax ? p.traded_record_max_peaks : p.traded_record_peaks) ?? []
      : [];
    const closeCandidates = p.traded_peaks?.length
      ? p.traded_peaks
      : (() => {
        const candidate = candidateFromPeakFields(p, 'close');
        return candidate ? [candidate] : [];
      })();
    const maxCandidates = p.traded_max_peaks?.length
      ? p.traded_max_peaks
      : (() => {
        const candidate = candidateFromPeakFields(p, 'max');
        if (candidate) return [candidate];
        return closeCandidates.map((closeCandidate) => ({ ...closeCandidate }));
      })();
    const count = Math.max(closeCandidates.length, maxCandidates.length);
    if (count === 0 && recordCandidates.length === 0) continue;
    const expanded = byDate.get(p.date) ?? [];
    for (let i = 0; i < count; i += 1) {
      const close = closeCandidates[i] ?? closeCandidates[closeCandidates.length - 1];
      const max = maxCandidates[i] ?? maxCandidates[maxCandidates.length - 1] ?? close;
      if (!close || !max) continue;
      expanded.push(peakWallFromCandidates(p, close, max));
    }
    // 기록 후보는 선택된 축(intraMax)의 양쪽 필드에 같은 값을 넣는다 — 계단 계산은
    // 선택 축 하나만 읽고, 기록의 반대 축 값은 정의돼 있지 않다.
    for (const record of recordCandidates) {
      expanded.push(peakWallFromCandidates(p, record, record));
    }
    byDate.set(p.date, expanded);
  }
  return [...byDate.values()].flatMap((items) => {
    const ranked = items
      .slice()
      .sort((a, b) => selectedQty(b, intraMax) - selectedQty(a, intraMax)
        || selectedTMs(a, intraMax) - selectedTMs(b, intraMax)
        || selectedPrice(a, intraMax) - selectedPrice(b, intraMax))
      .filter((item, index, sorted) => sorted.findIndex((candidate) =>
        selectedPrice(candidate, intraMax) === selectedPrice(item, intraMax)
        // 그리기: 가격당 1개(같은 벽을 두 번 긋지 않는다 — 종전 규약 유지).
        // 계단: 같은 가격이 다른 시각에 기록을 두 번 세울 수 있어 (가격, 시각) 키.
        && (!stepHistory || selectedTMs(candidate, intraMax) === selectedTMs(item, intraMax)),
      ) === index);
    // stepHistory: 랭크로 자르지 않는다 — 계단 입력은 이력 전체가 필요하다.
    return stepHistory ? ranked : ranked.slice(0, limit);
  });
}

export type BuildPeakWallOverlaySegmentsArgs = {
  peaks: readonly PeakWallInput[];
  segments: readonly RangeSegment[];
  candles: readonly Candle[];
  axis: VirtualAxis;
  todayKst: string;
  baselineStyle: PeakWallLineStyle;
  intraMax: boolean;
  /** 「체결된 벽 표시 개수」 — 하루에 몇 개까지 그릴지. */
  allPriceRankLimit?: 1 | 2 | 3;
  /** 계단(as-of running max) 입력 모드 — 후보를 기록 갱신 시퀀스 ∪ top-3 으로 잡고
   *  랭크로 자르지 않는다. 그리기 경로는 이 옵션을 켜지 않는다. */
  stepHistory?: boolean;
  visibleTimeCutoff?: VisibleTimeCutoff | null;
  /** 이동평균선 필터. **필수 인자**다 — 기본값을 주면 새 호출부가 조용히 필터 없이
   *  태어난다. 필터를 안 쓰는 자리는 `null` 을 명시한다. 방향(매도는 MA 위 / 매수는
   *  아래)은 이 객체 안에 있다. */
  maFilter: PeakMaFilter | null;
  /** 일봉 이동평균선 필터. `maFilter` 와 독립이라 둘 다 걸면 교집합이다. 같은 이유로
   *  **필수 인자**다. */
  dailyMaFilter: PeakDailyMaFilter | null;
};

export function buildPeakWallOverlaySegments({
  peaks,
  segments,
  candles,
  axis,
  todayKst,
  baselineStyle,
  intraMax,
  allPriceRankLimit = 1,
  stepHistory = false,
  visibleTimeCutoff,
  maFilter,
  dailyMaFilter,
}: BuildPeakWallOverlaySegmentsArgs): PeakWallSegment[] {
  const cutoffPeaks = applyPeakVisibleTimeCutoff(peaks, visibleTimeCutoff ?? null, { intraMax });
  // rank-then-filter: 그날 최대벽을 먼저 뽑고(expandBaselinePeaks) 그중 MA 조건에 맞는
  // 것만 남긴다. 반대로 걸면(filter-then-rank) 지표의 뜻이 "그날 최대벽"에서 "MA 위 벽 중
  // 최대"로 바뀌어, 최대벽이 조건에 걸리면 2등 벽이 대신 올라온다.
  // 두 필터는 순차 교집합이다. 순서는 결과에 영향이 없다(둘 다 술어) — 분봉 쪽을 먼저 두는
  // 것은 그쪽이 캔들 배열을 만지므로 더 비싼 쪽을 뒤에 남기지 않기 위해서다.
  const baselinePeaks = filterPeaksAgainstDailyMa(
    filterPeaksAgainstMa(
      expandBaselinePeaks(cutoffPeaks, allPriceRankLimit, intraMax, stepHistory),
      candles,
      axis,
      intraMax,
      maFilter,
    ),
    intraMax,
    dailyMaFilter,
  );
  return buildPeakWallSegments(
    baselinePeaks,
    segments,
    candles,
    axis,
    todayKst,
    baselineStyle.color,
    baselineStyle.lineWidth,
    intraMax,
  );
}
