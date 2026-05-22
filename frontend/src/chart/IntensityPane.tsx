import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { LineSeries, type IChartApi } from 'lightweight-charts';
import type { RangeBundle } from '../api/types';
import { type VirtualAxis } from '../util/virtualAxis';

// RGB bytes for the two sides. ImageData writes raw RGBA so we keep hex out of
// the hot path. Tokens still drive the rest of the UI (DESIGN.md governs); the
// canvas is one of the rare places we hardcode hex on purpose for perf.
const UP_RGB = [0x22, 0xc5, 0x5e] as const; // --up
const DOWN_RGB = [0xf4, 0x3f, 0x5e] as const; // --down

type Props = {
  chart: IChartApi;
  bundle: RangeBundle;
  axis: VirtualAxis;
  /**
   * Pane index to overlay onto. When provided, the canvas is portaled into the
   * pane's DOM element (via `chart.panes()[paneIndex].getHTMLElement()`) so
   * the heatmap aligns with that pane only. Falls back to a chart-wide overlay
   * if the pane element can't be resolved.
   */
  paneIndex?: number;
};

/**
 * IntensityPane — overlays a canvas onto the shared chart that paints the
 * depth_intensity bid/ask grid as a heatmap. lightweight-charts owns the price
 * axis below; this canvas piggy-backs on `chart.timeScale().timeToCoordinate`
 * to map virtual-axis timestamps to x-pixels and writes raw RGBA bytes via
 * ImageData.
 *
 * Phase 0 spike (2026-05-20) validated the ImageData path at ~12.4 ms / paint
 * on a 1000-time × 200-bin grid (under the 16 ms target). The naive
 * fillRect-per-cell path measured ~110 ms (FAIL). DO NOT switch back to
 * fillRect without re-running the perf baseline.
 */
