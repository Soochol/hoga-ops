import { memo, useEffect, useMemo, useRef } from 'react';
import type { ISeriesApi, SeriesType, Time } from 'lightweight-charts';
import type { AskPeakCandidate, BidPeak, Candle, RangeSegment } from '../api/types';
import type { PaneId } from '../chart/drawing/types';
import type { PaneSeriesMap } from '../chart/drawing/chartCoordinates';
import type { VirtualAxis } from '../util/virtualAxis';
import { useActivePrefs } from '../state/chartPrefs';
import { applyPeakVisibleTimeCutoff, type VisibleTimeCutoff } from './peakWallVisibleCutoff';
import { filterPeaksAgainstMa, usePeakMaFilter, type PeakMaFilter } from './peakWallMaFilter';
import { filterPeaksAgainstDailyMa, type PeakDailyMaFilter } from './peakWallDailyMaFilter';
import {
  registerFlagLegendValues,
  unregisterFlagLegendValues,
  type FlagLegendValueProvider,
} from './indicators/flagLegendValueRegistry';
import { formatPriceQty } from './peakLegendValues';
import { PEAK_WALL_LEGEND_RANK_LIMIT, peakWallRankLegendCells } from './peakWallVisibleRanking';
import { candleExtremesByVirtualSec, peakWallRankArrowsFromSegments } from './peakWallRankArrows';
import { PeakWallRankArrowsPrimitive } from '../chart/PeakWallRankArrowsPrimitive';
import {
  AskPeakSegmentsPrimitive,
  inlinePeakWallSegmentsForDocking,
  type AskPeakSegment,
} from '../chart/AskPeakSegmentsPrimitive';
import { useWindowIndicator, useWindowScopeId } from './workspace/windowView';

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

/** 매도쪽과 같은 「가격, 잔량」 — 사유는 `LiveAskPeakSegments.formatAskPeakLabel` 참조. */
function formatBidPeakLabel(price: number, qty: number): string {
  return formatPriceQty(price, qty);
}

function toPeakRankLimit(value: number): 1 | 2 | 3 {
  return value === 2 || value === 3 ? value : 1;
}

/** 거래일별 매수 최대벽(dayBidPeaks)을 그날 구간의 수평 세그먼트 좌표로 변환(순수). 각 peak.date를
 *  segment(session open/close)에 매핑 → x0=open, x1=close(과거일) 또는 라이브 엣지(오늘=마지막 캔들).
 *  segment 없는 날·축 빈 경우는 건너뛴다. 시각은 axis.toVirtual(ms)/1000(가상 초, 라인과 동일 좌표). */
export function buildBidPeakSegments(
  peaks: readonly BidPeak[],
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
      label: formatBidPeakLabel(peakPrice, peakQty),
      color,
      lineWidth,
      live: isToday,
    });
  }
  return out;
}

type BidPeakLineStyle = {
  color: string;
  lineWidth: number;
};

type BuildBidPeakOverlaySegmentsArgs = {
  dayBidPeaks: readonly BidPeak[];
  segments: readonly RangeSegment[];
  candles: readonly Candle[];
  axis: VirtualAxis;
  todayKst: string;
  baselineStyle: BidPeakLineStyle;
  intraMax: boolean;
  allPriceRankLimit?: 1 | 2 | 3;
  visibleTimeCutoff?: VisibleTimeCutoff | null;
  /** 이동평균선 필터(`usePeakMaFilter`). 매수는 MA **아래**만 남긴다 — 매도의 거울.
   *  매도쪽과 같은 이유로 **필수 인자**다(기본값을 주면 새 호출부가 조용히 필터 없이
   *  태어난다). 필터를 안 쓰는 자리는 `null` 을 명시한다. */
  maFilter: PeakMaFilter | null;
  /** 일봉 이동평균선 필터(매수는 MA **아래**). `maFilter` 와 독립이라 둘 다 걸면 교집합이다.
   *  매도쪽과 같은 이유로 **필수 인자**다. */
  dailyMaFilter: PeakDailyMaFilter | null;
};

