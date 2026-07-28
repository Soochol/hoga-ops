import { useCallback, useEffect, useState } from 'react';
import type { IChartApi, ISeriesApi } from 'lightweight-charts';
import type { PaneId } from './drawing/types';
import { useDrawingsStore } from '../state/drawings';

export type DrawingHost = {
  paneSeries: Map<PaneId, ISeriesApi<'Line'>>;
  registerPaneSeries: (paneId: PaneId, series: ISeriesApi<'Line'>) => void;
  unregisterPaneSeries: (paneId: PaneId) => void;
};

type PaneSeriesState = {
  chart: IChartApi | null;
  paneSeries: Map<PaneId, ISeriesApi<'Line'>>;
};

const EMPTY_PANE_SERIES = new Map<PaneId, ISeriesApi<'Line'>>();

/**
 * Drawing-host concerns extracted from LiveChartRoot: the paneSeries registry
 * and activeScope binding to useDrawingsStore.
 *
 * paneSeries is `useState<Map>` (not a ref): DrawingOverlay attaches one
 * primitive per entry with `paneSeries` in its dep array, so identity must
 * change on each register/unregister or the effect would never re-fire.
 */
export function useDrawingHost(
  chart: IChartApi | null,
  scope: string | null,
): DrawingHost {
  const [paneSeriesState, setPaneSeriesState] = useState<PaneSeriesState>(
    () => ({ chart: null, paneSeries: new Map() }),
  );
  const paneSeries =
    paneSeriesState.chart === chart ? paneSeriesState.paneSeries : EMPTY_PANE_SERIES;

  const registerPaneSeries = useCallback(
    (paneId: PaneId, series: ISeriesApi<'Line'>) => {
      setPaneSeriesState((prev) => {
        const base = prev.chart === chart ? prev.paneSeries : EMPTY_PANE_SERIES;
        const next = new Map(base);
        next.set(paneId, series);
        return { chart, paneSeries: next };
      });
    },
    [chart],
  );

  const unregisterPaneSeries = useCallback((paneId: PaneId) => {
    setPaneSeriesState((prev) => {
      if (prev.chart !== chart || !prev.paneSeries.has(paneId)) return prev;
      const next = new Map(prev.paneSeries);
      next.delete(paneId);
      return { chart, paneSeries: next };
    });
  }, [chart]);

  useEffect(() => {
    useDrawingsStore.getState().setActiveScope(scope);
  }, [scope]);

  return { paneSeries, registerPaneSeries, unregisterPaneSeries };
}
