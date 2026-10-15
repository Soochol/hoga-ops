import { realMsToYyyymmdd } from './liveDateTime';

export interface ProgramTradeTick {
  key: string;
  tMs: number;
  price: number | null;
  deltaQty: number;
  eventId?: string;
}

/** Display Kiwoom FID 211 directly, never a difference of cumulative snapshots
 * or the collector's 30-second delta. Preserve receive order, including equal
 * timestamps and repeated amounts; no matching to individual stock trades. */
export function buildProgramTradeTicks(
  snapshots: readonly Record<string, unknown>[], date: string, limit = 200,
): ProgramTradeTick[] {
  const ticks: ProgramTradeTick[] = [];
  const occurrences = new Map<string, number>();
  const seen = new Set<string>();
  if (limit <= 0) return ticks;
  for (let i = snapshots.length - 1; i >= 0; i--) {
    const snap = snapshots[i];
    const tMs = snap.t_ms;
    const deltaQty = snap.event_delta_qty;
    if (typeof tMs !== 'number' || !Number.isSafeInteger(tMs) || tMs <= 0
      || realMsToYyyymmdd(tMs) !== date
      || typeof deltaQty !== 'number' || !Number.isSafeInteger(deltaQty) || deltaQty === 0) continue;
    const price = typeof snap.price === 'number' && Number.isSafeInteger(snap.price) && snap.price > 0 ? snap.price : null;
    const eventId = typeof snap.event_id === 'string' && snap.event_id ? snap.event_id : undefined;
    if (eventId && seen.has(eventId)) continue;
    if (eventId) seen.add(eventId);
    const base = `${tMs}-${price}-${deltaQty}`;
    const occurrence = occurrences.get(base) ?? 0;
    occurrences.set(base, occurrence + 1);
    ticks.push({ key: eventId ? `event:${eventId}` : `${base}-${occurrence}`, tMs, price, deltaQty, eventId });
    if (ticks.length >= limit) break;
  }
  return ticks;
}

export function mergeProgramTradeTicks(...lists: readonly (readonly ProgramTradeTick[])[]): ProgramTradeTick[] {
  const byKey = new Map<string, ProgramTradeTick>();
  for (const list of lists) for (const tick of list) if (!byKey.has(tick.key)) byKey.set(tick.key, tick);
  return [...byKey.values()].sort((a, b) => b.tMs - a.tMs
    || (a.eventId && b.eventId && !a.eventId.startsWith('ka90008:') && !b.eventId.startsWith('ka90008:')
      ? b.eventId.localeCompare(a.eventId) : 0));
}

/** History owns completed supplier seconds; WS is only the newer live tail. */
export function combineProgramTradeHistory(live: readonly ProgramTradeTick[], history: readonly ProgramTradeTick[], latestAtMs: number | null): ProgramTradeTick[] {
  const boundary = latestAtMs === null ? null : Math.floor(latestAtMs / 1000) * 1000 + 1000;
  return mergeProgramTradeTicks(boundary === null ? live : live.filter(tick => tick.tMs >= boundary), history);
}
