import { isIndicatorEligibleBook, type ObSnapshot } from './bucketHogaSeries';
import { tradingDayOf } from '../util/tradingDay';

/** 래칫 내부 peak 값 — 날짜 없는 {price, qty, t_ms}. 래칫은 오늘 하루에만 적용되므로 date는
 *  훅(useDayAskPeaks)이 todayKst로 부착해 와이어 `AskPeak`을 만든다. AskPeak은 구조적으로
 *  DayPeak의 상위(추가 date 필드)라 seed로 그대로 넘길 수 있다. */
export type DayPeak = { price: number; qty: number; t_ms: number };

export type RatchetState = {
  peak: DayPeak | null;
  tradingDay: number;
  lastTMs: number;
};

type AskPriceFilter = (price: number) => boolean;

export const FRESH_RATCHET: RatchetState = { peak: null, tradingDay: -1, lastTMs: -1 };

/** seed로 시작한 단조 ratchet에 한 ObSnapshot을 폴드. 공용 술어 isIndicatorEligibleBook을
 *  통과하는 스냅샷만 — 연속거래(isContinuousBook, 마감·VI 3호가 붕괴 배제) AND 정규장 개장
 *  (isAfterRegularOpen, 09:00↑, 개장 동시호가 배제; 백엔드 _book_indicator_eligible_sql과 동일).
 *  거래일 경계에서 리셋·재시드, 동률 비교체(먼저 도달 유지), 이미 본 tMs는 멱등.
 *  ob.asks가 없으면(totals-only) 후보는 seed뿐. */
export function foldAskPeak(
  prev: RatchetState,
  seed: DayPeak | null,
  ob: ObSnapshot,
  allowPrice?: AskPriceFilter,
): RatchetState {
  const day = tradingDayOf(ob.t_ms);
  let state = prev;
  if (day !== prev.tradingDay) {
    // 거래일 전환: 리셋 후 seed 재반영.
    state = { peak: seed, tradingDay: day, lastTMs: -1 };
  }
  if (ob.t_ms <= state.lastTMs) return state; // 멱등(증분)
  let best = state.peak;
  if (isIndicatorEligibleBook(ob) && ob.asks) {
    for (const lv of ob.asks) {
      if (allowPrice && !allowPrice(lv.price)) continue;
      if (lv.qty > 0 && (best === null || lv.qty > best.qty)) {
        best = { price: lv.price, qty: lv.qty, t_ms: ob.t_ms };
      }
    }
  }
  return { peak: best, tradingDay: day, lastTMs: ob.t_ms };
}

/** "당일 매도 최대벽" 규칙 전체를 소유하는 공개 reducer: prev 상태에 ob 스냅샷 배치를 폴드하고
 *  seed 하한을 보장한 새 ratchet 상태를 반환한다 — 즉 당일 peak = max(seed, 본 연속거래 ask 레벨들).
 *  훅(useDayAskPeaks)은 이걸 구동만 한다(얇은 adapter). seed 하한은 **배치당 1회** 적용한다(스냅샷당이
 *  아님 — foldAskPeak은 거래일 리셋 때만 seed를 후보로 쓰므로): 오후 진입·range 재fetch로 더 큰 seed가
 *  늦게 들어와도 mid-day에 반영하되 동률은 먼저 것 유지(strict >). */
export function reduceDayAskPeak(
  prev: RatchetState,
  seed: DayPeak | null,
  obs: ReadonlyArray<ObSnapshot>,
  allowPrice?: AskPriceFilter,
): RatchetState {
  let s = prev;
  for (const ob of obs) s = foldAskPeak(s, seed, ob, allowPrice);
  if (seed && (s.peak === null || seed.qty > s.peak.qty)) {
    s = { ...s, peak: seed };
  }
  return s;
}
