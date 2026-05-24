// frontend/src/chart/DrawingOverlay.tsx
import { useEffect, useRef } from 'react';
import type { IChartApi, ISeriesApi } from 'lightweight-charts';
import { nanoid } from 'nanoid';
import type { VirtualAxis } from '../util/virtualAxis';
import { useDrawingsStore } from '../state/drawings';
import { renderDrawing, type ProjectCtx } from './drawing/render';

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

  // Pointer handler dispatch keyed by activeTool. We attach onPointerDown
  // on the container; tools that need drag track it via setPointerCapture.
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (activeTool === 'select') return; // select-mode handler lands in Task 12
    if (!priceSeries) return;
    const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;

    if (activeTool === 'hline') {
      const price = priceSeries.coordinateToPrice(py);
      if (price == null) return;
      useDrawingsStore.getState().add({
        id: nanoid(8),
        kind: 'hline',
        price: typeof price === 'number' ? price : Number(price),
        color: 'var(--accent, #FFD60A)',
        width: 1.5,
      });
      return;
    }
    // trendline, pencil, eraser handled in subsequent tasks
    void px;
  };

  // Pointer events flow to the chart unless a drawing tool is active OR
  // there are drawings to interact with in select mode.
  const captureEvents = activeTool !== 'select' || drawings.length > 0;

  return (
    <div
      ref={containerRef}
      data-drawing-overlay
      className="absolute inset-0 z-20"
      style={{ pointerEvents: captureEvents ? 'auto' : 'none' }}
      onPointerDown={onPointerDown}
    >
      <canvas ref={canvasRef} className="absolute inset-0" />
    </div>
  );
}
