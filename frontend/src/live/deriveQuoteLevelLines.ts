import type { RangeBundle, QuoteRatioPoint } from '../api/types';
import { isSyntheticHogaGapPoint } from '../chart/util/hogaGapHide';
import { isExcludedQuoteBucket } from '../chart/util/auctionHide';
import { quoteRatioPointsForBundle } from '../chart/projectors/quoteRatioPoints';
import { quoteImbalance } from '../util/imbalance';

/** 총잔량 현재값 수평선 모델 — 매수·매도 각각 마지막 유효 버킷의 잔량. */
export type QuoteTotalsLevels = { bid: number; ask: number } | null;

/**
 * quote_ratio 포인트 배열 끝에서 **라인이 실제로 그리는** 마지막 버킷을 찾는다.
 * 두 종류를 건너뛴다:
 *  - hoga-gap sentinel(`isSyntheticHogaGapPoint`) — 값이 없는 자리표시자.
 *  - 붕괴 버킷(`isExcludedQuoteBucket`) — 마감 동시호가·장중 VI 의 `(0,0)`
 *    구조 센티넬(ADR-0062 v2). 프로젝터가 이걸 투명으로 가리므로, 안 거르면
 *    수평선만 pane 바닥(0)에 깔려 라인 끝점과 어긋난다.
 *
 * `auctionWindowMask` 를 그대로 관통시키는 것이 요점이다 — 이 토글은 라인과
 * 수평선의 표시를 **함께** 지배한다. 무조건 걸러 버리면 마스크를 끈 사용자에게
 * 라인은 0 에 있는데 수평선만 그 위에 뜨는 반대 방향의 비정렬이 생긴다.
 *
 * 뒤에서부터 스캔하므로 최신 버킷을 O(꼬리 배제 버킷 개수) 안에 찾는다.
 * quote_ratio 는 시간순 append.
 */
function lastDisplayedPoint(
  points: readonly QuoteRatioPoint[],
  auctionWindowMask: boolean,
): QuoteRatioPoint | null {
  for (let i = points.length - 1; i >= 0; i--) {
    const p = points[i];
    if (isSyntheticHogaGapPoint(p)) continue;
    if (isExcludedQuoteBucket(auctionWindowMask, p.bid_total, p.ask_total)) continue;
    return p;
  }
  return null;
}

/**
 * 총잔량 pane 현재값 수평선의 매수·매도 값을 산출한다. 총잔량 라인(quoteTotals.ts
 * projectBid/Ask)과 동일한 소스·intraMax **·배제 규칙**을 써 라인 끝점과 수평선이
 * 정렬된다.
 * intraMax = 분봉 내 최댓값(bid_max/ask_max), 아니면 종가 시점 총잔량(bid_total/ask_total).
 * 유효 버킷이 없으면 null → 수평선 숨김.
 */
export function deriveQuoteTotalsLevels(
  bundle: RangeBundle,
  intraMax: boolean,
  auctionWindowMask: boolean,
): QuoteTotalsLevels {
  const p = lastDisplayedPoint(quoteRatioPointsForBundle(bundle), auctionWindowMask);
  if (!p) return null;
  const bid = intraMax ? p.bid_max : p.bid_total;
  const ask = intraMax ? p.ask_max : p.ask_total;
  if (!Number.isFinite(bid) || !Number.isFinite(ask)) return null;
  return { bid, ask };
}

/**
 * 호가비 pane 현재값 수평선의 값을 산출한다. ratio.ts projectRatioPoints 와 동일하게
 * quoteImbalance 로 계산하고 **같은 배제 규칙**을 쓴다 — 라인 끝점과 정렬된다
 * (`ratio.ts` 도 `isAuctionHidden || isExcludedQuoteBucket` 으로 가린다).
 * intraMax = 분봉 내 |불균형| 극값
 * (imb_max_bid/imb_max_ask), 아니면 종가 시점(bid_total/ask_total).
 * 유효 버킷이 없으면 null → 수평선 숨김.
 */
export function deriveRatioLevel(
  bundle: RangeBundle,
  intraMax: boolean,
  auctionWindowMask: boolean,
): number | null {
  const p = lastDisplayedPoint(quoteRatioPointsForBundle(bundle), auctionWindowMask);
  if (!p) return null;
  const value = intraMax
    ? quoteImbalance(p.imb_max_bid, p.imb_max_ask)
    : quoteImbalance(p.bid_total, p.ask_total);
  return Number.isFinite(value) ? value : null;
}
