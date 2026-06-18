import { memo, useEffect, useRef } from 'react';
import { LineSeries, type AutoscaleInfoProvider, type IChartApi, type ISeriesApi, type Time } from 'lightweight-charts';
import type { RangeBundle } from '../../api/types';
import type { VirtualAxis } from '../../util/virtualAxis';
import { useLivePageStore } from '../../state/livePage';
import { useChartPrefsStore } from '../../state/chartPrefs';
import { computeSMA, selectSource } from '../../chart/projectors/movingAverage';
import { useMaSeriesRegistry } from './maSeriesRegistry';

type Props = {
  chart: IChartApi;
  bundle: RangeBundle;
  axis: VirtualAxis;
};

type LineApi = ISeriesApi<'Line'>;
const excludeFromAutoscale: AutoscaleInfoProvider = () => null;
const includeInAutoscale: AutoscaleInfoProvider = (original) => original();

/** /live의 이동평균선 오버레이. /replay의 정적 5슬롯 MOVING_AVERAGE_SPEC과
 *  분리된 가변 슬롯 모델 (ADR-0046). 슬롯 id 기준 series Map을 유지하며
 *  configs 변경 시 add/remove/applyOptions를 reconcile한다. period/source
 *  같은 데이터 patch는 setData만 호출 — series identity churn 없음. */
function MovingAverageOverlay({ chart, bundle, axis }: Props) {
  const configs = useLivePageStore((s) => s.movingAverages);
  const masterEnabled = useLivePageStore((s) => s.movingAverageEnabled);
  const hidden = useLivePageStore((s) => s.movingAverageHidden);
  const candleOnlyScale = useChartPrefsStore((s) => s.candlePaneCandleOnlyScale);
  const seriesByIdRef = useRef<Map<string, LineApi>>(new Map());

  // Reconcile series ↔ configs by id.
  useEffect(() => {
    const map = seriesByIdRef.current;
    const currentIds = new Set(configs.map((c) => c.id));

    // Remove gone slots.
    for (const [id, s] of Array.from(map.entries())) {
      if (!currentIds.has(id)) {
        try { chart.removeSeries(s); } catch { /* chart torn down */ }
        map.delete(id);
        useMaSeriesRegistry.getState().unregister(id);
      }
    }

    // Add or update.
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
            ...createScaleOptions,
          }, 0); // paneIndex 0 — candle pane overlay
          map.set(cfg.id, s);
          useMaSeriesRegistry.getState().register(cfg.id, s);
        } catch { /* chart torn down */ }
      } else {
        existing.applyOptions({ color: cfg.color, lineWidth: cfg.lineWidth, ...updateScaleOptions });
      }
    }
  }, [chart, configs, candleOnlyScale]);

  // Unmount cleanup — remove all series.
  useEffect(() => {
    return () => {
      const map = seriesByIdRef.current;
      for (const [id, s] of map) {
        try { chart.removeSeries(s); } catch { /* chart torn down */ }
        useMaSeriesRegistry.getState().unregister(id);
      }
      map.clear();
    };
  }, [chart]);

  // Push projected SMA into each series.
  useEffect(() => {
    const map = seriesByIdRef.current;
    const inSession = bundle.candles.filter((c) => axis.contains(c.ts_ms));
    for (const cfg of configs) {
      const s = map.get(cfg.id);
      if (!s) continue;
      // ✕ off (master/slot disabled) clears data + hides. 눈 hide
      // (movingAverageHidden) only flips visibility — data stays so the Pane
      // Legend can read the SMA-at-cursor value while the line is hidden.
      const drawn = masterEnabled && cfg.enabled;
      s.applyOptions({ visible: drawn && !hidden });
      if (!drawn) {
        s.setData([]);
        continue;
      }
      const values = inSession.map((c) => selectSource(c, cfg.source));
      const sma = computeSMA(values, cfg.period);
      const data = inSession.map((c, j) => {
        const time = (axis.toVirtual(c.ts_ms) / 1000) as Time;
        const v = sma[j];
        return v === null ? { time } : { time, value: v };
      });
      s.setData(data as never);
    }
    // `chart` is a dep because the series-creation effect above re-creates
    // every MA series when the chart instance changes (/live remounts the
    // chart per (code, timeframe) view) — the fresh series start empty and
    // must be re-pushed in the same commit.
  }, [chart, bundle, axis, configs, masterEnabled, hidden]);

  return null;
}

// memo: on /live this overlay is fed the stable chartBundle + axis, so an SSE
// tick (hoga-only) no longer re-renders it via the parent (2026-06-09 Phase B).
export default memo(MovingAverageOverlay);
