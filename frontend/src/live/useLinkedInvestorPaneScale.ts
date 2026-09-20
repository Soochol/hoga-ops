import { useEffect } from 'react';
import type { IChartApi, ISeriesApi, SeriesType } from 'lightweight-charts';
import type { RangeBundle } from '../api/types';
import type { PaneId } from '../chart/drawing/types';
import type { VirtualAxis } from '../util/virtualAxis';
import { safeUnsubscribe } from '../chart/util/safeUnsubscribe';
import { linkedInvestorPriceRange } from './investorPaneScale';

type Props = {
  chart: IChartApi | null;
  bundle: RangeBundle | null;
  axis: VirtualAxis;
  paneSeries: Map<PaneId, ISeriesApi<SeriesType>>;
  enabled: boolean;
};

function restoreAutoScale(scale: ReturnType<ISeriesApi<SeriesType>['priceScale']>): void {
  try {
    scale.setAutoScale?.(true);
  } catch {
    // chart tearing down
  }
}

function attachedPriceScale(
  series: ISeriesApi<SeriesType> | undefined,
): ReturnType<ISeriesApi<SeriesType>['priceScale']> | undefined {
  if (!series) return undefined;
  try {
    return series.priceScale();
  } catch {
    // The pane registry is React state, so a removed series can remain visible
    // for one render while lightweight-charts has already detached its pane.
    return undefined;
  }
}

/** Keep the two separate daily investor panes on one visible-value scale. */
export function useLinkedInvestorPaneScale({
  chart,
  bundle,
  axis,
  paneSeries,
  enabled,
}: Props): void {
  useEffect(() => {
    if (!chart) return undefined;
    const foreign = paneSeries.get('investor-foreign');
    const institution = paneSeries.get('investor-institution');
    const foreignScale = attachedPriceScale(foreign);
    const institutionScale = attachedPriceScale(institution);
    const scales = [foreignScale, institutionScale].filter(
      (scale): scale is NonNullable<typeof scale> => scale !== undefined,
    );

    if (!enabled || !bundle || !foreignScale || !institutionScale) {
      scales.forEach(restoreAutoScale);
      return undefined;
    }

    const timeScale = chart.timeScale();
    let raf = 0;
    const apply = (): void => {
      raf = 0;
      const range = linkedInvestorPriceRange(bundle, axis, timeScale.getVisibleRange());
      if (!range) {
        scales.forEach(restoreAutoScale);
        return;
      }
      scales.forEach((scale) => {
        try {
          // Optional chaining keeps lightweight chart stubs used by older callers
          // compatible; the production v5 API exposes both methods.
          scale.setAutoScale?.(false);
          scale.setVisibleRange?.(range);
        } catch {
          // chart tearing down
        }
      });
    };
    const schedule = (): void => {
      if (raf !== 0) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(apply);
    };

    timeScale.subscribeVisibleTimeRangeChange(schedule);
    schedule();
    return () => {
      if (raf !== 0) cancelAnimationFrame(raf);
      safeUnsubscribe(() => timeScale.unsubscribeVisibleTimeRangeChange(schedule));
    };
  }, [chart, bundle, axis, paneSeries, enabled]);
}
