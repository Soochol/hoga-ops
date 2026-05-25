// frontend/src/chart/DrawingOverlay.tsx
//
// Pane-aware Drawing Overlay. See:
//   - docs/superpowers/specs/2026-05-24-drawing-on-indicator-panes-design.md
//   - docs/adr/0028-drawing-pane-binding.md

import { useCallback, useEffect, useRef } from 'react';
import type { IChartApi } from 'lightweight-charts';
import type { VirtualAxis } from '../util/virtualAxis';
import { useDrawingsStore } from '../state/drawings';
import { renderDrawing, type ProjectCtx } from './drawing/render';
import type { Drawing, PaneId } from './drawing/types';
import { HIT_THRESHOLD } from './drawing/types';
import { distanceToHline, distanceToPolyline, distanceToSegment } from './drawing/hitTest';
import {
  TOOLS,
  matchShortcut,
  type DragMode,
  type PencilDraft,
  type ToolCtx,
  type TrendlineDraft,
} from './drawing/tools';
import {
  pixelToData as projPixelToData,
  priceToCanvasY as projPriceToCanvasY,
  realMsToCanvasX as projRealMsToCanvasX,
  paneIdToIndex,
  paneIdAtY as projPaneIdAtY,
  clampYToPane as projClampYToPane,
  type PaneSeriesMap,
} from './drawing/chartCoordinates';

/**
 * Pure predicate for the empty-click deselect flow. Returns true iff the
 * click landed inside the overlay's bounding rect AND did not hit any
 * Drawing. Extracted so the listener body stays small and the rule is
 * unit-testable without the `IChartApi` / `VirtualAxis` / `paneSeries`
 * scaffolding the full component needs. See ADR-0030 (companion decision).
 */
function shouldDeselectOnClick(
  click: { x: number; y: number },
  rect: { width: number; height: number },
  hasHit: boolean,
): boolean {
  const inside =
    click.x >= 0 &&
    click.y >= 0 &&
    click.x <= rect.width &&
    click.y <= rect.height;
  return inside && !hasHit;
}

/** Test-only export of internals. Do not import in production code. */
export const __test__ = { shouldDeselectOnClick };

type Props = {
  chart: IChartApi;
  axis: VirtualAxis;
  paneSeries: PaneSeriesMap;
};

