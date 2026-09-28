// Shift-drag angle constraints. Candle data is shared with day-extreme tools.

export type SnapCandle = {
  ts_ms: number;
  open: number;
  high: number;
  low: number;
  close: number;
};

export function constrainAngle(
  a: { x: number; y: number },
  b: { x: number; y: number },
): { x: number; y: number } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const adx = Math.abs(dx);
  const ady = Math.abs(dy);
  if (adx < 1 && ady < 1) return b;
  const angle = Math.atan2(dy, dx);
  // Quantize to the nearest multiple of 45°.
  const step = Math.PI / 4;
  const q = Math.round(angle / step) * step;
  const len = Math.hypot(dx, dy);
  return { x: a.x + Math.cos(q) * len, y: a.y + Math.sin(q) * len };
}
