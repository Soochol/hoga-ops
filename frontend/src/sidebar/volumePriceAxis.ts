/** Reserve the POC label first, then keep only ticks with enough physical space. */
export function priceTickPcts(height: number, fontSize: number, pocPct: number | null): number[] {
  const half = fontSize / 2;
  const center = (pct: number) => Math.max(half, Math.min(height - half, height * pct / 100));
  const occupied = pocPct == null ? [] : [center(pocPct)];
  return [0, 100, 50].filter(pct => {
    const y = center(pct);
    if (occupied.some(other => Math.abs(y - other) < fontSize + 3)) return false;
    occupied.push(y);
    return true;
  }).sort((a, b) => a - b);
}
