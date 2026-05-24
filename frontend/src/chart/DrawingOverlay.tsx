// frontend/src/chart/DrawingOverlay.tsx
//
// The Drawing Overlay (CONTEXT.md) — a canvas layer above the chart's
// own canvas that renders all Drawings for the active Code and forwards
// pointer events to the active Drawing Tool Spec (see `./drawing/tools.ts`).
//
// Responsibilities owned here:
//   - DPR-scaled canvas, single rAF redraw coalescer
//   - Building a ToolCtx per pointer event and delegating to TOOLS[activeTool]
//   - Dynamic pointer-events gating in select mode (hover hit-test toggle)
//   - Keyboard shortcuts (Delete/Backspace, Escape)
//
// Per-tool behaviour lives in `./drawing/tools.ts` — adding a tool does
// not touch this file.

import { useEffect, useMemo, useRef } from 'react';
import type { IChartApi, ISeriesApi } from 'lightweight-charts';
import type { VirtualAxis } from '../util/virtualAxis';
import { useDrawingsStore } from '../state/drawings';
import { renderDrawing, type ProjectCtx } from './drawing/render';
import type { Drawing } from './drawing/types';
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
} from './drawing/chartCoordinates';
import { resolveTokens } from '../util/tokens';

const TOKEN_SPEC = { accent: ['--accent', '#14B8A6'] } as const;

type Props = {
  chart: IChartApi;
  axis: VirtualAxis;
  /** Pane 0 candle series. ChartStage discovers it after the candle pane mounts. */
  priceSeries: ISeriesApi<'Candlestick'> | null;
};

