import { useCallback, useEffect, useState, type RefObject } from 'react';
import type { IChartApi, ISeriesApi } from 'lightweight-charts';
import type { VirtualAxis } from '../util/virtualAxis';
import type { Drawing, PaneId } from './drawing/types';
import { priceToCanvasY, realMsToCanvasX } from './drawing/chartCoordinates';
import { useDrawingsStore } from '../state/drawings';

// Panel-anchor offsets used by DrawingPropertyPanel positioning. See ADR-0032.
const PANEL_Y_OFFSET = -38;
const PANEL_X_OFFSET_PENCIL = 0;
const PANEL_X_OFFSET_TRENDLINE = -8;

export type DrawingHost = {
  paneSeries: Map<PaneId, ISeriesApi<'Line'>>;
  registerPaneSeries: (paneId: PaneId, series: ISeriesApi<'Line'>) => void;
  unregisterPaneSeries: (paneId: PaneId) => void;
  computeAnchor: (d: Drawing) => { x: number; y: number } | null;
};

/**
 * Drawing-host concerns extracted from LiveChartRoot: paneSeries registry,
 * activeCode binding to useDrawingsStore, and the panel-anchor computation.
 *
 * paneSeries is `useState<Map>` (not a ref): DrawingOverlay's redraw effect
 * has `paneSeries` in its dep array, so identity must change on each
 * register/unregister or the effect would never re-fire after first paint.
 */
export function useDrawingHost(
  chart: IChartApi | null,
  axis: VirtualAxis,
  code: string | null,
  containerRef: RefObject<HTMLDivElement | null>,
): DrawingHost {
  const [paneSeries, setPaneSeries] = useState<Map<PaneId, ISeriesApi<'Line'>>>(
    () => new Map(),
  );

  const registerPaneSeries = useCallback(
    (paneId: PaneId, series: ISeriesApi<'Line'>) => {
      setPaneSeries((prev) => {
        const next = new Map(prev);
        next.set(paneId, series);
        return next;
      });
    },
    [],
  );

  const unregisterPaneSeries = useCallback((paneId: PaneId) => {
    setPaneSeries((prev) => {
      if (!prev.has(paneId)) return prev;
      const next = new Map(prev);
      next.delete(paneId);
      return next;
    });
  }, []);

  useEffect(() => {
    useDrawingsStore.getState().setActiveCode(code);
  }, [code]);

  const computeAnchor = useCallback(
    (d: Drawing): { x: number; y: number } | null => {
      if (!chart || axis.segments.length === 0) return null;

      if (d.kind === 'hline') {
        const y = priceToCanvasY(chart, paneSeries, d.paneId, d.price);
        if (y == null) return null;
        const containerWidth = containerRef.current?.clientWidth ?? 0;
        return { x: containerWidth / 2, y: y + PANEL_Y_OFFSET };
      }

      if (d.kind === 'trendline') {
        const xa = realMsToCanvasX(chart, axis, d.a.realMs);
        const xb = realMsToCanvasX(chart, axis, d.b.realMs);
        const ya = priceToCanvasY(chart, paneSeries, d.paneId, d.a.price);
        const yb = priceToCanvasY(chart, paneSeries, d.paneId, d.b.price);
        if (xa == null || xb == null || ya == null || yb == null) return null;
        return {
          x: (xa + xb) / 2 + PANEL_X_OFFSET_TRENDLINE,
          y: (ya + yb) / 2 + PANEL_Y_OFFSET,
        };
      }

      // pencil — anchor at top-left bounding box corner.
      let minX = Infinity;
      let minY = Infinity;
      for (const p of d.points) {
        const x = realMsToCanvasX(chart, axis, p.realMs);
        const y = priceToCanvasY(chart, paneSeries, d.paneId, p.price);
        if (x != null && y != null) {
          if (x < minX) minX = x;
          if (y < minY) minY = y;
        }
      }
      if (!isFinite(minX) || !isFinite(minY)) return null;
      return { x: minX + PANEL_X_OFFSET_PENCIL, y: minY + PANEL_Y_OFFSET };
    },
    [chart, axis, paneSeries, containerRef],
  );

  return { paneSeries, registerPaneSeries, unregisterPaneSeries, computeAnchor };
}
