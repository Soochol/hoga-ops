import { memo, useEffect, useMemo, useRef } from 'react';
import { LineSeries, type AutoscaleInfoProvider, type IChartApi, type ISeriesApi, type Time } from 'lightweight-charts';
import type { RangeBundle } from '../../api/types';
import type { VirtualAxis } from '../../util/virtualAxis';
import { useLivePageStore, isMinuteTimeframe, type LiveMAConfig, type LiveTimeframe } from '../../state/livePage';
import { useChartPrefsStore } from '../../state/chartPrefs';
import type { LiveVenueOption } from '../../state/liveVenue';
import { computeDailyMaByDate } from '../../chart/projectors/dailyMovingAverage';
import { dailyMaFetchWindow, pickTodayLiveClose } from './dailyMaProjection';
import { useResolvedDailyCandles } from './useResolvedDailyCandles';

type Props = {
  chart: IChartApi;
  bundle: RangeBundle;
  axis: VirtualAxis;
  code: string | null;
  timeframe: LiveTimeframe;
  venue?: LiveVenueOption;
  todayKst: string;
  /** KIS 일봉 fetch 허용 여부(기본 true). /study는 false로 넘겨 스크리너 일봉만 쓴다. */
  dailyCandleKisEnabled?: boolean;
  override?: {
    configs: readonly LiveMAConfig[];
    masterEnabled: boolean;
    hidden: boolean;
  };
};

type LineApi = ISeriesApi<'Line'>;
const excludeFromAutoscale: AutoscaleInfoProvider = () => null;
const includeInAutoscale: AutoscaleInfoProvider = (original) => original();
const priceFormat = {
  type: 'custom' as const,
  formatter: (p: number) => Math.round(p).toLocaleString('ko-KR'),
  minMove: 1,
};

/** 일봉 이동평균선 오버레이 — 일봉 종가 SMA를 분봉 축에 거래일-계단으로 투영
 *  (ADR-0073). 현재봉 MovingAverageOverlay의 series-reconcile 패턴을 미러링하되,
 *  일봉 데이터를 useLiveBundle 밖 독립 훅으로 fetch한다(번들 split 비침투). 분봉
 *  전용: D/W/M에선 미렌더. 레전드 연동은 v1 비대상(maSeriesRegistry 미등록). */
function DailyMovingAverageOverlay({ chart, bundle, axis, code, timeframe, venue = 'KRX', todayKst, dailyCandleKisEnabled = true, override }: Props) {
  const storeConfigs = useLivePageStore((s) => s.dailyMovingAverages);
  const storeMasterEnabled = useLivePageStore((s) => s.dailyMovingAverageEnabled);
  const storeHidden = useLivePageStore((s) => s.dailyMovingAverageHidden);
  const configs = override?.configs ?? storeConfigs;
  const masterEnabled = override?.masterEnabled ?? storeMasterEnabled;
  const hidden = override?.hidden ?? storeHidden;
  const candleOnlyScale = useChartPrefsStore((s) => s.candlePaneCandleOnlyScale);
  const seriesByIdRef = useRef<Map<string, LineApi>>(new Map());

  const enabled = masterEnabled && isMinuteTimeframe(timeframe) && !!code && !!todayKst;

  // 일봉 fetch 창은 today 앵커라 좌측 팬에 불변 → react-query 키 안정 → 재fetch 없이
  // candle prepend와 lockstep(ADR-0073). lookback 산식·거래일 환산은 dailyMaProjection(테스트됨).
  const fetchWindow = enabled ? dailyMaFetchWindow(todayKst, configs) : null;
  const dailyQuery = useResolvedDailyCandles({
    code,
    from: fetchWindow?.from ?? null,
    to: fetchWindow?.to ?? null,
    venue,
    enabled,
    kisEnabled: dailyCandleKisEnabled,
  });
  const daily = dailyQuery.candles;

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
      const createScaleOptions = candleOnlyScale ? { autoscaleInfoProvider: excludeFromAutoscale } : {};
      const updateScaleOptions = {
        autoscaleInfoProvider: candleOnlyScale ? excludeFromAutoscale : includeInAutoscale,
      };
      const existing = map.get(cfg.id);
      if (!existing) {
        try {
          const s = chart.addSeries(LineSeries, {
            color: cfg.color,
            lineWidth: cfg.lineWidth,
            priceLineVisible: false,
            lastValueVisible: false,
            crosshairMarkerVisible: false,
            priceFormat,
            ...createScaleOptions,
          }, 0); // paneIndex 0 — candle pane overlay
          map.set(cfg.id, s);
        } catch { /* torn down */ }
      } else {
        existing.applyOptions({ color: cfg.color, lineWidth: cfg.lineWidth, ...updateScaleOptions });
      }
    }
  }, [chart, configs, candleOnlyScale]);

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

  // 오늘 현재가 프록시 (dailyMaProjection, 테스트됨).
  const todayLiveClose = useMemo(
    () => (enabled ? pickTodayLiveClose(bundle.candles, todayKst) : null),
    [enabled, bundle, todayKst],
  );

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
