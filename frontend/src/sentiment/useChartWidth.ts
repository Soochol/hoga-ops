import { useEffect, useState } from 'react';

/** Match SVG coordinates to its rendered width so labels never shrink with the plot. */
export function useChartWidth(fallback: number) {
  const [element, ref] = useState<SVGSVGElement | null>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      const next = Math.round(entry.contentRect.width);
      if (next > 0) setWidth(next);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return { ref, width };
}
