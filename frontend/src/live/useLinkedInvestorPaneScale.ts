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
    const scales = [foreign?.priceScale(), institution?.priceScale()].filter(
      (scale): scale is NonNullable<typeof scale> => scale !== undefined,
    );

    if (!enabled || !bundle || !foreign || !institution) {
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
