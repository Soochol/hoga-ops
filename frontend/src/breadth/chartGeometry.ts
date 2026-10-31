import type { Value } from './report';

export const CHART_COLORS = ['var(--ma-1)', 'var(--ma-2)', 'var(--ma-6)', 'var(--ma-3)', 'var(--ma-4)', 'var(--ma-7)', 'var(--ma-8)'];
const CHART_DASHES = [undefined, '8 3', '2 3', '8 3 2 3', '12 3', '4 3 2 3'];

/** Assign from the full ETF registry, never the selected subset or sorted rows. */
export function fundStroke(index: number) {
  return { color: CHART_COLORS[index % CHART_COLORS.length], dash: CHART_DASHES[Math.floor(index / CHART_COLORS.length) % CHART_DASHES.length] };
}
/** Nulls break paths. Every x position is an actual trading session. */
export function chartPath(values: Value[], x: (i: number) => number, y: (v: number) => number): string {
  let path = '', pen = false;
  values.forEach((v, i) => {
    if (v === null) { pen = false; return; }
    path += `${pen ? 'L' : 'M'}${x(i).toFixed(2)},${y(v).toFixed(2)} `;
    pen = true;
  });
  return path.trim();
}

