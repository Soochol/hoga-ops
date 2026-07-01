import { memo, useEffect, useRef } from 'react';
import type { ISeriesApi, SeriesType, Time } from 'lightweight-charts';
import type { BidPeak, Candle, RangeSegment } from '../api/types';
import type { PaneId } from '../chart/drawing/types';
import type { PaneSeriesMap } from '../chart/drawing/chartCoordinates';
import type { VirtualAxis } from '../util/virtualAxis';
import { useLivePageStore } from '../state/livePage';
import { useActivePrefs } from '../state/chartPrefs';
import { formatQtyCompact } from '../util/formatQtyCompact';
import { realMsToYyyymmdd } from './liveDateTime';
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

function formatBidPeakLabel(price: number, qty: number): string {
  const priceStr = Math.round(price).toLocaleString('ko-KR');
  return `${priceStr}, ${formatQtyCompact(qty)}`;
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
  todayAllPriceBidPeak: BidPeak | null;
  segments: readonly RangeSegment[];
  candles: readonly Candle[];
  axis: VirtualAxis;
  todayKst: string;
  baselineStyle: BidPeakLineStyle;
  allPriceStyle: BidPeakLineStyle;
  intraMax: boolean;
  showAllPrices: boolean;
};

function selectedQty(p: BidPeak, intraMax: boolean): number {
  return intraMax ? p.max_qty : p.qty;
}

function selectedPrice(p: BidPeak, intraMax: boolean): number {
  return intraMax ? p.max_price : p.price;
}

function todayDayLow(candles: readonly Candle[], todayKst: string): number | null {
  let low: number | null = null;
  for (const c of candles) {
    if (realMsToYyyymmdd(c.ts_ms) !== todayKst || !Number.isFinite(c.low)) continue;
    low = low === null ? c.low : Math.min(low, c.low);
  }
  return low;
}

function untradedPeakFromFields(p: BidPeak, intraMax: boolean): BidPeak | null {
  const hasCloseTriple = p.untraded_price != null && p.untraded_qty != null && p.untraded_t_ms != null;
  const hasMaxTriple = p.untraded_max_price != null && p.untraded_max_qty != null && p.untraded_max_t_ms != null;
  if ((intraMax && !hasMaxTriple) || (!intraMax && !hasCloseTriple)) return null;
  return {
    date: p.date,
    price: p.untraded_price ?? p.price,
    qty: p.untraded_qty ?? p.qty,
    t_ms: p.untraded_t_ms ?? p.t_ms,
    max_price: p.untraded_max_price ?? p.max_price,
    max_qty: p.untraded_max_qty ?? p.max_qty,
    max_t_ms: p.untraded_max_t_ms ?? p.max_t_ms,
  };
}

export function buildBidPeakOverlaySegments({
  dayBidPeaks,
  todayAllPriceBidPeak,
  segments,
  candles,
  axis,
  todayKst,
  baselineStyle,
  allPriceStyle,
  intraMax,
  showAllPrices,
}: BuildBidPeakOverlaySegmentsArgs): AskPeakSegment[] {
  const baseline = buildBidPeakSegments(
    dayBidPeaks,
    segments,
    candles,
    axis,
    todayKst,
    baselineStyle.color,
    baselineStyle.lineWidth,
    intraMax,
  );
  if (!showAllPrices) return baseline;

  const dayLow = todayDayLow(candles, todayKst);
  const untradedPeaks: BidPeak[] = [];
  for (const p of dayBidPeaks) {
    const untradedPeak = p.date === todayKst && todayAllPriceBidPeak?.date === todayKst
      ? todayAllPriceBidPeak
      : untradedPeakFromFields(p, intraMax);
    if (!untradedPeak) continue;
    if (p.date === todayKst && (dayLow === null || selectedPrice(untradedPeak, intraMax) >= dayLow)) continue;
    if (selectedQty(untradedPeak, intraMax) <= selectedQty(p, intraMax)) continue;
    untradedPeaks.push(untradedPeak);
  }
  if (untradedPeaks.length === 0) return baseline;

  return baseline.concat(buildBidPeakSegments(
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
  /** Backend today bid peak payload. Orange overlay renders only its untraded_* fields. */
  todayAllPriceBidPeak?: BidPeak | null;
  segments: readonly RangeSegment[];
  candles: readonly Candle[];
  /** 오늘(KST YYYYMMDD) — 이 날 세그먼트만 라이브 엣지까지 연장·점 표시. */
  todayKst: string;
};

/** 거래일별 매수 최대벽 오버레이. candle series에 커스텀 primitive를 걸어 각 날의 수평 세그먼트를
 *  그린다(풀-너비 price line이 아니라 그날 구간만 → 여러 날 동시 표시). 색·두께·on/off는 스토어.
 *  형제: LiveCurrentPriceLine(현재가 풀-너비 점선). */
function LiveBidPeakSegments({ paneSeries, axis, dayBidPeaks, todayAllPriceBidPeak = null, segments, candles, todayKst }: Props) {
  const series = paneSeries.get('candle' as PaneId) as ISeriesApi<SeriesType> | undefined;
  const enabled = useLivePageStore((s) => s.bidPeakEnabled);
  const color = useLivePageStore((s) => s.bidPeakColor);
  const lineWidth = useLivePageStore((s) => s.bidPeakLineWidth);
  const allPriceColor = useLivePageStore((s) => s.bidPeakAllPriceColor);
  const allPriceLineWidth = useLivePageStore((s) => s.bidPeakAllPriceLineWidth);
  const intraMax = useActivePrefs((s) => s.bidPeakIntraMax);
  const showAllPrices = useActivePrefs((s) => s.bidPeakShowAllPrices);
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

  // 갱신: dayBidPeaks·segments·candles·축·스타일·토글 변화 시 세그먼트 재계산.
  useEffect(() => {
    const prim = primRef.current;
    if (!prim) return;
    const nextSegments = enabled
      ? buildBidPeakOverlaySegments({
        dayBidPeaks,
        todayAllPriceBidPeak,
        segments,
        candles,
        axis,
        todayKst,
        baselineStyle: { color, lineWidth },
        allPriceStyle: { color: allPriceColor, lineWidth: allPriceLineWidth },
        intraMax,
        showAllPrices,
      })
      : [];
    prim.setSegments(prepareBidPeakSegmentsForRender(nextSegments));
  }, [
    dayBidPeaks,
    todayAllPriceBidPeak,
    segments,
    candles,
    axis,
    todayKst,
    color,
    lineWidth,
    allPriceColor,
    allPriceLineWidth,
    enabled,
    intraMax,
    showAllPrices,
    series,
  ]);

  return null;
}

export default memo(LiveBidPeakSegments);