export default function DrawingOverlay({ chart, axis, paneSeries }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const activeTool = useDrawingsStore((s) => s.activeTool);
  const activeCode = useDrawingsStore((s) => s.activeCode);
  const drawings = useDrawingsStore((s) =>
    s.activeCode == null ? [] : (s.byCode.get(s.activeCode) ?? []),
  );
  const selectedId = useDrawingsStore((s) => s.selectedId);
  const defaults = useDrawingsStore((s) => s.defaults);

  const trendlineDraft = useRef<TrendlineDraft | null>(null);
  const pencilDraft = useRef<PencilDraft | null>(null);
  const dragRef = useRef<DragMode | null>(null);
  const scheduleRef = useRef<() => void>(() => {});

  // Post-commit revert: tool calls this after adding a drawing.
  // Sets the new drawing as selected and returns to select mode so the user
  // can immediately inspect or move it. See ADR-0032.
  const revertToSelectMode = useCallback((newId: string) => {
    useDrawingsStore.getState().setActiveTool('select');
    useDrawingsStore.getState().setSelected(newId);
  }, []);

  // ── redraw loop ────────────────────────────────────────────────────────
  useEffect(() => {
    const ts = chart.timeScale();
    let raf = 0;
    const schedule = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(draw);
    };
    scheduleRef.current = schedule;
    const draw = () => {
      const canvas = canvasRef.current;
      const container = containerRef.current;
      if (!canvas || !container) return;
      const w = container.clientWidth;
      const h = container.clientHeight;
      const dpr = window.devicePixelRatio || 1;
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr;
        canvas.height = h * dpr;
        canvas.style.width = `${w}px`;
        canvas.style.height = `${h}px`;
      }
      const c = canvas.getContext('2d');
      if (!c) return;
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      c.clearRect(0, 0, w, h);

      const panes = chart.panes();
      const paneTops: number[] = [];
      {
        let acc = 0;
        for (const p of panes) {
          paneTops.push(acc);
          acc += p.getHeight();
        }
      }

      const clipAndRender = (paneId: PaneId, body: (ctx: ProjectCtx) => void) => {
        const idx = paneIdToIndex(paneId);
        if (idx >= panes.length) return;
        const top = paneTops[idx];
        const paneH = panes[idx].getHeight();
        c.save();
        c.beginPath();
        c.rect(0, top, w, paneH);
        c.clip();
        const projCtx: ProjectCtx = {
          chart, axis, paneSeries, paneId, width: w, height: h,
        };
        body(projCtx);
        c.restore();
      };

      for (const d of drawings) {
        if (!paneSeries.has(d.paneId)) continue;  // pane absent → silent skip
        clipAndRender(d.paneId, (projCtx) => {
          renderDrawing(c, projCtx, d, d.id === selectedId);
        });
      }

      // Live pencil draft preview — clipped to its origin pane.
      const draft = pencilDraft.current;
      if (draft && draft.points.length >= 2) {
        clipAndRender(draft.paneId, (projCtx) => {
          renderDrawing(
            c,
            projCtx,
            {
              id: '__draft__',
              kind: 'pencil',
              points: draft.points,
              color: defaults.color,
              width: defaults.width,
              paneId: draft.paneId,
            },
            false,
          );
        });
      }
    };

    ts.subscribeVisibleLogicalRangeChange(schedule);
    const ro =
      containerRef.current && typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(schedule)
        : null;
    if (ro && containerRef.current) ro.observe(containerRef.current);
    schedule();
    return () => {
      cancelAnimationFrame(raf);
      ts.unsubscribeVisibleLogicalRangeChange(schedule);
      ro?.disconnect();
    };
  }, [chart, axis, paneSeries, drawings, selectedId, activeCode, defaults]);

  // ── keyboard shortcuts ─────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      if (dragRef.current || trendlineDraft.current || pencilDraft.current) return;

      const shortcutKind = matchShortcut(e);
      if (shortcutKind) {
        useDrawingsStore.getState().setActiveTool(shortcutKind);
        e.preventDefault();
        return;
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        const id = useDrawingsStore.getState().selectedId;
        if (id) {
          useDrawingsStore.getState().remove(id);
          e.preventDefault();
        }
      } else if (e.key === 'Escape') {
        useDrawingsStore.getState().setSelected(null);
        useDrawingsStore.getState().setActiveTool('select');
        trendlineDraft.current = null;
        pencilDraft.current = null;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Coordinate helpers — pane-aware closures.
  const pixelToData = (px: number, py: number, paneId: PaneId) =>
    projPixelToData(chart, axis, paneSeries, paneId, px, py);
  const realMsToCanvasX = (realMs: number) => projRealMsToCanvasX(chart, axis, realMs);
  const priceToCanvasY = (price: number, paneId: PaneId) =>
    projPriceToCanvasY(chart, paneSeries, paneId, price);
  const paneIdAtY = (py: number) => projPaneIdAtY(chart, py);
  const clampYToPane = (paneId: PaneId, py: number) =>
    projClampYToPane(chart, paneId, py);

  const priceBoundsForPane = (paneId: PaneId) => {
    const series = paneSeries.get(paneId);
    if (!series) return null;
    const idx = paneIdToIndex(paneId);
    const panes = chart.panes();
    if (idx >= panes.length) return null;
    // coordinateToPrice expects pane-local Y; the pane's top in its own
    // local frame is 0, the bottom is its height.
    const paneH = panes[idx].getHeight();
    const topPrice = series.coordinateToPrice(0);
    const bottomPrice = series.coordinateToPrice(paneH);
    if (topPrice == null || bottomPrice == null) return null;
    return { top: Number(topPrice), bottom: Number(bottomPrice) };
  };

  const hitTestAt = (px: number, py: number): Drawing | null => {
    const cursorPaneId = projPaneIdAtY(chart, py);
    for (let i = drawings.length - 1; i >= 0; i--) {
      const d = drawings[i];
      if (d.paneId !== cursorPaneId) continue;
      if (d.kind === 'hline') {
        const y = priceToCanvasY(d.price, d.paneId);
        if (y != null && distanceToHline({ x: px, y: py }, y) <= HIT_THRESHOLD.hline) return d;
      } else if (d.kind === 'trendline') {
        const xa = realMsToCanvasX(d.a.realMs);
        const ya = priceToCanvasY(d.a.price, d.paneId);
        const xb = realMsToCanvasX(d.b.realMs);
        const yb = priceToCanvasY(d.b.price, d.paneId);
        if (xa != null && ya != null && xb != null && yb != null &&
            distanceToSegment({ x: px, y: py }, { x: xa, y: ya }, { x: xb, y: yb }) <= HIT_THRESHOLD.trendlineBody) {
          return d;
        }
      } else if (d.kind === 'pencil') {
        const poly: { x: number; y: number }[] = [];
        for (const pt of d.points) {
          const x = realMsToCanvasX(pt.realMs);
          const y = priceToCanvasY(pt.price, d.paneId);
          if (x != null && y != null) poly.push({ x, y });
        }
        if (distanceToPolyline({ x: px, y: py }, poly) <= HIT_THRESHOLD.pencil) return d;
      }
    }
    return null;
  };

  const buildCtx = (e: React.PointerEvent<HTMLDivElement>): ToolCtx => {
    const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
    const target = e.currentTarget as HTMLDivElement;
    return {
      px: e.clientX - rect.left,
      py: e.clientY - rect.top,
      pointerId: e.pointerId,
      capturePointer: () => target.setPointerCapture(e.pointerId),
      releasePointer: () => target.releasePointerCapture(e.pointerId),
      pixelToData,
      realMsToCanvasX,
      priceToCanvasY,
      hitTestAt,
      paneIdAtY,
      clampYToPane,
      priceBoundsForPane,
      drawings,
      selectedId,
      defaults,
      trendlineDraft,
      pencilDraft,
      dragRef,
      requestRedraw: () => scheduleRef.current(),
      add: (d) => useDrawingsStore.getState().add(d),
      update: (id, patch) => useDrawingsStore.getState().update(id, patch),
      remove: (id) => useDrawingsStore.getState().remove(id),
      setSelected: (id) => useDrawingsStore.getState().setSelected(id),
      revertToSelectMode,
    };
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    TOOLS[activeTool].onPointerDown?.(buildCtx(e));
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    TOOLS[activeTool].onPointerMove?.(buildCtx(e));
  };
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    TOOLS[activeTool].onPointerUp?.(buildCtx(e));
  };

  // ── pointer-events gating ──────────────────────────────────────────────
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    if (activeTool !== 'select') {
      container.style.pointerEvents = 'auto';
      return;
    }
    container.style.pointerEvents = 'none';
    const onHover = (e: MouseEvent) => {
      if (dragRef.current) return;
      const rect = container.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      const hit =
        px >= 0 && py >= 0 && px <= rect.width && py <= rect.height
          ? hitTestAt(px, py)
          : null;
      container.style.pointerEvents = hit ? 'auto' : 'none';
    };
    window.addEventListener('mousemove', onHover);
    return () => {
      window.removeEventListener('mousemove', onHover);
    };
    // hitTestAt closes over drawings / paneSeries; re-bind on change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTool, drawings, paneSeries, axis]);

  // ── empty-click deselect ───────────────────────────────────────────────
  // When something is selected and the user clicks empty chart space,
  // clear the selection. Runs in parallel with chart pan/zoom — never
  // calls preventDefault or stopPropagation. Mounted only while there's
  // something to deselect, so the global listener is short-lived.
  // See ADR-0030 (companion decision).
  useEffect(() => {
    if (activeTool !== 'select' || selectedId == null) return;
    const container = containerRef.current;
    if (!container) return;
    const onWindowMouseDown = (e: MouseEvent) => {
      if (dragRef.current) return;
      const rect = container.getBoundingClientRect();
      const click = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      const hasHit = !!hitTestAt(click.x, click.y);
      if (shouldDeselectOnClick(click, rect, hasHit)) {
        useDrawingsStore.getState().setSelected(null);
      }
    };
    window.addEventListener('mousedown', onWindowMouseDown);
    return () => window.removeEventListener('mousedown', onWindowMouseDown);
    // hitTestAt closes over drawings / paneSeries / axis — re-bind on change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTool, selectedId, drawings, paneSeries, axis]);

  return (
    <div
      ref={containerRef}
      data-drawing-overlay
      className="absolute inset-0 z-20"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      <canvas ref={canvasRef} className="absolute inset-0" />
    </div>
  );
}
