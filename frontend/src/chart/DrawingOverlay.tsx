// frontend/src/chart/DrawingOverlay.tsx
import { useEffect, useMemo, useRef } from 'react';
import type { IChartApi, ISeriesApi } from 'lightweight-charts';
import { nanoid } from 'nanoid';
import type { VirtualAxis } from '../util/virtualAxis';
import { useDrawingsStore } from '../state/drawings';
import { renderDrawing, type ProjectCtx } from './drawing/render';
import type { Drawing } from './drawing/types';
import { PENCIL_MAX_POINTS, HIT_THRESHOLD } from './drawing/types';
import { distanceToHline, distanceToPolyline, distanceToSegment } from './drawing/hitTest';
import { resolveTokens } from '../util/tokens';

// Canvas 2D's strokeStyle does NOT resolve CSS `var(--…)` references — it
// silently falls back to black. Every other canvas overlay in the repo
// (VolumeProfileOverlay, DayBoundaryOverlay) uses resolveTokens for this
// reason. We resolve once at mount and reuse the hex for both creation
// (drawing.color) and rendering.
const TOKEN_SPEC = { accent: ['--accent', '#14B8A6'] } as const;

type Props = {
  chart: IChartApi;
  axis: VirtualAxis;
  /**
   * Any series we can read a price scale off. Pane 0's candle series is the
   * canonical choice; ChartStage looks it up after the candle pane mounts.
   */
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

  // Resolve --accent once per mount; the tokens module is the single source
  // of truth (CLAUDE.md "Design System") and the canvas needs a literal hex.
  const accentColor = useMemo(() => resolveTokens(TOKEN_SPEC).accent, []);

  // Single rAF redraw coalescer — same pattern as DayBoundaryOverlay.
  useEffect(() => {
    const ts = chart.timeScale();
    let raf = 0;
    const schedule = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(draw);
    };
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
      const ctx: ProjectCtx = { chart, axis, priceSeries, width: w, height: h };
      for (const d of drawings) {
        renderDrawing(c, ctx, d, d.id === selectedId);
      }
    };

    ts.subscribeVisibleLogicalRangeChange(schedule);
    const ro =
      containerRef.current && typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(schedule)
        : null;
    if (ro && containerRef.current) ro.observe(containerRef.current);
    schedule(); // initial paint
    return () => {
      cancelAnimationFrame(raf);
      ts.unsubscribeVisibleLogicalRangeChange(schedule);
      ro?.disconnect();
    };
  }, [chart, axis, priceSeries, drawings, selectedId, activeCode]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      // Don't steal keys from form controls.
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
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

  const trendlineDraftRef = useRef<{ a: { realMs: number; price: number }; pointerId: number } | null>(null);
  const pencilDraftRef = useRef<{ points: { realMs: number; price: number }[]; pointerId: number; lastFrame: number } | null>(null);
  type DragMode =
    | { kind: 'body'; id: string; lastRealMs: number; lastPrice: number; pointerId: number }
    | { kind: 'handle'; id: string; endpoint: 'a' | 'b'; pointerId: number };
  const dragRef = useRef<DragMode | null>(null);

  const pixelToData = (px: number, py: number) => {
    if (!priceSeries) return null;
    const timeSec = chart.timeScale().coordinateToTime(px);
    if (timeSec == null) return null;
    const virtualMs = (timeSec as number) * 1000;
    const realMs = axis.toReal(virtualMs);
    const price = priceSeries.coordinateToPrice(py);
    if (price == null) return null;
    return { realMs, price: Number(price) };
  };

  const realMsToCanvasX = (realMs: number): number | null => {
    if (!axis.contains(realMs)) return null;
    const virtualMs = axis.toVirtual(realMs);
    const x = chart.timeScale().timeToCoordinate((virtualMs / 1000) as import('lightweight-charts').UTCTimestamp);
    return x == null ? null : (x as number);
  };

  const hitTestAt = (px: number, py: number): Drawing | null => {
    // Walk in reverse so newer drawings (drawn last → on top) are tested first.
    for (let i = drawings.length - 1; i >= 0; i--) {
      const d = drawings[i];
      if (d.kind === 'hline') {
        const y = priceSeries?.priceToCoordinate(d.price);
        if (y != null && distanceToHline({ x: px, y: py }, y) <= HIT_THRESHOLD.hline) {
          return d;
        }
      } else if (d.kind === 'trendline') {
        const xa = realMsToCanvasX(d.a.realMs);
        const ya = priceSeries?.priceToCoordinate(d.a.price);
        const xb = realMsToCanvasX(d.b.realMs);
        const yb = priceSeries?.priceToCoordinate(d.b.price);
        if (xa != null && ya != null && xb != null && yb != null) {
          if (
            distanceToSegment({ x: px, y: py }, { x: xa, y: ya }, { x: xb, y: yb }) <=
            HIT_THRESHOLD.trendlineBody
          ) {
            return d;
          }
        }
      } else if (d.kind === 'pencil') {
        const poly: { x: number; y: number }[] = [];
        for (const pt of d.points) {
          const x = realMsToCanvasX(pt.realMs);
          const y = priceSeries?.priceToCoordinate(pt.price);
          if (x != null && y != null) poly.push({ x, y: Number(y) });
        }
        if (distanceToPolyline({ x: px, y: py }, poly) <= HIT_THRESHOLD.pencil) {
          return d;
        }
      }
    }
    return null;
  };

  // Pointer handler dispatch keyed by activeTool. We attach onPointerDown
  // on the container; tools that need drag track it via setPointerCapture.
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;

    if (activeTool === 'select') {
      // Handle hit-test takes precedence for trendlines.
      const selected = selectedId
        ? drawings.find((d) => d.id === selectedId)
        : null;
      if (selected && selected.kind === 'trendline') {
        const xa = realMsToCanvasX(selected.a.realMs);
        const ya = priceSeries?.priceToCoordinate(selected.a.price);
        const xb = realMsToCanvasX(selected.b.realMs);
        const yb = priceSeries?.priceToCoordinate(selected.b.price);
        if (
          xa != null && ya != null &&
          Math.hypot(px - xa, py - Number(ya)) <= HIT_THRESHOLD.trendlineHandle
        ) {
          dragRef.current = { kind: 'handle', id: selected.id, endpoint: 'a', pointerId: e.pointerId };
          (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
          return;
        }
        if (
          xb != null && yb != null &&
          Math.hypot(px - xb, py - Number(yb)) <= HIT_THRESHOLD.trendlineHandle
        ) {
          dragRef.current = { kind: 'handle', id: selected.id, endpoint: 'b', pointerId: e.pointerId };
          (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
          return;
        }
      }
      const hit = hitTestAt(px, py);
      useDrawingsStore.getState().setSelected(hit?.id ?? null);
      if (hit) {
        const data = pixelToData(px, py);
        if (!data) return;
        dragRef.current = {
          kind: 'body',
          id: hit.id,
          lastRealMs: data.realMs,
          lastPrice: data.price,
          pointerId: e.pointerId,
        };
        (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
      }
      return;
    }

    if (!priceSeries) return;

    if (activeTool === 'hline') {
      const price = priceSeries.coordinateToPrice(py);
      if (price == null) return;
      useDrawingsStore.getState().add({
        id: nanoid(8),
        kind: 'hline',
        price: typeof price === 'number' ? price : Number(price),
        color: accentColor,
        width: 1.5,
      });
      return;
    }

    if (activeTool === 'trendline') {
      const data = pixelToData(px, py);
      if (!data) return;
      trendlineDraftRef.current = { a: data, pointerId: e.pointerId };
      (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
      return;
    }
    if (activeTool === 'pencil') {
      const data = pixelToData(px, py);
      if (!data) return;
      pencilDraftRef.current = {
        points: [data],
        pointerId: e.pointerId,
        lastFrame: 0,
      };
      (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
      return;
    }
    if (activeTool === 'eraser') {
      const hit = hitTestAt(px, py);
      if (hit) useDrawingsStore.getState().remove(hit.id);
      return;
    }
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (activeTool === 'select') {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== e.pointerId) return;
      const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
      const data = pixelToData(e.clientX - rect.left, e.clientY - rect.top);
      if (!data) return;
      const target = drawings.find((d) => d.id === drag.id);
      if (!target) return;
      if (drag.kind === 'handle' && target.kind === 'trendline') {
        const patch = drag.endpoint === 'a' ? { a: data } : { b: data };
        useDrawingsStore.getState().update(target.id, patch as Partial<Drawing>);
      } else if (drag.kind === 'body') {
        const dMs = data.realMs - drag.lastRealMs;
        const dPrice = data.price - drag.lastPrice;
        if (target.kind === 'hline') {
          useDrawingsStore.getState().update(target.id, { price: target.price + dPrice } as Partial<Drawing>);
        } else if (target.kind === 'trendline') {
          useDrawingsStore.getState().update(target.id, {
            a: { realMs: target.a.realMs + dMs, price: target.a.price + dPrice },
            b: { realMs: target.b.realMs + dMs, price: target.b.price + dPrice },
          } as Partial<Drawing>);
        } else if (target.kind === 'pencil') {
          useDrawingsStore.getState().update(target.id, {
            points: target.points.map((p) => ({
              realMs: p.realMs + dMs,
              price: p.price + dPrice,
            })),
          } as Partial<Drawing>);
        }
        drag.lastRealMs = data.realMs;
        drag.lastPrice = data.price;
      }
      return;
    }
    // Trendline preview-during-drag is a v1 follow-up — for now the line
    // appears on commit only. No mousemove branch needed.
    if (activeTool === 'pencil') {
      const draft = pencilDraftRef.current;
      if (!draft || draft.pointerId !== e.pointerId) return;
      const now = performance.now();
      if (now - draft.lastFrame < 16) return; // RAF-aligned throttle (G11)
      draft.lastFrame = now;
      const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
      const data = pixelToData(e.clientX - rect.left, e.clientY - rect.top);
      if (!data) return;
      if (draft.points.length >= PENCIL_MAX_POINTS) return;
      draft.points.push(data);
      return;
    }
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (activeTool === 'select') {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== e.pointerId) return;
      dragRef.current = null;
      (e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId);
      return;
    }
    if (activeTool === 'trendline') {
      const draft = trendlineDraftRef.current;
      if (!draft || draft.pointerId !== e.pointerId) return;
      const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
      const data = pixelToData(e.clientX - rect.left, e.clientY - rect.top);
      trendlineDraftRef.current = null;
      (e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId);
      if (!data) return;
      // Reject zero-length trendlines (click without drag).
      if (data.realMs === draft.a.realMs && data.price === draft.a.price) return;
      useDrawingsStore.getState().add({
        id: nanoid(8),
        kind: 'trendline',
        a: draft.a,
        b: data,
        color: accentColor,
        width: 1.5,
      });
      return;
    }
    if (activeTool === 'pencil') {
      const draft = pencilDraftRef.current;
      if (!draft || draft.pointerId !== e.pointerId) return;
      pencilDraftRef.current = null;
      (e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId);
      if (draft.points.length < 2) return;
      const pencil: Drawing = {
        id: nanoid(8),
        kind: 'pencil',
        points: draft.points,
        color: accentColor,
        width: 1.5,
      };
      useDrawingsStore.getState().add(pencil);
      return;
    }
  };

  // Pointer-events gating.
  //
  // Naive gate `activeTool !== 'select' || drawings.length > 0` re-broke the
  // pan-lock fix from Task 1: when ANY drawing existed in select mode the
  // overlay stole every event from the chart canvas underneath, so pan
  // gestures never reached lightweight-charts.
  //
  // Correct gate:
  //   - Any drawing tool active → capture everything (auto).
  //   - Select mode → 'none' by default, toggled to 'auto' only while the
  //     cursor is over a hit-testable drawing. A global mousemove listener
  //     runs hit-test against the container's coordinate space and flips
  //     pointerEvents accordingly. Cost: one binary search through drawings
  //     per mousemove — fine at user-realistic counts (< 50 drawings).
  //
  // While dragging in select mode, we MUST keep 'auto' (otherwise the next
  // mousemove that lands off-drawing would release pointerEvents mid-drag).
  // setPointerCapture already pins the pointer to this element; the hover
  // toggle just suspends until pointerup.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    if (activeTool !== 'select') {
      container.style.pointerEvents = 'auto';
      return;
    }
    container.style.pointerEvents = 'none';
    const onHover = (e: MouseEvent) => {
      if (dragRef.current) return; // mid-drag — leave pointerEvents alone
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
    // hitTestAt closes over `drawings` / `priceSeries` — re-bind when those
    // change so the hover hit-test sees the latest list.
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
