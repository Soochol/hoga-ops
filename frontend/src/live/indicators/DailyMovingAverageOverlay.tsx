import { memo, useEffect, useMemo, useRef } from 'react';
import { LineSeries, type IChartApi, type ISeriesApi, type Time } from 'lightweight-charts';
import type { RangeBundle } from '../../api/types';
import type { VirtualAxis } from '../../util/virtualAxis';
import { useLivePageStore, isMinuteTimeframe, type LiveTimeframe } from '../../state/livePage';
import { useLivePastDailyCandles } from '../../api/livePastDailyCandles';
import { computeDailyMaByDate } from '../../chart/projectors/dailyMovingAverage';
import { unixMsToKSTDate } from '../../util/time';
import { subtractDaysKst, PAST_CANDLES_MAX_DAYS } from '../liveDateTime';

type Props = {
  chart: IChartApi;
  bundle: RangeBundle;
  axis: VirtualAxis;
  code: string | null;
  timeframe: LiveTimeframe;
  todayKst: string;
};

type LineApi = ISeriesApi<'Line'>;
const EMPTY_DAILY: never[] = [];

/** 일봉 이동평균선 오버레이 — 일봉 종가 SMA를 분봉 축에 거래일-계단으로 투영
 *  (ADR-0073). 현재봉 MovingAverageOverlay의 series-reconcile 패턴을 미러링하되,
 *  일봉 데이터를 useLiveBundle 밖 독립 훅으로 fetch한다(번들 split 비침투). 분봉
 *  전용: D/W/M에선 미렌더. 레전드 연동은 v1 비대상(maSeriesRegistry 미등록). */
function DailyMovingAverageOverlay({ chart, bundle, axis, code, timeframe, todayKst }: Props) {
  const configs = useLivePageStore((s) => s.dailyMovingAverages);
  const masterEnabled = useLivePageStore((s) => s.dailyMovingAverageEnabled);
  const hidden = useLivePageStore((s) => s.dailyMovingAverageHidden);
  const seriesByIdRef = useRef<Map<string, LineApi>>(new Map());

  const enabled = masterEnabled && isMinuteTimeframe(timeframe) && !!code && !!todayKst;

  // 일봉 fetch 창 — today 앵커 + PAST_CANDLES_MAX_DAYS(분봉 팬 클램프 하한) + period
  // headroom으로 분봉 가시 전 범위를 항상 덮는 superset. from/to가 좌측 팬에 불변이라
  // 재fetch 없이 lockstep(ADR-0073).
  const maxPeriod = useMemo(
    () => configs.reduce((mx, c) => (c.enabled ? Math.max(mx, c.period) : mx), 20),
    [configs],
  );
  // period 거래일 → 캘린더일 (KRX ≈ 5 거래일 / 7 캘린더일) + 휴장 슬랙.
  const lookbackDays = PAST_CANDLES_MAX_DAYS + Math.ceil((maxPeriod * 7) / 5) + 15;
  const from = enabled ? subtractDaysKst(todayKst, lookbackDays) : null;
  const to = enabled ? todayKst : null;
  const dailyQuery = useLivePastDailyCandles(enabled ? code : null, from, to);
  const daily = dailyQuery.data?.candles ?? EMPTY_DAILY;

  // Reconcile series ↔ configs by id (MovingAverageOverlay와 동일).
  useEffect(() => {
    const map = seriesByIdRef.current;
    const currentIds = new Set(configs.map((c) => c.id));
    for (const [id, s] of Array.from(map.entries())) {
      if (!currentIds.has(id)) {
        try { chart.removeSeries(s); } catch { /* torn down */ }
        map.delete(id);
      }
    }
    for (const cfg of configs) {
      const existing = map.get(cfg.id);
      if (!existing) {
        try {
          const s = chart.addSeries(LineSeries, {
            color: cfg.color,
            lineWidth: cfg.lineWidth,
            priceLineVisible: false,
            lastValueVisible: false,
            crosshairMarkerVisible: false,
          }, 0); // paneIndex 0 — candle pane overlay
          map.set(cfg.id, s);
        } catch { /* torn down */ }
      } else {
        existing.applyOptions({ color: cfg.color, lineWidth: cfg.lineWidth });
      }
    }
  }, [chart, configs]);

  // Unmount cleanup — remove all series.
  useEffect(() => {
    return () => {
      const map = seriesByIdRef.current;
      for (const [, s] of map) {
        try { chart.removeSeries(s); } catch { /* torn down */ }
      }
      map.clear();
    };
  }, [chart]);

  // 오늘 현재가 프록시 — 마지막 in-session 캔들이 오늘 거래일일 때만.
  const todayLiveClose = useMemo(() => {
    if (!enabled) return null;
    const cs = bundle.candles;
    const last = cs.length ? cs[cs.length - 1] : null;
    return last && unixMsToKSTDate(last.ts_ms) === todayKst ? last.close : null;
  }, [enabled, bundle, todayKst]);

  // Project daily MA onto each in-session candle (day-anchored step).
  useEffect(() => {
    const map = seriesByIdRef.current;
    const inSession = bundle.candles.filter((c) => axis.contains(c.ts_ms));
    for (const cfg of configs) {
      const s = map.get(cfg.id);
      if (!s) continue;
      const drawn = enabled && cfg.enabled;
      s.applyOptions({ visible: drawn && !hidden });
      if (!drawn) {
        s.setData([]);
        continue;
      }
      const maByDate = computeDailyMaByDate(daily, cfg.period, cfg.source, todayKst, todayLiveClose);
      const data = inSession.map((c) => {
        const segIdx = axis.findByReal(c.ts_ms);
        const date = axis.segments[segIdx]?.date;
        const v = date != null ? maByDate.get(date) : undefined;
        const time = (axis.toVirtual(c.ts_ms) / 1000) as Time;
        return v == null ? { time } : { time, value: v };
      });
      s.setData(data as never);
    }
    // `chart` dep: /live remounts the chart per (code, timeframe); fresh series
    // start empty and must be re-pushed in the same commit (MovingAverageOverlay 동일).
  }, [chart, bundle, axis, configs, enabled, hidden, daily, todayKst, todayLiveClose]);

  return null;
}

export default memo(DailyMovingAverageOverlay);