export default function DrawingOverlay({ chart, axis, priceSeries }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const activeTool = useDrawingsStore((s) => s.activeTool);
  const activeCode = useDrawingsStore((s) => s.activeCode);
  const drawings = useDrawingsStore((s) =>
    s.activeCode == null ? [] : (s.byCode.get(s.activeCode) ?? []),
  );
  const selectedId = useDrawingsStore((s) => s.selectedId);

  // Canvas 2D's strokeStyle does NOT resolve CSS var(--…); resolve to hex once.
  const accentColor = useMemo(() => resolveTokens(TOKEN_SPEC).accent, []);

  // Per-gesture draft refs — owned here, mutated by tool specs through ToolCtx.
  const trendlineDraft = useRef<TrendlineDraft | null>(null);
  const pencilDraft = useRef<PencilDraft | null>(null);
  const dragRef = useRef<DragMode | null>(null);

  // Lift the redraw scheduler so the ToolCtx can request frames between
  // store mutations (live previews paint into the canvas via draft refs,
  // which are not React state and don't re-trigger the redraw effect).
  const scheduleRef = useRef<() => void>(() => {});

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
      // Clip every drawing render to pane 0 (the candle pane) so
      // extrapolated y from `priceToCoordinate` — which lightweight-charts
      // returns when a stored price falls outside the visible price range —
      // cannot bleed into sibling indicator panes below the candle.
      const paneHeight = chart.panes()[0]?.getHeight() ?? h;
      c.save();
      c.beginPath();
      c.rect(0, 0, w, paneHeight);
      c.clip();
      const projCtx: ProjectCtx = { chart, axis, priceSeries, width: w, height: h };
      for (const d of drawings) {
        renderDrawing(c, projCtx, d, d.id === selectedId);
      }
      // Live pencil preview: render the in-flight draft as a transient
      // Drawing so the freehand line tracks the cursor. We synthesize a
      // Drawing with a sentinel id ('__draft__') and pass `selected=false`
      // to skip the selection halo. On pointer-up the tool calls add(),
      // the store mutation re-runs this effect, and the committed pencil
      // replaces the draft visually with no flash.
      const draft = pencilDraft.current;
      if (draft && draft.points.length >= 2) {
        renderDrawing(
          c,
          projCtx,
          {
            id: '__draft__',
            kind: 'pencil',
            points: draft.points,
            color: accentColor,
            width: 1.5,
          },
          false,
        );
      }
      c.restore();
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
  }, [chart, axis, priceSeries, drawings, selectedId, activeCode, accentColor]);

  // ── keyboard shortcuts ─────────────────────────────────────────────────
  // All keyboard shortcuts (tool switch via Alt+letter, Esc revert,
  // Delete/Backspace remove) are suppressed while a pointer gesture is
  // in flight — switching activeTool mid-drag would route the upcoming
  // pointer-up to a different spec, stranding the draft refs.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      // Active-gesture guard: a tool-switch mid-drag would route the upcoming
      // pointer-up to a different tool spec and strand draft refs in a zombie
      // state. Spec §C "Active-gesture guard".
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
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Coordinate helpers — thin closures over the chartCoordinates module so
  // the rest of the file (and the ToolCtx exposed to tools) doesn't have to
  // thread chart/axis/priceSeries through every call site.
  const pixelToData = (px: number, py: number) =>
    projPixelToData(chart, axis, priceSeries, px, py);
  const realMsToCanvasX = (realMs: number) => projRealMsToCanvasX(chart, axis, realMs);
  const priceToCanvasY = (price: number) => projPriceToCanvasY(priceSeries, price);

  const hitTestAt = (px: number, py: number): Drawing | null => {
    // Mirror the render-side clip: a cursor outside pane 0 (e.g. over the
    // volume / ratio sub-pane) must not hit drawings whose extrapolated y
    // happens to land near it.
    const paneHeight = chart.panes()[0]?.getHeight();
    if (paneHeight != null && (py < 0 || py > paneHeight)) return null;
    for (let i = drawings.length - 1; i >= 0; i--) {
      const d = drawings[i];
      if (d.kind === 'hline') {
        const y = priceToCanvasY(d.price);
        if (y != null && distanceToHline({ x: px, y: py }, y) <= HIT_THRESHOLD.hline) return d;
      } else if (d.kind === 'trendline') {
        const xa = realMsToCanvasX(d.a.realMs);
        const ya = priceToCanvasY(d.a.price);
        const xb = realMsToCanvasX(d.b.realMs);
        const yb = priceToCanvasY(d.b.price);
        if (xa != null && ya != null && xb != null && yb != null &&
            distanceToSegment({ x: px, y: py }, { x: xa, y: ya }, { x: xb, y: yb }) <= HIT_THRESHOLD.trendlineBody) {
          return d;
        }
      } else if (d.kind === 'pencil') {
        const poly: { x: number; y: number }[] = [];
        for (const pt of d.points) {
          const x = realMsToCanvasX(pt.realMs);
          const y = priceToCanvasY(pt.price);
          if (x != null && y != null) poly.push({ x, y });
        }
        if (distanceToPolyline({ x: px, y: py }, poly) <= HIT_THRESHOLD.pencil) return d;
      }
    }
    return null;
  };

  // ── pointer dispatch — delegates to the active tool spec ───────────────
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
      drawings,
      selectedId,
      accentColor,
      trendlineDraft,
      pencilDraft,
      dragRef,
      requestRedraw: () => scheduleRef.current(),
      add: (d) => useDrawingsStore.getState().add(d),
      update: (id, patch) => useDrawingsStore.getState().update(id, patch),
      remove: (id) => useDrawingsStore.getState().remove(id),
      setSelected: (id) => useDrawingsStore.getState().setSelected(id),
      commitAndRevert: (id) => {
        const s = useDrawingsStore.getState();
        s.setSelected(id);
        s.setActiveTool('select');
      },
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
  // Select mode → 'none' by default (chart pans freely), toggled to 'auto'
  // only while the cursor is over a hit-testable drawing. Mid-drag the
  // toggle suspends so setPointerCapture isn't released. See spec G11
  // commentary.
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
    // hitTestAt closes over `drawings` / `priceSeries`; re-bind on change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTool, drawings, priceSeries, axis]);

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
