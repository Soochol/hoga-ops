import { memo, useEffect, useMemo, useRef } from 'react';
import { LineSeries, type AutoscaleInfoProvider, type IChartApi, type ISeriesApi, type Time } from 'lightweight-charts';
import type { RangeBundle } from '../../api/types';
import type { VirtualAxis } from '../../util/virtualAxis';
import { isMinuteTimeframe, type LiveMAConfig, type LiveTimeframe } from '../../state/livePage';
import { useChartPrefsStore } from '../../state/chartPrefs';
import type { LiveVenueOption } from '../../state/liveVenue';
import { computeDailyMaByDate } from '../../chart/projectors/dailyMovingAverage';
import { dailyMaFetchWindow, pickTodayLiveClose } from './dailyMaProjection';
import { useResolvedDailyCandles } from './useResolvedDailyCandles';
import { isIndexWorkareaCode } from '../liveInstrument';
import { useDailyMaSeriesRegistry } from './dailyMaSeriesRegistry';
import { useWindowScopeId } from '../workspace/windowView';
import { useWindowIndicator } from '../workspace/windowView';

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
  /** 이 창이 덮어야 할 표시 하한(계단으로 내린 값, `useLiveChartData` 가 유일 생산자).
   *  디스크 모드에서 250일 벽이 사라져 화면이 기본 창보다 과거로 갈 때 창을 따라 넓힌다.
   *  reveal 게이트·최대벽 일봉MA 필터가 **같은 값**을 받아야 쿼리 키가 하나로 모인다. */
  dailyMaWindowFloorDate?: string | null;
  /** 가시성이 슬롯 안(`enabled`)으로 접혔으므로 configs 하나면 충분하다 —
   *  종전의 masterEnabled·hidden 은 그 값에서 파생된다. */
  override?: {
    configs: readonly LiveMAConfig[];
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
 *  전용: D/W/M에선 미렌더. 레전드 값은 dailyMaSeriesRegistry 등록으로 노출. */
function DailyMovingAverageOverlay({ chart, bundle, axis, code, timeframe, venue = 'KRX', todayKst, dailyCandleKisEnabled = true, dailyMaWindowFloorDate = null, override }: Props) {
  const storeConfigs = useWindowIndicator((s) => s.dailyMovingAverages);
  const configs = override?.configs ?? storeConfigs;
  const candleOnlyScale = useChartPrefsStore((s) => s.candlePaneCandleOnlyScale);
  const seriesByIdRef = useRef<Map<string, LineApi>>(new Map());

  // 지수 제외: 일봉 소스가 `/api/live/past-daily-candles`(6자리 종목 전용)라 지수
  // 코드로는 애초에 시리즈가 그려지지 않는다. 즉 기능 제거가 아니라 헛요청 제거다
  // (지수 일봉 MA 를 지원하려면 `/api/live/index-candles` D 를 태워야 한다 — 별건).
  // 종전 마스터 토글의 자리 — 이제 "켜진 슬롯이 하나라도 있는가" 다. 전부 꺼져
  // 있으면 일봉 fetch 까지 통째로 건너뛴다(마스터 off 와 같은 절약).
  const enabled = configs.some((c) => c.enabled)
    && isMinuteTimeframe(timeframe)
    && !!code
    && !isIndexWorkareaCode(code)
    && !!todayKst;

  // 일봉 fetch 창은 today 앵커라 좌측 팬에 불변 → react-query 키 안정 → 재fetch 없이
  // candle prepend와 lockstep(ADR-0073). lookback 산식·거래일 환산은 dailyMaProjection(테스트됨).
  const fetchWindow = enabled ? dailyMaFetchWindow(todayKst, configs, dailyMaWindowFloorDate) : null;
  const dailyQuery = useResolvedDailyCandles({
    code,
    from: fetchWindow?.from ?? null,
    to: fetchWindow?.to ?? null,
    venue,
    enabled,
    kisEnabled: dailyCandleKisEnabled,
  });
  const daily = dailyQuery.candles;
  // 레지스트리 키를 창별로 가른다 — 고정 슬롯 id 는 창끼리 충돌한다.
  const scope = useWindowScopeId();

  // Reconcile series ↔ configs by id (MovingAverageOverlay와 동일).
  useEffect(() => {
    const map = seriesByIdRef.current;
    const currentIds = new Set(configs.map((c) => c.id));
    for (const [id, s] of Array.from(map.entries())) {
      if (!currentIds.has(id)) {
        try { chart.removeSeries(s); } catch { /* torn down */ }
        map.delete(id);
        useDailyMaSeriesRegistry.getState().unregister(scope, id);
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
          useDailyMaSeriesRegistry.getState().register(scope, cfg.id, s);
        } catch { /* torn down */ }
      } else {
        existing.applyOptions({ color: cfg.color, lineWidth: cfg.lineWidth, ...updateScaleOptions });
      }
    }
  }, [chart, configs, candleOnlyScale, scope]);

  // Unmount cleanup — remove all series.
  useEffect(() => {
    return () => {
      const map = seriesByIdRef.current;
      for (const [id, s] of map) {
        try { chart.removeSeries(s); } catch { /* torn down */ }
        useDailyMaSeriesRegistry.getState().unregister(scope, id);
      }
      map.clear();
    };
  }, [chart, scope]);

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
      s.applyOptions({ visible: drawn });
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
  }, [chart, bundle, axis, configs, enabled, daily, todayKst, todayLiveClose]);

  return null;
}

export default memo(DailyMovingAverageOverlay);
