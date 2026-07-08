import { create } from 'zustand';

/** Per-code timestamp (client Date.now()) of the last received
 * `promotion_completed` WS event. useLiveRangeDelta reads its code's value and
 * refetches the today range when it advances past the query's last update —
 * pure acceleration over the 5-min polling fallback (WS 푸시 승격 무효화).
 *
 * The value is a client-clock stamp of *receipt*, compared against react-query's
 * `dataUpdatedAt` (also client-clock), so the two are directly comparable — the
 * event carries no server timestamp, only `{code}`. */
interface LivePromotionState {
  byCode: Record<string, number>;
  markPromotion: (code: string, atMs: number) => void;
}

export const useLivePromotionStore = create<LivePromotionState>((set) => ({
  byCode: {},
  // Monotonic per code — a later stamp only. Skipping no-op writes keeps
  // per-code selectors from re-rendering on an unrelated code's promotion.
  markPromotion: (code, atMs) =>
    set((s) => ((s.byCode[code] ?? 0) >= atMs ? s : { byCode: { ...s.byCode, [code]: atMs } })),
}));

/** Non-hook accessor for the WS event handler (runs outside React). */
export function markPromotion(code: string, atMs: number): void {
  useLivePromotionStore.getState().markPromotion(code, atMs);
}
