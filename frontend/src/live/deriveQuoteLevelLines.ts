import type { RangeBundle, QuoteRatioPoint } from '../api/types';
import { isSyntheticHogaGapPoint } from '../chart/util/hogaGapHide';
import { quoteRatioPointsForBundle } from '../chart/projectors/quoteRatioPoints';
import { quoteImbalance } from '../util/imbalance';
import { tradingDayOf } from '../util/tradingDay';

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
 * 총잔량 pane 「당일 최고 수평선」의 매수·매도 값을 산출한다 — 오늘 총잔량이 가장 높았던
 * 높이에 기준선을 그어 지금 잔량이 오늘 고점 대비 어디쯤인지 보이게 한다.
 *
 * 규칙 셋이 이 함수의 계약이고, 각각 특정 실패를 막는다:
 *
 *  1. **값 규칙은 그려진 라인의 규칙과 같다** — `intraMax ? *_max : *_total`(현재값 수평선·
 *     quoteTotals 프로젝터와 동일 pref). 다른 규칙을 쓰면 기준선이 라인 자신의 가시 최고점
 *     **위로 떠오른다**(라인은 분봉 종가인데 기준선은 분봉 내 최댓값). 이는 detectSurgeSide 가
 *     running peak 를 항상 `*_total` 로 굴리는 것과 의도적으로 다르다 — 저쪽은 발사 판정이고
 *     여기는 라인과의 시각적 정렬이 목적이다(그 비대칭은 마커 좌표에 이미 존재한다).
 *  2. **마감 동시호가는 `auctionWindowMask` 와 무관하게 항상 제외** — 넣으면 15:20 이후 잔량
 *     폭증이 매일 최댓값을 먹어 기준선이 영구히 천장에 붙는다. 그렇다고 표시용 토글을 따르면
 *     **표시 스위치가 계산된 기준값을 조용히 바꾼다**. 항상 제외해야 이 선과 급증 마커의
 *     running peak(같은 배제 규칙)가 한 이야기를 한다. 술어를 인자로 받는 이유는 세션 마감이
 *     venue 별로 다르기 때문 — 15:20–15:30 을 여기 박지 말 것.
 *  3. **"오늘"은 엄격히 KST 오늘** — 마지막 점의 거래일이 `nowMs` 의 거래일과 다르면 null(선
 *     숨김). 프리마켓·주말·공휴일엔 기준선이 뜨지 않는다. `nowMs` 를 인자로 받아 이 함수는
 *     시계에 의존하지 않는다(테스트가 값을 직접 넘긴다).
 *
 * 스캔은 배열 끝에서 시작해 거래일이 바뀌면 중단 → O(오늘 점 수) ≈ 390. 매 렌더 계산해도 싸다
 * (sibling 과 같이 memo 없음). 매수·매도는 서로 다른 시각에 최고를 찍을 수 있어 독립 누적한다.
 *
 * 0 초기화 + 최종 `> 0` 검사가 VI/gap 센티넬 `(0,0)` 을 걸러낸다 — 없으면 오늘 점이 전부
 * 센티넬일 때 pane 바닥에 붙은 선을 그린다(선례: computeDayAskPeak 의 `lv.qty > 0` 가드).
 */
export function deriveQuoteTotalsDayMax(
  bundle: RangeBundle,
  intraMax: boolean,
  inClosingAuction: (t: number) => boolean,
  nowMs: number,
): QuoteTotalsLevels {
  const points = quoteRatioPointsForBundle(bundle);
  if (points.length === 0) return null;
  const today = tradingDayOf(nowMs);
  if (tradingDayOf(points[points.length - 1].t) !== today) return null;
  let bid = 0;
  let ask = 0;
  for (let i = points.length - 1; i >= 0; i--) {
    const p = points[i];
    if (tradingDayOf(p.t) !== today) break; // 어제 이전 — 오늘 최고만 본다
    if (isSyntheticHogaGapPoint(p) || inClosingAuction(p.t)) continue;
    const b = intraMax ? p.bid_max : p.bid_total;
    const a = intraMax ? p.ask_max : p.ask_total;
    if (Number.isFinite(b) && b > bid) bid = b;
    if (Number.isFinite(a) && a > ask) ask = a;
  }
  return bid > 0 && ask > 0 ? { bid, ask } : null;
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
