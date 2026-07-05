import { memo, useCallback, useEffect, useRef } from 'react';
import type { IRange, ISeriesApi, SeriesType, Time } from 'lightweight-charts';
import type { AskPeak, AskPeakCandidate, Candle, RangeSegment } from '../api/types';
import type { PaneId } from '../chart/drawing/types';
import type { PaneSeriesMap } from '../chart/drawing/chartCoordinates';
import type { VirtualAxis } from '../util/virtualAxis';
import { useLivePageStore } from '../state/livePage';
import { useActivePrefs } from '../state/chartPrefs';
import { formatQtyCompact } from '../util/formatQtyCompact';
import { applyPeakVisibleTimeCutoff, type VisibleTimeCutoff } from './peakWallVisibleCutoff';
import {
  AskPeakSegmentsPrimitive,
  inlinePeakWallSegmentsForDocking,
  type AskPeakSegment,
} from '../chart/AskPeakSegmentsPrimitive';

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

function formatAskPeakLabel(price: number, qty: number): string {
  const priceStr = Math.round(price).toLocaleString('ko-KR');
  return `${priceStr}, ${formatQtyCompact(qty)}`;
}

/** 거래일별 매도 최대벽(dayAskPeaks)을 그날 구간의 수평 세그먼트 좌표로 변환(순수). 각 peak.date를
 *  segment(session open/close)에 매핑 → x0=open, x1=close(과거일) 또는 라이브 엣지(오늘=마지막 캔들).
 *  segment 없는 날·축 빈 경우는 건너뛴다. 시각은 axis.toVirtual(ms)/1000(가상 초, 라인과 동일 좌표). */
export function buildAskPeakSegments(
  peaks: readonly AskPeak[],
  segments: readonly RangeSegment[],
  candles: readonly Candle[],
  axis: VirtualAxis,
  todayKst: string,
  color: string,
  lineWidth: number,
  intraMax: boolean,
): AskPeakSegment[] {
  const byDate = new Map(segments.map((s) => [s.date, s]));
  const lastCandleMs = candles.length > 0 ? candles[candles.length - 1].ts_ms : null;
  const out: AskPeakSegment[] = [];
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
      label: formatAskPeakLabel(peakPrice, peakQty),
      color,
      lineWidth,
      live: isToday,
    });
  }
  return out;
}

type AskPeakLineStyle = {
  color: string;
  lineWidth: number;
};

type VisibleTimeRange = IRange<Time> | null;
type VisibleMaxRankLimit = 0 | 1 | 2 | 3;

function toPeakRankLimit(value: number): 1 | 2 | 3 {
  return value === 2 || value === 3 ? value : 1;
}

function toVisibleMaxRankLimit(value: number): VisibleMaxRankLimit {
  return value === 0 || value === 2 || value === 3 ? value : 1;
}

function maxPeakRankLimit(a: number, b: number): 1 | 2 | 3 {
  return Math.max(toPeakRankLimit(a), toVisibleMaxRankLimit(b)) as 1 | 2 | 3;
}

function segmentOverlapsVisibleRange(segment: AskPeakSegment, visibleRange: VisibleTimeRange): boolean {
  if (!visibleRange) return false;
  const visibleFrom = visibleRange.from as unknown as number;
  const visibleTo = visibleRange.to as unknown as number;
  const from = Math.min(visibleFrom, visibleTo);
  const to = Math.max(visibleFrom, visibleTo);
  const s0 = segment.time0 as unknown as number;
  const s1 = segment.time1 as unknown as number;
  return Math.max(s0, from) <= Math.min(s1, to);
}

export function styleVisibleMaxAskPeakSegments(
  segments: readonly AskPeakSegment[],
  visibleRange: VisibleTimeRange,
  style: AskPeakLineStyle,
  rankLimit: VisibleMaxRankLimit = 1,
): AskPeakSegment[] {
  if (!visibleRange || segments.length === 0 || rankLimit === 0) return [...segments];
  const highlighted = new Set(segments
    .map((segment, index) => ({ segment, index }))
    .filter(({ segment }) => segmentOverlapsVisibleRange(segment, visibleRange))
    .sort((a, b) => b.segment.qty - a.segment.qty || a.index - b.index)
    .slice(0, rankLimit)
    .map(({ index }) => index));
  if (highlighted.size === 0) return [...segments];
  return segments.map((segment, index) => (
    highlighted.has(index)
      ? { ...segment, color: style.color, lineWidth: style.lineWidth }
      : segment
  ));
}

