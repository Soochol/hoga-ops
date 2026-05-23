import { LineSeries } from 'lightweight-charts';
import type { RangeBundle } from '../../api/types';
import { type VirtualAxis } from '../../util/virtualAxis';
import { resolveTokens } from '../../util/tokens';
import { useChartPrefs } from '../ChartPrefsContext';
import type { MAConfig } from '../../state/tabs';
import type { PaneSpec, SeriesSpec } from '../RangeSeriesPane';

const TOKEN_SPEC = {
  ma1: ['--ma-1', '#EC4899'],
  ma2: ['--ma-2', '#3B82F6'],
  ma3: ['--ma-3', '#F97316'],
  ma4: ['--ma-4', '#22C55E'],
  ma5: ['--ma-5', '#F8FAFC'],
} as const;

const { ma1, ma2, ma3, ma4, ma5 } = resolveTokens(TOKEN_SPEC);

/**
 * Palette for the five Moving Average overlays, indexed 0..4 to align with
 * `ChartViewPrefs.movingAverages` slots. Resolved once at module load from
 * the `--ma-1..--ma-5` design tokens (T1).
 */
const MA_COLORS: string[] = [ma1, ma2, ma3, ma4, ma5];

/**
 * Simple Moving Average over `closes` with window `period`. O(n) sliding-
 * window sum: the first `period - 1` entries are `null` (not enough history
 * to average), then each subsequent entry is the mean of the trailing
 * `period` closes.
 *
 * Edge cases (mirroring the spec):
 *   - `period <= 0`: all-null (no meaningful average).
 *   - `period === 1`: return `closes` verbatim (the MA equals the close).
 *   - `period > closes.length`: all-null (window never fills).
 *   - empty input: empty output.
 */
export function computeSMA(closes: number[], period: number): (number | null)[] {
  if (closes.length === 0) return [];
  if (period <= 0) return closes.map(() => null);
  if (period === 1) return closes.slice();
  if (period > closes.length) return closes.map(() => null);

  const out: (number | null)[] = new Array(closes.length);
  let sum = 0;
  for (let i = 0; i < closes.length; i++) {
    sum += closes[i];
    if (i >= period) sum -= closes[i - period];
    out[i] = i >= period - 1 ? sum / period : null;
  }
  return out;
}

/** Per-render context passed to every MA series' `data` projector. */
export type MAContext = readonly MAConfig[];

const useMAContext = (): MAContext => useChartPrefs().movingAverages;

function makeSeries(index: number): SeriesSpec<MAContext> {
  return {
    type: LineSeries,
    options: {
      color: MA_COLORS[index],
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    },
    data: (bundle: RangeBundle, axis: VirtualAxis, ctx: MAContext) => {
      const cfg = ctx[index];
      if (!cfg || !cfg.enabled) return [];
      const closes = bundle.candles.map((c) => c.close);
      const sma = computeSMA(closes, cfg.period);
      const out: any[] = [];
      for (let j = 0; j < bundle.candles.length; j++) {
        const c = bundle.candles[j];
        if (!axis.contains(c.ts_ms)) continue;
        const time = (axis.toVirtual(c.ts_ms) / 1000) as any;
        const v = sma[j];
        if (v === null) {
          // Whitespace data: keeps the time slot but draws no line segment.
          out.push({ time });
        } else {
          out.push({ time, value: v });
        }
      }
      return out;
    },
  };
}

/**
 * Moving Average overlay pane (paneIndex 0, mounted above the candle pane).
 * Static 5-series shape: disabled slots return `[]` instead of being
 * removed, so series handles don't churn between renders. `stretch: 0`
 * because the overlay shares the candle pane's vertical space and is not
 * driven by `ChartStage`'s stretch loop.
 */
export const MOVING_AVERAGE_SPEC: PaneSpec<MAContext> = {
  name: 'moving-average',
  stretch: 0,
  useContext: useMAContext,
  series: [makeSeries(0), makeSeries(1), makeSeries(2), makeSeries(3), makeSeries(4)],
};
