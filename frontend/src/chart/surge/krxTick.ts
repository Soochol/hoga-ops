/** KRX 주식 호가단위(원) — 가격대별 계단함수. 경계에서 틱이 2~5배 점프한다.
 *
 * **백엔드 `hoga/tables/snapshots.py` 의 `_KRX_TICK_BANDS` 와 같은 표여야 한다.**
 * 사본이 둘인 이유는 라이브 경로가 **오늘의** QuoteRatioPoint 를 클라이언트에서 만들기
 * 때문이다(과거는 백엔드가 `tick` 을 실어 온다). 한쪽을 고치면 반드시 다른 쪽도 —
 * 갈리면 봉이 오늘→과거로 넘어가는 순간 보정 기준이 바뀌는데, 값이 아니라 **비교
 * 기준**이 바뀌는 것이라 화면에 원인이 안 보인다.
 *
 * ⚠ **ETF/ETN 은 이 표를 따르지 않는다**(5원 고정). 그래서 소비자는 이 값만으로 환산하지
 * 않고 **사다리 폭이 실제로 움직였는지 확인**한 뒤 쓴다(detectSurgeSide 의 확인 게이트).
 *
 * 표는 기억이 아니라 **실측에서 역산**했다 — hogaplay 298종목의 인접 호가 간격이 이
 * 경계와 정확히 일치했다(docs/research/2026-08-19-hoga-tick-band-totals-normalization.md §2).
 */
const BANDS: readonly (readonly [number, number])[] = [
  [2_000, 1], [5_000, 5], [20_000, 10], [50_000, 50], [200_000, 100], [500_000, 500],
];
const TOP_TICK = 1_000;

/** 가격이 속한 호가단위(원). 0 이하면 0(모름). */
export function krxTick(price: number): number {
  if (!(price > 0)) return 0;
  for (const [bound, tick] of BANDS) if (price < bound) return tick;
  return TOP_TICK;
}
