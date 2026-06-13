import { memo, useEffect, useRef } from 'react';
import type { ISeriesApi, SeriesType, Time } from 'lightweight-charts';
import type { AskPeak, Candle, RangeSegment } from '../api/types';
import type { PaneId } from '../chart/drawing/types';
import type { PaneSeriesMap } from '../chart/drawing/chartCoordinates';
import type { VirtualAxis } from '../util/virtualAxis';
import { useLivePageStore } from '../state/livePage';
import { formatQtyKo } from '../util/formatQtyKo';
import {
  AskPeakSegmentsPrimitive,
  type AskPeakSegment,
} from '../chart/AskPeakSegmentsPrimitive';

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
): AskPeakSegment[] {
  const byDate = new Map(segments.map((s) => [s.date, s]));
  const lastCandleMs = candles.length > 0 ? candles[candles.length - 1].ts_ms : null;
  const out: AskPeakSegment[] = [];
  for (const p of peaks) {
    const seg = byDate.get(p.date);
    if (!seg) continue;
    const isToday = p.date === todayKst;
    const endMs = isToday && lastCandleMs !== null ? lastCandleMs : seg.session_close_ms;
    out.push({
      time0: (axis.toVirtual(seg.session_open_ms) / 1000) as Time,
      time1: (axis.toVirtual(endMs) / 1000) as Time,
      price: p.price,
      label: formatQtyKo(p.qty),
      color,
      lineWidth,
      live: isToday,
    });
  }
  return out;
}

type Props = {
  paneSeries: PaneSeriesMap;
  axis: VirtualAxis;
  /** LivePage의 useDayAskPeaks 결과 — 거래일별 매도 최대벽. */
  dayAskPeaks: readonly AskPeak[];
  segments: readonly RangeSegment[];
  candles: readonly Candle[];
  /** 오늘(KST YYYYMMDD) — 이 날 세그먼트만 라이브 엣지까지 연장·점 표시. */
  todayKst: string;
};

/** 거래일별 매도 최대벽 오버레이. candle series에 커스텀 primitive를 걸어 각 날의 수평 세그먼트를
 *  그린다(풀-너비 price line이 아니라 그날 구간만 → 여러 날 동시 표시). 색·두께·on/off는 스토어.
 *  형제: LiveCurrentPriceLine(현재가 풀-너비 점선). */
function LiveAskPeakSegments({ paneSeries, axis, dayAskPeaks, segments, candles, todayKst }: Props) {
  const series = paneSeries.get('candle' as PaneId) as ISeriesApi<SeriesType> | undefined;
  const enabled = useLivePageStore((s) => s.askPeakEnabled);
  const color = useLivePageStore((s) => s.askPeakColor);
  const lineWidth = useLivePageStore((s) => s.askPeakLineWidth);
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

  // 갱신: dayAskPeaks·segments·candles·축·스타일·토글 변화 시 세그먼트 재계산.
  useEffect(() => {
    const prim = primRef.current;
    if (!prim) return;
    prim.setSegments(
      enabled
        ? buildAskPeakSegments(dayAskPeaks, segments, candles, axis, todayKst, color, lineWidth)
        : [],
    );
  }, [dayAskPeaks, segments, candles, axis, todayKst, color, lineWidth, enabled, series]);

  return null;
}

export default memo(LiveAskPeakSegments);
