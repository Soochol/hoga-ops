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

/** 당일 최고 수평선 모델 — 매수·매도 최댓값 + 그 값이 속한 거래일의 앵커 시각(`t`).
 *  `t` 는 호출부가 라벨을 정하는 데 쓴다(오늘이면 「최고」, 아니면 「8/14 최고」). */
export type QuoteTotalsDayMax = { bid: number; ask: number; t: number } | null;

/**
 * 총잔량 pane 「당일 최고 수평선」의 매수·매도 값을 산출한다 — **데이터의 마지막 거래일**에
 * 총잔량이 가장 높았던 높이에 기준선을 그어, 지금 잔량이 그날 고점 대비 어디쯤인지 보이게 한다.
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
 *  3. **기준일은 데이터의 마지막 거래일** — 장중엔 그게 곧 오늘이라 "오늘 기준" 과 같고, 장
 *     마감 후·주말·공휴일엔 직전 거래일 기준선이 남으며, `/study`(복기)에선 보고 있는 그
 *     날이 된다. 한때 "엄격히 KST 오늘" 이었으나 그 규칙은 **복기에서 이 지표를 영영 죽였고**
 *     (거기엔 "오늘" 이 없다) 주말엔 선이 사라졌다. 낡은 기준선을 오늘 것으로 착각할 위험은
 *     선을 숨겨서가 아니라 **호출부가 `t` 로 날짜 라벨을 붙여** 막는다.
 *
 *     앵커는 `lastRealPoint` 다 — 배열 맨 끝이 gap 센티넬이어도 안전하다. 화면 팬과는 무관하다
 *     (보이는 구간이 아니라 데이터 배열이 기준이라, 과거로 팬해도 기준선은 그대로 있다).
 *
 * 스캔은 앵커에서 시작해 거래일이 바뀌면 중단 → O(그날 점 수) ≈ 390. 매 렌더 계산해도 싸다
 * (sibling 과 같이 memo 없음). 매수·매도는 서로 다른 시각에 최고를 찍을 수 있어 독립 누적한다.
 * `nowMs` 를 받지 않아 완전히 순수하다 — 시계는 라벨을 정하는 호출부에만 있다.
 *
 * 0 초기화 + 최종 `> 0` 검사가 VI/gap 센티넬 `(0,0)` 을 걸러낸다 — 없으면 그날 점이 전부
 * 센티넬일 때 pane 바닥에 붙은 선을 그린다(선례: computeDayAskPeak 의 `lv.qty > 0` 가드).
 */
export function deriveQuoteTotalsDayMax(
  bundle: RangeBundle,
  intraMax: boolean,
  inClosingAuction: (t: number) => boolean,
): QuoteTotalsDayMax {
  const points = quoteRatioPointsForBundle(bundle);
  const anchor = lastRealPoint(points);
  if (!anchor) return null;
  const day = tradingDayOf(anchor.t);
  let bid = 0;
  let ask = 0;
  for (let i = points.length - 1; i >= 0; i--) {
    const p = points[i];
    if (tradingDayOf(p.t) !== day) break; // 그 전날 이전 — 마지막 거래일 최고만 본다
    if (isSyntheticHogaGapPoint(p) || inClosingAuction(p.t)) continue;
    const b = intraMax ? p.bid_max : p.bid_total;
    const a = intraMax ? p.ask_max : p.ask_total;
    if (Number.isFinite(b) && b > bid) bid = b;
    if (Number.isFinite(a) && a > ask) ask = a;
  }
  return bid > 0 && ask > 0 ? { bid, ask, t: anchor.t } : null;
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
