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
// hline panels are bottom-anchored (DrawingPropertyPanel applies
// `translateY(-100%)`), so this is the clearance between the line and the
// panel's bottom edge — height-independent, unlike PANEL_Y_OFFSET which is a
// top-edge offset that has to out-measure the panel's own height to clear it.
const PANEL_HLINE_GAP_ABOVE = 14;

export type DrawingHost = {
  paneSeries: Map<PaneId, ISeriesApi<'Line'>>;
  registerPaneSeries: (paneId: PaneId, series: ISeriesApi<'Line'>) => void;
  unregisterPaneSeries: (paneId: PaneId) => void;
  computeAnchor: (d: Drawing) => { x: number; y: number } | null;
};

type PaneSeriesState = {
  chart: IChartApi | null;
  paneSeries: Map<PaneId, ISeriesApi<'Line'>>;
};

const EMPTY_PANE_SERIES = new Map<PaneId, ISeriesApi<'Line'>>();

/**
 * Drawing-host concerns extracted from LiveChartRoot: paneSeries registry,
 * activeScope binding to useDrawingsStore, and the panel-anchor computation.
 *
 * paneSeries is `useState<Map>` (not a ref): DrawingOverlay's redraw effect
 * has `paneSeries` in its dep array, so identity must change on each
 * register/unregister or the effect would never re-fire after first paint.
 */
export function useDrawingHost(
  chart: IChartApi | null,
  axis: VirtualAxis,
  scope: string | null,
  containerRef: RefObject<HTMLDivElement | null>,
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

  const computeAnchor = useCallback(
    (d: Drawing): { x: number; y: number } | null => {
      if (!chart || axis.segments.length === 0) return null;

      // Anchor at the top-left corner of the bounding box formed by `points`.
      // Shared by pencil / rect / measure — any multi-point shape.
      const bboxTopLeftAnchor = (
        points: readonly { realMs: number; price: number }[],
      ): { x: number; y: number } | null => {
        let minX = Infinity;
        let minY = Infinity;
        for (const p of points) {
          const x = realMsToCanvasX(chart, axis, p.realMs);
          const y = priceToCanvasY(chart, paneSeries, d.paneId, p.price);
          if (x != null && y != null) {
            if (x < minX) minX = x;
            if (y < minY) minY = y;
          }
        }
        if (!isFinite(minX) || !isFinite(minY)) return null;
        return { x: minX + PANEL_X_OFFSET_PENCIL, y: minY + PANEL_Y_OFFSET };
      };

      // Exhaustive switch (no default): adding a new Drawing kind is a compile
      // error here until its anchor case is written — replaces the old
      // if/else-if chain where a new kind silently fell through to the pencil
      // branch and crashed on `.points`.
      switch (d.kind) {
        case 'hline': {
          const y = priceToCanvasY(chart, paneSeries, d.paneId, d.price);
          if (y == null) return null;
          const containerWidth = containerRef.current?.clientWidth ?? 0;
          // y is the panel's bottom edge (bottom-anchored via translateY(-100%));
          // sit it PANEL_HLINE_GAP_ABOVE px above the line so it never overlaps.
          return { x: containerWidth / 2, y: y - PANEL_HLINE_GAP_ABOVE };
        }
        case 'vline': {
          const x = realMsToCanvasX(chart, axis, d.realMs);
          if (x == null) return null;
          // Anchor near the top of the pane stack, offset from the line.
          return { x: x + PANEL_X_OFFSET_TRENDLINE, y: PANEL_Y_OFFSET + 24 };
        }
        case 'trendline': {
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
        case 'rect':
        case 'measure':
          return bboxTopLeftAnchor([d.a, d.b]);
        case 'text': {
          const x = realMsToCanvasX(chart, axis, d.at.realMs);
          const y = priceToCanvasY(chart, paneSeries, d.paneId, d.at.price);
          if (x == null || y == null) return null;
          return { x: x + PANEL_X_OFFSET_PENCIL, y: y + PANEL_Y_OFFSET };
        }
        case 'pencil':
          return bboxTopLeftAnchor(d.points);
      }
    },
    [chart, axis, paneSeries, containerRef],
  );

  return { paneSeries, registerPaneSeries, unregisterPaneSeries, computeAnchor };
}
