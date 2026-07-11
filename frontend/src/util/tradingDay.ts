/** KST(UTC+9) 자정 기준 **거래일 번호**. epoch ms가 속한 거래일을 정수로 반환한다
 *  (같은 KST 날짜 = 같은 번호; 다음 KST 자정에 +1). /live의 당일 누적 지표들이 거래일
 *  경계에서 상태를 리셋할 때 쓰는 단일 기준 — **총잔량 급증**(detectSurges)·**당일 매도
 *  최대벽**(computeDayAskPeak) 래칫이 공유한다. 경계 규칙을 한 곳에 가둬 두 래칫이 서로
 *  어긋나지 않게 한다(이전엔 양쪽에 글자 그대로 복제돼 있었다). */
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

export function tradingDayOf(ms: number): number {
  return Math.floor((ms + KST_OFFSET_MS) / 86_400_000);
}

/** epoch ms의 KST 자정 기준 분(0–1439). 거래일 경계와 무관한 순수 함수라 과거/당일 청크별로
 *  따로 적용해도 불변식이 유지된다(Split Cache seam 안전 — quoteTotals 프로젝터와 동일 정의). */
export function kstMinuteOfDay(ms: number): number {
  return Math.floor((ms + KST_OFFSET_MS) / 60_000) % 1440;
}

/** KRX 정규장 개장(09:00) 분. */
export const KRX_OPEN_MIN = 9 * 60;

/** KRX 정규장 개장(09:00) 이후인가(KST). 공용 술어 isIndicatorEligibleBook의 개장 하한 —
 *  백엔드 _book_indicator_eligible_sql의 session_open 하한과 동일 목적으로 개장 동시호가를
 *  배제한다(호가비·총잔량·히트맵·매도/매수 최대벽 공용). 개장 동시호가는 hogaplay 실측상
 *  3호가로 붕괴해 isContinuousBook이 이미 배제하지만(2026-07-11), 이 하한은 라이브 KIS WS가
 *  개장 전 10레벨 호가를 밀어줄 가능성(미실측)에 대한 구조적 안전망이다. 마감측은
 *  isContinuousBook(3레벨 붕괴)+마감 상한(sessionClose/lastContinuousMs)이 맡는다. */
export function isAfterRegularOpen(ms: number): boolean {
  return kstMinuteOfDay(ms) >= KRX_OPEN_MIN;
}
