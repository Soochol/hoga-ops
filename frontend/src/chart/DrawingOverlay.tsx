// frontend/src/chart/DrawingOverlay.tsx
//
// Pane-aware Drawing Overlay. See:
//   - docs/superpowers/specs/2026-05-24-drawing-on-indicator-panes-design.md
//   - docs/adr/0028-drawing-pane-binding.md

import { useCallback, useEffect, useRef } from 'react';
import type { IChartApi } from 'lightweight-charts';
import type { VirtualAxis } from '../util/virtualAxis';
import { useDrawingsStore } from '../state/drawings';
import { renderDrawing, renderTrendlineDraft, type ProjectCtx } from './drawing/render';
import type { Drawing, PaneId } from './drawing/types';
import { hitTestDrawings } from './drawing/hitTest';
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
  canvasYToPrice as projCanvasYToPrice,
  realMsToCanvasX as projRealMsToCanvasX,
  paneIdToIndex,
  paneIdAtY as projPaneIdAtY,
  clampYToPane as projClampYToPane,
  priceBoundsForPane as projPriceBoundsForPane,
  type PaneSeriesMap,
} from './drawing/chartCoordinates';

/**
 * Pure predicate for the empty-click deselect flow. Returns true iff the
 * click landed inside the overlay's bounding rect AND did not hit any
 * Drawing AND did not originate from the Drawing Property Panel.
 *
 * The property-panel guard is load-bearing: the panel renders over the
 * chart (its pixels fall inside the overlay's rect by construction), and
 * its `mousedown` events bubble up to the window listener. Without the
 * guard, the user's own mousedown on a panel control (color / thickness /
 * lineStyle trigger) clears `selectedId` before the trigger's onClick
 * fires, unmounting the panel and silently dropping the edit. The delete
 * button worked anyway because it captures `id` in a closure that
 * survives selectedId going null, masking the bug. See ADR-0030 (the
 * deselect rule) and ADR-0032 (the panel that demands this exception).
 */
function shouldDeselectOnClick(
  click: { x: number; y: number },
  rect: { width: number; height: number },
  hasHit: boolean,
  isOnPropertyPanel: boolean,
): boolean {
  if (isOnPropertyPanel) return false;
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
  onChartHoverPassthrough?: (point: { x: number; y: number }) => void;
};

export default function DrawingOverlay({ chart, axis, paneSeries, onChartHoverPassthrough }: Props) {
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
        const idx = paneIdToIndex(paneSeries, paneId);
        if (idx < 0 || idx >= panes.length) return; // pane toggled off → skip
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

      const trendDraft = trendlineDraft.current;
      if (trendDraft?.b) {
        clipAndRender(trendDraft.paneId, (projCtx) => {
          renderTrendlineDraft(c, projCtx, trendDraft, defaults);
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
              lineStyle: defaults.lineStyle,
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
  const canvasYToPrice = (py: number, paneId: PaneId) =>
    projCanvasYToPrice(chart, paneSeries, paneId, py);
  const paneIdAtY = (py: number) => projPaneIdAtY(chart, paneSeries, py);
  const clampYToPane = (paneId: PaneId, py: number) =>
    projClampYToPane(chart, paneSeries, paneId, py);

  const priceBoundsForPane = (paneId: PaneId) =>
    projPriceBoundsForPane(chart, paneSeries, paneId);

  // SR-5: the kind-dispatch hit geometry lives in the pure hitTestDrawings
  // kernel (hitTest.ts, unit-tested with stub coords). This wrapper just binds
  // the chart-aware coordinate closures.
  const hitTestAt = (px: number, py: number): Drawing | null =>
    hitTestDrawings(
      { realMsToCanvasX, priceToCanvasY, paneIdAtY: (y) => projPaneIdAtY(chart, paneSeries, y) },
      drawings,
      px,
      py,
    );

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
      canvasYToPrice,
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
    const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
    onChartHoverPassthrough?.({
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    });
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
    // rAF-coalesce the global mousemove. Native mousemove fires at the OS
    // sampling rate (can exceed 1 kHz on high-poll-rate mice). Without
    // throttling, every event paid getBoundingClientRect() (forces layout),
    // hitTestAt (iterates all drawings), and a pointer-events style write
    // — all wasted between paints since the user can't perceive sub-frame
    // hit changes. One probe per frame is enough.
    let hoverRaf: number | null = null;
    let pendingEvent: MouseEvent | null = null;
    const onHover = (e: MouseEvent) => {
      if (dragRef.current) return;
      pendingEvent = e;
      if (hoverRaf !== null) return;
      hoverRaf = requestAnimationFrame(() => {
        hoverRaf = null;
        const ev = pendingEvent;
        pendingEvent = null;
        if (!ev) return;
        const rect = container.getBoundingClientRect();
        const px = ev.clientX - rect.left;
        const py = ev.clientY - rect.top;
        const hit =
          px >= 0 && py >= 0 && px <= rect.width && py <= rect.height
            ? hitTestAt(px, py)
            : null;
        container.style.pointerEvents = hit ? 'auto' : 'none';
      });
    };
    window.addEventListener('mousemove', onHover);
    return () => {
      window.removeEventListener('mousemove', onHover);
      if (hoverRaf !== null) {
        cancelAnimationFrame(hoverRaf);
        hoverRaf = null;
      }
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
      const isOnPropertyPanel =
        e.target instanceof Node &&
        !!document.querySelector('[data-drawing-property-panel]')?.contains(e.target);
      const rect = container.getBoundingClientRect();
      const click = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      const hasHit = !!hitTestAt(click.x, click.y);
      if (shouldDeselectOnClick(click, rect, hasHit, isOnPropertyPanel)) {
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
