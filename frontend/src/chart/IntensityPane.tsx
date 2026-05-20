import { useEffect, useRef } from 'react';
import type { IChartApi } from 'lightweight-charts';
import type { SessionBundle } from '../api/types';
import { type Segment, realToVirtual } from '../util/time';

// RGB bytes for the two sides. ImageData writes raw RGBA so we keep hex out of
// the hot path. Tokens still drive the rest of the UI (DESIGN.md governs); the
// canvas is one of the rare places we hardcode hex on purpose for perf.
const UP_RGB = [0x22, 0xc5, 0x5e] as const; // --up
const DOWN_RGB = [0xf4, 0x3f, 0x5e] as const; // --down

type Props = { chart: IChartApi; bundle: SessionBundle; segments: Segment[] };

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
export default function IntensityPane({ chart, bundle, segments }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const di = bundle.depth_intensity;
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
        const xFloat = ts.timeToCoordinate(
          (realToVirtual(segments, t) / 1000) as any,
        );
        if (xFloat === null) return;
        const nextT = di.times[i + 1] ?? t + di.bucket_ms;
        const xNextFloat =
          ts.timeToCoordinate((realToVirtual(segments, nextT) / 1000) as any) ?? xFloat + 2;
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
  }, [chart, bundle, segments]);

  return (
    <canvas
      ref={ref}
      className="absolute inset-0 w-full h-full pointer-events-none"
      style={{ mixBlendMode: 'screen' }}
    />
  );
}