function finiteNumber(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function selectedQty(p: BidPeak, intraMax: boolean): number {
  const qty = intraMax ? p.max_qty : p.qty;
  return finiteNumber(qty) ? qty : Number.NEGATIVE_INFINITY;
}

function selectedTMs(p: BidPeak, intraMax: boolean): number {
  const tMs = intraMax ? p.max_t_ms : p.t_ms;
  return finiteNumber(tMs) ? tMs : Number.POSITIVE_INFINITY;
}

function selectedPrice(p: BidPeak, intraMax: boolean): number {
  const price = intraMax ? p.max_price : p.price;
  return finiteNumber(price) ? price : Number.NaN;
}

function candidateFromPeakFields(
  peak: BidPeak,
  mode: 'close' | 'max',
): AskPeakCandidate | null {
  const price = mode === 'max' ? peak.max_price : peak.price;
  const qty = mode === 'max' ? peak.max_qty : peak.qty;
  const tMs = mode === 'max' ? peak.max_t_ms : peak.t_ms;
  if (!finiteNumber(price) || !finiteNumber(qty) || !finiteNumber(tMs)) return null;
  return { price, qty, t_ms: tMs };
}

function bidPeakFromCandidates(
  base: BidPeak,
  closeCandidate: AskPeakCandidate,
  maxCandidate: AskPeakCandidate,
): BidPeak {
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

function expandBaselineBidPeaks(
  peaks: readonly BidPeak[],
  limit: 1 | 2 | 3,
  intraMax: boolean,
): BidPeak[] {
  const byDate = new Map<string, BidPeak[]>();
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
      expanded.push(bidPeakFromCandidates(p, close, max));
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

export function buildBidPeakOverlaySegments({
  dayBidPeaks,
  segments,
  candles,
  axis,
  todayKst,
  baselineStyle,
  intraMax,
  allPriceRankLimit = 1,
  visibleTimeCutoff,
  maFilter,
  dailyMaFilter,
}: BuildBidPeakOverlaySegmentsArgs): AskPeakSegment[] {
  const cutoffPeaks = applyPeakVisibleTimeCutoff(dayBidPeaks, visibleTimeCutoff ?? null, {
    side: 'bid',
    intraMax,
  });
  // rank-then-filter: 매도쪽과 같은 순서. 최대벽을 먼저 뽑고 그중 MA 아래인 것만 남긴다.
  // 매도쪽과 같은 순차 교집합.
  const baselinePeaks = filterPeaksAgainstDailyMa(
    filterPeaksAgainstMa(
      expandBaselineBidPeaks(cutoffPeaks, allPriceRankLimit, intraMax),
      candles,
      axis,
      intraMax,
      maFilter,
    ),
    intraMax,
    dailyMaFilter,
  );
  const baseline = buildBidPeakSegments(
    baselinePeaks,
    segments,
    candles,
    axis,
    todayKst,
    baselineStyle.color,
    baselineStyle.lineWidth,
    intraMax,
  );
  return baseline;
}

export function prepareBidPeakSegmentsForRender(
  segments: readonly AskPeakSegment[],
): AskPeakSegment[] {
  return inlinePeakWallSegmentsForDocking(segments);
}

type Props = {
  paneSeries: PaneSeriesMap;
  axis: VirtualAxis;
  /** LivePage의 useDayBidPeaks 결과 — 거래일별 매수 최대벽. */
  dayBidPeaks: readonly BidPeak[];
  segments: readonly RangeSegment[];
  candles: readonly Candle[];
  /** 오늘(KST YYYYMMDD) — 이 날 세그먼트만 라이브 엣지까지 연장·점 표시. */
  todayKst: string;
  visibleTimeCutoff?: VisibleTimeCutoff | null;
  /** 일봉 MA 필터 — `LiveChartRoot` 가 한 번 계산해 내려보낸다(매도쪽과 동일). */
  dailyMaFilter?: PeakDailyMaFilter | null;
};

/** 거래일별 매수 최대벽 오버레이. candle series에 커스텀 primitive를 걸어 각 날의 수평 세그먼트를
 *  그린다(풀-너비 price line이 아니라 그날 구간만 → 여러 날 동시 표시). 색·두께·on/off는 스토어.
 *  형제: LiveCurrentPriceLine(현재가 풀-너비 점선). */
function LiveBidPeakSegments({ paneSeries, axis, dayBidPeaks, segments, candles, todayKst, visibleTimeCutoff = null, dailyMaFilter = null }: Props) {
  const series = paneSeries.get('candle' as PaneId) as ISeriesApi<SeriesType> | undefined;
  const enabled = useWindowIndicator((s) => s.bidPeakEnabled);
  const hidden = useWindowIndicator((s) => s.bidPeakHidden);
  const color = useWindowIndicator((s) => s.bidPeakColor);
  const lineWidth = useWindowIndicator((s) => s.bidPeakLineWidth);
  const intraMax = useActivePrefs((s) => s.bidPeakIntraMax);
  const allPriceRankLimit = useActivePrefs((s) => s.bidPeakAllPriceRankLimit);
  const rankArrowEnabled = useActivePrefs((s) => s.bidPeakRankArrowEnabled);
  const maFilter = usePeakMaFilter('bid');
  const primRef = useRef<AskPeakSegmentsPrimitive | null>(null);
  /** 레전드가 랭킹할 세그먼트(필터 통과 후) — 사유는 ask 쪽 동명 ref 주석 참조. */
  const legendSegmentsRef = useRef<readonly AskPeakSegment[]>([]);
  const arrowPrimRef = useRef<PeakWallRankArrowsPrimitive | null>(null);
  /** 가상초 → 봉 극값(ask 쪽과 동일 규칙). 매수는 **저가**를 앵커로 쓴다. */
  const candleExtremes = useMemo(
    () => candleExtremesByVirtualSec(candles, axis),
    [candles, axis],
  );
  // 레전드 값 provider 의 창 스코프(멀티창) — ask 쪽과 동일 규칙.
  const windowId = useWindowScopeId();

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

  // 순위 화살표 primitive(ask 미러) — 앵커가 캔들 저가라 세그먼트 렌더러와 별개다.
  useEffect(() => {
    if (!series) return;
    const prim = new PeakWallRankArrowsPrimitive();
    series.attachPrimitive(prim);
    arrowPrimRef.current = prim;
    return () => {
      try {
        series.detachPrimitive(prim);
      } catch {
        /* chart already torn down */
      }
      arrowPrimRef.current = null;
    };
  }, [series]);

  // 레전드 값 provider — **보이는 영역**의 잔량 상위 3개(ask 쪽과 동일 규칙: 호출 시점에
  // 범위를 읽고, hidden 과 무관하게 값을 유지한다).
  useEffect(() => {
    const provider: FlagLegendValueProvider = () => peakWallRankLegendCells(
      legendSegmentsRef.current,
      primRef.current?.chartApi()?.timeScale().getVisibleRange() ?? null,
      'bid-peak',
    );
    registerFlagLegendValues(windowId, 'bid-peak', provider);
    return () => unregisterFlagLegendValues(windowId, 'bid-peak', provider);
  }, [windowId]);

  // 갱신: dayBidPeaks·segments·candles·축·스타일·토글 변화 시 세그먼트 재계산.
  useEffect(() => {
    const prim = primRef.current;
    if (!prim) return;
    const baselineRankLimit = toPeakRankLimit(allPriceRankLimit);
    const nextSegments = enabled
      ? buildBidPeakOverlaySegments({
        dayBidPeaks,
        segments,
        candles,
        axis,
        todayKst,
        baselineStyle: { color, lineWidth },
        intraMax,
        allPriceRankLimit: baselineRankLimit,
        visibleTimeCutoff,
        maFilter,
        dailyMaFilter,
      })
      : [];
    // 레전드는 눈(hidden)과 무관하게 값을 유지 → 그리기 게이트보다 먼저 채운다(ask 미러).
    legendSegmentsRef.current = nextSegments;
    // 화살표는 그리기이므로 눈이 지운다. 랭킹은 primitive 가 draw 시점에 한다.
    arrowPrimRef.current?.setArrows(
      hidden || !rankArrowEnabled
        ? []
        : peakWallRankArrowsFromSegments(nextSegments, 'bid', candleExtremes),
      PEAK_WALL_LEGEND_RANK_LIMIT,
    );
    prim.setSegments(hidden ? [] : prepareBidPeakSegmentsForRender(nextSegments));
  }, [
    dayBidPeaks,
    segments,
    candles,
    axis,
    todayKst,
    color,
    lineWidth,
    enabled,
    hidden,
    intraMax,
    allPriceRankLimit,
    visibleTimeCutoff,
    maFilter,
    dailyMaFilter,
    series,
    rankArrowEnabled,
    candleExtremes,
  ]);

  return null;
}

export default memo(LiveBidPeakSegments);