export default function IntensityPane({ chart, bundle, axis, paneIndex }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  // Resolve the target pane's DOM element when `paneIndex` is provided. The
  // pane may not exist on first render (the series-bearing pane components
  // create it via `addSeries(..., paneIndex)` in their own effects), so we
  // poll on rAF for a few frames before giving up and rendering chart-wide.
  const [paneEl, setPaneEl] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (paneIndex === undefined) {
      setPaneEl(null);
      return;
    }
    // IntensityPane has no series of its own — it's a pure canvas heatmap.
    // To force lightweight-charts to create pane N (so its DOM element exists
    // and `setStretchFactor` can size it), we mount a transparent anchor
    // series on the target paneIndex. The series carries no data; it just
    // owns the pane until we unmount.
    let anchor: ReturnType<IChartApi['addSeries']> | null = null;
    try {
      anchor = chart.addSeries(
        LineSeries,
        { color: 'rgba(0,0,0,0)', lineWidth: 1 as any, lastValueVisible: false, priceLineVisible: false },
        paneIndex,
      );
    } catch {
      // If lightweight-charts rejects the call (older version, etc.), the
      // canvas falls back to chart-wide rendering.
    }

    let cancelled = false;
    let attempts = 0;
    const tryResolve = () => {
      if (cancelled) return;
      attempts += 1;
      try {
        const panes = chart.panes();
        const p = panes[paneIndex];
        const el = p?.getHTMLElement?.() ?? null;
        if (el) {
          // lightweight-charts panes use a <table><tr><td><div>…</div></td></tr>
          // layout. getHTMLElement() returns the <tr>. We can't portal a <div>
          // (or <canvas>) directly into a <tr> without React's DOM-nesting
          // validator complaining, so walk down to the first <div> child of a
          // <td> and portal there. Fall back to the original element if no
          // such div exists (older lightweight-charts versions).
          const inner = el.querySelector('td > div') as HTMLElement | null;
          setPaneEl(inner ?? el);
          return;
        }
      } catch {
        // ignore — lightweight-charts may throw if accessed mid-mount
      }
      if (attempts < 30) requestAnimationFrame(tryResolve);
    };
    requestAnimationFrame(tryResolve);
    return () => {
      cancelled = true;
      if (anchor) {
        try {
          chart.removeSeries(anchor);
        } catch {
          // chart may already be torn down
        }
      }
    };
  }, [chart, paneIndex]);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    // RangeBundle carries one DepthIntensity grid per segment (ADR-0013). Until
    // a follow-up wires per-segment iteration (Task 19-style adaptation for
    // intensity is not yet planned — flagged in Task 17a), render the first
    // day's grid so the type retype stays behaviour-preserving for single-day
    // ranges (the only case the prior single-grid code rendered correctly).
    const di = bundle.depth_intensity_by_day[0];
    if (!di) return;
    const bins = di.bid_grid[0]?.length ?? 0;
    if (bins === 0 || di.times.length === 0) return;

    function paint() {
      if (!canvas || !ctx) return;
      const ts = chart.timeScale();
      canvas.width = canvas.clientWidth;
      canvas.height = canvas.clientHeight;
      const w = canvas.width;
      const h = canvas.height;
      if (w === 0 || h === 0) return;
      const buf = ctx.createImageData(w, h);
      const data = buf.data;
      const cellH = h / bins;

      di.times.forEach((t, i) => {
        const xFloat = ts.timeToCoordinate((axis.toVirtual(t) / 1000) as any);
        if (xFloat === null) return;
        const nextT = di.times[i + 1] ?? t + di.bucket_ms;
        const xNextFloat =
          ts.timeToCoordinate((axis.toVirtual(nextT) / 1000) as any) ?? xFloat + 2;
        const xStart = Math.max(0, Math.floor(xFloat));
        const xEnd = Math.min(w, Math.floor(xNextFloat));
        if (xEnd <= xStart) return;

        for (let b = 0; b < bins; b++) {
          const bidV = di.bid_grid[i][b];
          const askV = di.ask_grid[i][b];
          if (bidV < 0.02 && askV < 0.02) continue;

          const isAsk = askV >= bidV;
          const intensity = isAsk ? askV : bidV;
          const rgb = isAsk ? DOWN_RGB : UP_RGB;
          const alpha = Math.min(255, Math.round(intensity * 255));

          const yStart = Math.max(0, Math.floor((bins - 1 - b) * cellH));
          const yEnd = Math.min(h, Math.floor((bins - b) * cellH));

          // Raw RGBA byte writes — Phase 0 spike confirmed this is ~10× faster
          // than the equivalent fillRect loop. DO NOT switch back without
          // re-running the perf baseline.
          for (let y = yStart; y < yEnd; y++) {
            const rowStart = (y * w + xStart) * 4;
            for (let x = 0; x < xEnd - xStart; x++) {
              const idx = rowStart + x * 4;
              data[idx] = rgb[0];
              data[idx + 1] = rgb[1];
              data[idx + 2] = rgb[2];
              data[idx + 3] = alpha;
            }
          }
        }
      });

      ctx.putImageData(buf, 0, 0);
    }

    const ts = chart.timeScale();
    ts.subscribeVisibleTimeRangeChange(paint);
    const ro = new ResizeObserver(paint);
    ro.observe(canvas);
    paint();
    return () => {
      ts.unsubscribeVisibleTimeRangeChange(paint);
      ro.disconnect();
    };
  }, [chart, bundle, axis]);

  // Wrap the canvas in a div so the portal target (which lightweight-charts
  // renders as a <tr>) doesn't directly host a <canvas> — invalid HTML
  // nesting that React's validateDOMNesting flags. The wrapper is benign:
  // absolute inset-0 contents anchor to the nearest positioned ancestor.
  const overlayEl = (
    <div className="absolute inset-0 pointer-events-none">
      <canvas
        ref={ref}
        className="absolute inset-0 w-full h-full"
        style={{ mixBlendMode: 'screen' }}
      />
    </div>
  );

  // When portaled into the pane DOM element, the parent <div data-pane> in
  // ChartStage no longer paints anything visible (canvas lives elsewhere in
  // the DOM tree). The pane element needs `position: relative` for the
  // absolutely-positioned wrapper to anchor correctly.
  if (paneEl) {
    if (getComputedStyle(paneEl).position === 'static') {
      paneEl.style.position = 'relative';
    }
    return createPortal(overlayEl, paneEl);
  }
  return overlayEl;
}