export function prepareAskPeakSegmentsForRender(
  segments: readonly AskPeakSegment[],
  visibleRange: IRange<Time> | null,
  visibleMaxStyle: { color: string; lineWidth: number },
  visibleMaxRankLimit: VisibleMaxRankLimit,
): AskPeakSegment[] {
  return inlinePeakWallSegmentsForDocking(styleVisibleMaxAskPeakSegments(
    segments,
    visibleRange,
    visibleMaxStyle,
    visibleMaxRankLimit,
  ));
}

type BuildAskPeakOverlaySegmentsArgs = {
  dayAskPeaks: readonly AskPeak[];
  todayAllPriceAskPeak: AskPeak | null;
  segments: readonly RangeSegment[];
  candles: readonly Candle[];
  axis: VirtualAxis;
  todayKst: string;
  baselineStyle: AskPeakLineStyle;
  allPriceStyle: AskPeakLineStyle;
  intraMax: boolean;
  showAllPrices: boolean;
  allPriceRankLimit?: 1 | 2 | 3;
  untradedRankLimit?: 1 | 2 | 3;
  visibleTimeCutoff?: VisibleTimeCutoff | null;
};

type AskPeakSource = {
  peak: AskPeak;
  allowSelfFallback: boolean;
};

function finiteNumber(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function selectedQty(p: AskPeak, intraMax: boolean): number {
  const qty = intraMax ? p.max_qty : p.qty;
  return finiteNumber(qty) ? qty : Number.NEGATIVE_INFINITY;
}

function selectedTMs(p: AskPeak, intraMax: boolean): number {
  const tMs = intraMax ? p.max_t_ms : p.t_ms;
  return finiteNumber(tMs) ? tMs : Number.POSITIVE_INFINITY;
}

function selectedPrice(p: AskPeak, intraMax: boolean): number {
  const price = intraMax ? p.max_price : p.price;
  return finiteNumber(price) ? price : Number.NaN;
}

function askPeakFromModeCandidate(base: AskPeak, candidate: AskPeakCandidate): AskPeak {
  return {
    ...base,
    price: candidate.price,
    qty: candidate.qty,
    t_ms: candidate.t_ms,
    max_price: candidate.price,
    max_qty: candidate.qty,
    max_t_ms: candidate.t_ms,
  };
}

function candidateFromPeakFields(
  peak: AskPeak,
  mode: 'close' | 'max',
): AskPeakCandidate | null {
  const price = mode === 'max' ? peak.max_price : peak.price;
  const qty = mode === 'max' ? peak.max_qty : peak.qty;
  const tMs = mode === 'max' ? peak.max_t_ms : peak.t_ms;
  if (!finiteNumber(price) || !finiteNumber(qty) || !finiteNumber(tMs)) return null;
  return { price, qty, t_ms: tMs };
}

function untradedPeakFromFields(p: AskPeak, intraMax: boolean): AskPeak | null {
  const price = intraMax ? p.untraded_max_price : p.untraded_price;
  const qty = intraMax ? p.untraded_max_qty : p.untraded_qty;
  const tMs = intraMax ? p.untraded_max_t_ms : p.untraded_t_ms;
  if (!finiteNumber(price) || !finiteNumber(qty) || !finiteNumber(tMs)) return null;
  return {
    date: p.date,
    price,
    qty,
    t_ms: tMs,
    max_price: price,
    max_qty: qty,
    max_t_ms: tMs,
  };
}

function filterAskPeakForUntradedCutoff(
  peak: AskPeak,
  cutoff: VisibleTimeCutoff | null | undefined,
): AskPeak | null {
  if (!cutoff) return peak;
  if (peak.date < cutoff.date) return peak;
  if (peak.date > cutoff.date) return null;
  const closeOk = finiteNumber(peak.t_ms) && peak.t_ms <= cutoff.tMs;
  const maxOk = finiteNumber(peak.max_t_ms) && peak.max_t_ms <= cutoff.tMs;
  const untradedCloseOk = finiteNumber(peak.untraded_t_ms) && peak.untraded_t_ms <= cutoff.tMs;
  const untradedMaxOk = finiteNumber(peak.untraded_max_t_ms) && peak.untraded_max_t_ms <= cutoff.tMs;
  return {
    ...peak,
    price: closeOk ? peak.price : null,
    qty: closeOk ? peak.qty : null,
    t_ms: closeOk ? peak.t_ms : null,
    max_price: maxOk ? peak.max_price : null,
    max_qty: maxOk ? peak.max_qty : null,
    max_t_ms: maxOk ? peak.max_t_ms : null,
    untraded_price: untradedCloseOk ? peak.untraded_price : null,
    untraded_qty: untradedCloseOk ? peak.untraded_qty : null,
    untraded_t_ms: untradedCloseOk ? peak.untraded_t_ms : null,
    untraded_max_price: untradedMaxOk ? peak.untraded_max_price : null,
    untraded_max_qty: untradedMaxOk ? peak.untraded_max_qty : null,
    untraded_max_t_ms: untradedMaxOk ? peak.untraded_max_t_ms : null,
    untraded_peaks: peak.untraded_peaks?.filter((candidate) => candidate.t_ms <= cutoff.tMs),
    untraded_max_peaks: peak.untraded_max_peaks?.filter((candidate) => candidate.t_ms <= cutoff.tMs),
  };
}

function askPeakFromCandidates(
  base: AskPeak,
  closeCandidate: AskPeakCandidate,
  maxCandidate: AskPeakCandidate,
): AskPeak {
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
  peaks: readonly AskPeak[],
  limit: 1 | 2 | 3,
  intraMax: boolean,
): AskPeak[] {
  const byDate = new Map<string, AskPeak[]>();
  for (const p of peaks) {
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
    if (count === 0) continue;
    const expanded = byDate.get(p.date) ?? [];
    for (let i = 0; i < count; i += 1) {
      const close = closeCandidates[i] ?? closeCandidates[closeCandidates.length - 1];
      const max = maxCandidates[i] ?? maxCandidates[maxCandidates.length - 1] ?? close;
      if (!close || !max) continue;
      expanded.push(askPeakFromCandidates(p, close, max));
    }
    byDate.set(p.date, expanded);
  }
  return [...byDate.values()].flatMap((items) => items
    .slice()
    .sort((a, b) => selectedQty(b, intraMax) - selectedQty(a, intraMax)
      || selectedTMs(a, intraMax) - selectedTMs(b, intraMax)
      || selectedPrice(a, intraMax) - selectedPrice(b, intraMax))
    .filter((item, index, sorted) => sorted.findIndex((candidate) =>
      selectedPrice(candidate, intraMax) === selectedPrice(item, intraMax),
    ) === index)
    .slice(0, limit));
}

function expandUntradedAskPeaks(
  sources: readonly AskPeakSource[],
  limit: 1 | 2 | 3,
  intraMax: boolean,
): AskPeak[] {
  const byDate = new Map<string, AskPeak[]>();
  for (const { peak, allowSelfFallback } of sources) {
    const rankedCandidates = intraMax ? peak.untraded_max_peaks : peak.untraded_peaks;
    const expanded = byDate.get(peak.date) ?? [];
    if (rankedCandidates && rankedCandidates.length > 0) {
      for (const candidate of rankedCandidates) {
        expanded.push(askPeakFromModeCandidate(peak, candidate));
      }
    } else {
      const legacy = untradedPeakFromFields(peak, intraMax);
      if (legacy) {
        expanded.push(legacy);
      } else if (allowSelfFallback) {
        const candidate = candidateFromPeakFields(peak, intraMax ? 'max' : 'close');
        if (candidate) expanded.push(askPeakFromModeCandidate(peak, candidate));
      }
    }
    byDate.set(peak.date, expanded);
  }
  return [...byDate.values()].flatMap((items) => items
    .slice()
    .sort((a, b) => selectedQty(b, intraMax) - selectedQty(a, intraMax)
      || selectedTMs(a, intraMax) - selectedTMs(b, intraMax)
      || selectedPrice(a, intraMax) - selectedPrice(b, intraMax))
    .filter((item, index, sorted) => sorted.findIndex((candidate) =>
      selectedPrice(candidate, intraMax) === selectedPrice(item, intraMax),
    ) === index)
    .slice(0, limit));
}

export function buildAskPeakOverlaySegments({
  dayAskPeaks,
  todayAllPriceAskPeak,
  segments,
  candles,
  axis,
  todayKst,
  baselineStyle,
  allPriceStyle,
  intraMax,
  showAllPrices,
  allPriceRankLimit = 1,
  untradedRankLimit = 1,
  visibleTimeCutoff,
}: BuildAskPeakOverlaySegmentsArgs): AskPeakSegment[] {
  const cutoffPeaks = applyPeakVisibleTimeCutoff(dayAskPeaks, visibleTimeCutoff ?? null, {
    side: 'ask',
    intraMax,
  });
  const baselinePeaks = expandBaselinePeaks(cutoffPeaks, allPriceRankLimit, intraMax);
  const baseline = buildAskPeakSegments(
    baselinePeaks,
    segments,
    candles,
    axis,
    todayKst,
    baselineStyle.color,
    baselineStyle.lineWidth,
    intraMax,
  );
  if (!showAllPrices) return baseline;

  const untradedSourcesByDate = new Map<string, AskPeakSource>(
    dayAskPeaks
      .map((peak) => filterAskPeakForUntradedCutoff(peak, visibleTimeCutoff))
      .filter((peak): peak is AskPeak => peak !== null)
      .map((peak) => [peak.date, { peak, allowSelfFallback: false }]),
  );
  const todaySource = todayAllPriceAskPeak
    ? filterAskPeakForUntradedCutoff(todayAllPriceAskPeak, visibleTimeCutoff)
    : null;
  if (todaySource?.date === todayKst) {
    untradedSourcesByDate.set(todayKst, { peak: todaySource, allowSelfFallback: true });
  }
  const untradedPeaks = expandUntradedAskPeaks(
    [...untradedSourcesByDate.values()],
    untradedRankLimit,
    intraMax,
  );
  if (untradedPeaks.length === 0) return baseline;

  return baseline.concat(buildAskPeakSegments(
    untradedPeaks,
    segments,
    candles,
    axis,
    todayKst,
    allPriceStyle.color,
    allPriceStyle.lineWidth,
    intraMax,
  ));
}

type Props = {
  paneSeries: PaneSeriesMap;
  axis: VirtualAxis;
  /** LivePage의 useDayAskPeaks 결과 — 거래일별 매도 최대벽. */
  dayAskPeaks: readonly AskPeak[];
  /** Backend today ask peak payload. Orange overlay renders only its untraded_* fields. */
  todayAllPriceAskPeak?: AskPeak | null;
  segments: readonly RangeSegment[];
  candles: readonly Candle[];
  /** 오늘(KST YYYYMMDD) — 이 날 세그먼트만 라이브 엣지까지 연장·점 표시. */
  todayKst: string;
  untradedRankLimit?: 1 | 2 | 3;
  visibleTimeCutoff?: VisibleTimeCutoff | null;
};

/** 거래일별 매도 최대벽 오버레이. candle series에 커스텀 primitive를 걸어 각 날의 수평 세그먼트를
 *  그린다(풀-너비 price line이 아니라 그날 구간만 → 여러 날 동시 표시). 색·두께·on/off는 스토어.
 *  형제: LiveCurrentPriceLine(현재가 풀-너비 점선). */
function LiveAskPeakSegments({ paneSeries, axis, dayAskPeaks, todayAllPriceAskPeak = null, segments, candles, todayKst, untradedRankLimit = 1, visibleTimeCutoff = null }: Props) {
  const series = paneSeries.get('candle' as PaneId) as ISeriesApi<SeriesType> | undefined;
  const enabled = useLivePageStore((s) => s.askPeakEnabled);
  const color = useLivePageStore((s) => s.askPeakColor);
  const lineWidth = useLivePageStore((s) => s.askPeakLineWidth);
  const allPriceColor = useLivePageStore((s) => s.askPeakAllPriceColor);
  const allPriceLineWidth = useLivePageStore((s) => s.askPeakAllPriceLineWidth);
  const visibleMaxColor = useLivePageStore((s) => s.askPeakVisibleMaxColor);
  const visibleMaxLineWidth = useLivePageStore((s) => s.askPeakVisibleMaxLineWidth);
  const intraMax = useActivePrefs((s) => s.askPeakIntraMax);
  const showAllPrices = useActivePrefs((s) => s.askPeakShowAllPrices);
  const allPriceRankLimit = useActivePrefs((s) => s.askPeakAllPriceRankLimit);
  const visibleMaxRankLimit = useActivePrefs((s) => s.askPeakVisibleMaxRankLimit);
  const primRef = useRef<AskPeakSegmentsPrimitive | null>(null);

  // 생성: series 핸들당 1회(LiveCurrentPriceLine과 동일 — tf·종목 전환에도 핸들 유지).
  useEffect(() => {
    if (!series) return;
    const prim = new AskPeakSegmentsPrimitive();
    series.attachPrimitive(prim);
    primRef.current = prim;
    return () => {
      try {
        series.detachPrimitive(prim);
      } catch {
        /* chart already torn down */
      }
      primRef.current = null;
    };
  }, [series]);

  const updateSegments = useCallback(() => {
    const prim = primRef.current;
    if (!prim) return;
    if (!enabled) {
      prim.setSegments([]);
      return;
    }
    const baselineRankLimit = maxPeakRankLimit(allPriceRankLimit, visibleMaxRankLimit);
    const rawSegments = buildAskPeakOverlaySegments({
      dayAskPeaks,
      todayAllPriceAskPeak,
      segments,
      candles,
      axis,
      todayKst,
      baselineStyle: { color, lineWidth },
      allPriceStyle: { color: allPriceColor, lineWidth: allPriceLineWidth },
      intraMax,
      showAllPrices,
      allPriceRankLimit: baselineRankLimit,
      untradedRankLimit,
      visibleTimeCutoff,
    });
    const visibleRange = prim.chartApi()?.timeScale().getVisibleRange() ?? null;
    prim.setSegments(prepareAskPeakSegmentsForRender(
      rawSegments,
      visibleRange,
      { color: visibleMaxColor, lineWidth: visibleMaxLineWidth },
      toVisibleMaxRankLimit(visibleMaxRankLimit),
    ));
  }, [
    dayAskPeaks,
    todayAllPriceAskPeak,
    segments,
    candles,
    axis,
    todayKst,
    color,
    lineWidth,
    allPriceColor,
    allPriceLineWidth,
    visibleMaxColor,
    visibleMaxLineWidth,
    enabled,
    intraMax,
    showAllPrices,
    allPriceRankLimit,
    untradedRankLimit,
    visibleMaxRankLimit,
    visibleTimeCutoff,
  ]);

  // 갱신: dayAskPeaks·segments·candles·축·스타일·토글 변화 시 세그먼트 재계산.
  useEffect(() => {
    updateSegments();
  }, [updateSegments, series]);

  useEffect(() => {
    const prim = primRef.current;
    const chart = prim?.chartApi();
    if (!chart) return;
    const timeScale = chart.timeScale();
    const handler = () => {
      updateSegments();
    };
    timeScale.subscribeVisibleLogicalRangeChange(handler);
    updateSegments();
    return () => {
      timeScale.unsubscribeVisibleLogicalRangeChange(handler);
    };
  }, [series, updateSegments]);

  return null;
}

export default memo(LiveAskPeakSegments);
