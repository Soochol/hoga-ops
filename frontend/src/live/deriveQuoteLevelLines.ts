import type { RangeBundle, QuoteRatioPoint } from '../api/types';
import { isSyntheticHogaGapPoint } from '../chart/util/hogaGapHide';
import { quoteRatioPointsForBundle } from '../chart/projectors/quoteRatioPoints';
import { quoteImbalance } from '../util/imbalance';

/** 총잔량 현재값 수평선 모델 — 매수·매도 각각 마지막 유효 버킷의 잔량. */
export type QuoteTotalsLevels = { bid: number; ask: number } | null;

/**
 * quote_ratio 포인트 배열 끝에서 마지막 "실제" 버킷을 찾는다. hoga-gap sentinel
 * (isSyntheticHogaGapPoint)은 값이 없는 자리표시자라 건너뛴다. 뒤에서부터 스캔하므로
 * 최신 버킷을 O(꼬리 gap 개수) 안에 찾는다. quote_ratio 는 시간순 append.
 */
function lastRealPoint(points: readonly QuoteRatioPoint[]): QuoteRatioPoint | null {
  for (let i = points.length - 1; i >= 0; i--) {
    const p = points[i];
    if (!isSyntheticHogaGapPoint(p)) return p;
  }
  return null;
}

/**
 * 총잔량 pane 현재값 수평선의 매수·매도 값을 산출한다. 총잔량 라인(quoteTotals.ts
 * projectBid/Ask)과 동일한 소스·intraMax 규칙을 써 라인 끝점과 수평선이 정렬된다.
 * intraMax = 분봉 내 최댓값(bid_max/ask_max), 아니면 종가 시점 총잔량(bid_total/ask_total).
 * 유효 버킷이 없으면 null → 수평선 숨김.
 */
export function deriveQuoteTotalsLevels(bundle: RangeBundle, intraMax: boolean): QuoteTotalsLevels {
  const p = lastRealPoint(quoteRatioPointsForBundle(bundle));
  if (!p) return null;
  const bid = intraMax ? p.bid_max : p.bid_total;
  const ask = intraMax ? p.ask_max : p.ask_total;
  if (!Number.isFinite(bid) || !Number.isFinite(ask)) return null;
  return { bid, ask };
}

/**
 * 호가비 pane 현재값 수평선의 값을 산출한다. ratio.ts projectRatioPoints 와 동일하게
 * quoteImbalance 로 계산 — 라인 끝점과 정렬된다. intraMax = 분봉 내 |불균형| 극값
 * (imb_max_bid/imb_max_ask), 아니면 종가 시점(bid_total/ask_total).
 * 유효 버킷이 없으면 null → 수평선 숨김.
 */
export function deriveRatioLevel(bundle: RangeBundle, intraMax: boolean): number | null {
  const p = lastRealPoint(quoteRatioPointsForBundle(bundle));
  if (!p) return null;
  const value = intraMax
    ? quoteImbalance(p.imb_max_bid, p.imb_max_ask)
    : quoteImbalance(p.bid_total, p.ask_total);
  return Number.isFinite(value) ? value : null;
}
