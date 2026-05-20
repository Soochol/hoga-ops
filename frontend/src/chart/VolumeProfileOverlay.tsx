import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { IChartApi } from 'lightweight-charts';
import type { SessionBundle, VolumeProfileBin } from '../api/types';
import { type Segment, realToVirtual } from '../util/time';

// Use --accent (teal) at varied opacity. Canvas can't read CSS vars, so we
// resolve once and write RGBA bytes.
function resolveAccentRGB(): [number, number, number] {
  if (typeof document === 'undefined') return [0x14, 0xb8, 0xa6];
  const hex = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
  if (!hex || hex.length < 7) return [0x14, 0xb8, 0xa6];
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

type Props = {
  chart: IChartApi;
  bundle: SessionBundle;
  segments: Segment[];
  mode?: 'per-day' | 'composite';
  /** Approximate fraction of total volume covered by the value area (default 0.7). */
  valueAreaFrac?: number;
  /**
   * Pane index to overlay onto. When provided, the canvas is portaled into
   * that pane's DOM element so the profile aligns with the candle pane only.
   * Falls back to chart-wide overlay if the pane can't be resolved.
   */
  paneIndex?: number;
};

/**
 * VolumeProfileOverlay — paints horizontal volume-profile bars onto a canvas
 * that sits above the candle pane. Each bin's width scales with traded qty.
 *
 * - POC (Point of Control = highest-qty bin) is rendered at 0.5 opacity.
 * - Other bins render at 0.2 opacity.
 * - VAH (Value Area High) is drawn as a single horizontal line at the top of
 *   the price range covering ~`valueAreaFrac` (default 0.7) of total volume.
 * - `mode: 'composite'` paints one profile anchored to the right ~30% of the
 *   chart; `mode: 'per-day'` paints one profile per segment, anchored to the
 *   right ~30% of that segment's pixel range.
 */
export default function VolumeProfileOverlay({
  chart,
  bundle,
  segments,
  mode = 'composite',
  valueAreaFrac = 0.7,
  paneIndex,
}: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  // Resolve target pane element (see IntensityPane for rationale).
  const [paneEl, setPaneEl] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (paneIndex === undefined) {
      setPaneEl(null);
      return;
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
          // lightweight-charts returns the <tr>; portal into the inner <div>
          // so React's DOM-nesting validator is happy.
          const inner = el.querySelector('td > div') as HTMLElement | null;
          setPaneEl(inner ?? el);
          return;
        }
      } catch {
        // ignore
      }
      if (attempts < 30) requestAnimationFrame(tryResolve);
    };
    requestAnimationFrame(tryResolve);
    return () => {
      cancelled = true;
    };
  }, [chart, paneIndex]);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const vp = bundle.volume_profile;
    if (vp.bins.length === 0) return;

    const [r, g, b] = resolveAccentRGB();
    const poc = pocIndex(vp.bins);
    const va = valueArea(vp.bins, valueAreaFrac);

    function paint() {
      if (!canvas || !ctx) return;
      const ts = chart.timeScale();
      canvas.width = canvas.clientWidth;
      canvas.height = canvas.clientHeight;
      const w = canvas.width;
      const h = canvas.height;
      if (w === 0 || h === 0) return;
      ctx.clearRect(0, 0, w, h);

      // Pick the horizontal anchor x-range based on mode.
      // For 'composite', the profile spans the right 30% of the chart width.
      // For 'per-day', anchor each segment's virtual range and use its right
      // 30% as the profile zone.
      const ranges: Array<[number, number]> =
        mode === 'composite'
          ? [[Math.max(0, Math.floor(w * 0.7)), w]]
          : segments.map((s) => {
              const x0 = ts.timeToCoordinate(
                (realToVirtual(segments, s.sessionOpenMs) / 1000) as any,
              );
              const x1 = ts.timeToCoordinate(
                (realToVirtual(segments, s.sessionCloseMs) / 1000) as any,
              );
              const a = Math.max(0, Math.floor(x0 ?? 0));
              const z = Math.min(w, Math.floor(x1 ?? w));
              return [Math.max(a, z - Math.floor((z - a) * 0.3)), z];
            });

      const maxQty = Math.max(1, ...vp.bins.map((bn) => bn.qty));
      const binCount = vp.bins.length;
      const binH = h / binCount;

      for (const [xStart, xEnd] of ranges) {
        if (xEnd <= xStart) continue;
        const width = xEnd - xStart;
        for (let i = 0; i < binCount; i++) {
          const bin = vp.bins[i];
          if (bin.qty <= 0) continue;
          const barW = (bin.qty / maxQty) * width;
          const alpha = i === poc ? 0.5 : 0.2;
          // Higher price bin = HIGHER on screen → reverse y.
          const y = (binCount - 1 - i) * binH;
          ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${alpha})`;
          ctx.fillRect(xEnd - barW, y, barW, Math.max(1, binH - 1));
        }
        // VAH line at the top of the value area.
        if (va.vah !== null) {
          const y = (binCount - 1 - va.vah) * binH;
          ctx.fillStyle = `rgba(${r}, ${g}, ${b}, 0.7)`;
          ctx.fillRect(xStart, y, width, 1);
        }
      }
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
  }, [chart, bundle, segments, mode, valueAreaFrac]);

  // Wrap canvas in a div — portal target is lightweight-charts' <tr>,
  // and <canvas> can't be a direct child of <tr> (DOM nesting warning).
  const overlayEl = (
    <div className="absolute inset-0 pointer-events-none">
      <canvas ref={ref} className="absolute inset-0 w-full h-full" />
    </div>
  );
  if (paneEl) {
    if (getComputedStyle(paneEl).position === 'static') {
      paneEl.style.position = 'relative';
    }
    return createPortal(overlayEl, paneEl);
  }
  return overlayEl;
}

function pocIndex(bins: VolumeProfileBin[]): number {
  let best = 0;
  let max = -1;
  for (let i = 0; i < bins.length; i++) {
    if (bins[i].qty > max) {
      max = bins[i].qty;
      best = i;
    }
  }
  return best;
}

function valueArea(
  bins: VolumeProfileBin[],
  frac: number,
): { val: number | null; vah: number | null } {
  const total = bins.reduce((s, bn) => s + bn.qty, 0);
  if (total === 0) return { val: null, vah: null };
  const target = total * frac;
  const poc = pocIndex(bins);
  let acc = bins[poc].qty;
  let lo = poc;
  let hi = poc;
  while (acc < target && (lo > 0 || hi < bins.length - 1)) {
    const upQty = hi < bins.length - 1 ? bins[hi + 1].qty : -1;
    const dnQty = lo > 0 ? bins[lo - 1].qty : -1;
    if (upQty >= dnQty) {
      hi += 1;
      acc += bins[hi].qty;
    } else {
      lo -= 1;
      acc += bins[lo].qty;
    }
  }
  return { val: lo, vah: hi };
}
