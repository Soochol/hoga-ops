import { realMsToYyyymmdd } from './liveDateTime';

export interface ProgramTradeTick {
  key: string;
  tMs: number;
  price: number | null;
  deltaQty: number;
}

/** Display Kiwoom FID 211 directly, never a difference of cumulative snapshots
 * or the collector's 30-second delta. Preserve receive order, including equal
 * timestamps and repeated amounts; no matching to individual stock trades. */
export function buildProgramTradeTicks(
  snapshots: readonly Record<string, unknown>[], date: string, limit = 200,
): ProgramTradeTick[] {
  const ticks: ProgramTradeTick[] = [];
  const occurrences = new Map<string, number>();
  if (limit <= 0) return ticks;
  for (let i = snapshots.length - 1; i >= 0; i--) {
    const snap = snapshots[i];
    const tMs = snap.t_ms;
    const deltaQty = snap.event_delta_qty;
    if (typeof tMs !== 'number' || !Number.isSafeInteger(tMs) || tMs <= 0
      || realMsToYyyymmdd(tMs) !== date
      || typeof deltaQty !== 'number' || !Number.isSafeInteger(deltaQty) || deltaQty === 0) continue;
    const price = typeof snap.price === 'number' && Number.isSafeInteger(snap.price) && snap.price > 0 ? snap.price : null;
    const base = `${tMs}-${price}-${deltaQty}`;
    const occurrence = occurrences.get(base) ?? 0;
    occurrences.set(base, occurrence + 1);
    ticks.push({ key: `${base}-${occurrence}`, tMs, price, deltaQty });
    if (ticks.length >= limit) break;
  }
  return ticks;
}
