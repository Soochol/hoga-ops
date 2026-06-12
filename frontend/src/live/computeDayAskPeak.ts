import type { AskPeak } from '../api/types';
import { isContinuousBook, type ObSnapshot } from './bucketHogaSeries';

export type RatchetState = {
  peak: AskPeak | null;
  tradingDay: number;
  lastTMs: number;
};

export const FRESH_RATCHET: RatchetState = { peak: null, tradingDay: -1, lastTMs: -1 };

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
/** KST 자정 기준 거래일 번호(급증 마커 detectSurges와 동일 규칙). */
export function tradingDayOf(tMs: number): number {
  return Math.floor((tMs + KST_OFFSET_MS) / 86_400_000);
}

/** seed로 시작한 단조 ratchet에 한 ObSnapshot을 폴드. 연속거래(isContinuousBook)만,
 *  거래일 경계에서 리셋·재시드, 동률 비교체(먼저 도달 유지), 이미 본 tMs는 멱등.
 *  ob.asks가 없으면(totals-only) 후보는 seed뿐. */
export function foldAskPeak(
  prev: RatchetState,
  seed: AskPeak | null,
  ob: ObSnapshot,
): RatchetState {
  const day = tradingDayOf(ob.t_ms);
  let state = prev;
  if (day !== prev.tradingDay) {
    // 거래일 전환: 리셋 후 seed 재반영.
    state = { peak: seed, tradingDay: day, lastTMs: -1 };
  }
  if (ob.t_ms <= state.lastTMs) return state; // 멱등(증분)
  let best = state.peak;
  if (isContinuousBook(ob) && ob.asks) {
    for (const lv of ob.asks) {
      if (lv.qty > 0 && (best === null || lv.qty > best.qty)) {
        best = { price: lv.price, qty: lv.qty, t_ms: ob.t_ms };
      }
    }
  }
  return { peak: best, tradingDay: day, lastTMs: ob.t_ms };
}
