/** KST(UTC+9) 자정 기준 **거래일 번호**. epoch ms가 속한 거래일을 정수로 반환한다
 *  (같은 KST 날짜 = 같은 번호; 다음 KST 자정에 +1). /live의 당일 누적 지표들이 거래일
 *  경계에서 상태를 리셋할 때 쓰는 단일 기준 — **총잔량 급증**(detectSurges)·**당일 매도
 *  최대벽** live prefix accumulator가 공유한다. 경계 규칙을 한 곳에 가둬 두 래칫이 서로
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

/** KRX 정규장 개장(09:00) 이후인가(KST). 개장 동시호가(<09:00)는 10레벨 누적 호가라
 *  isContinuousBook을 통과하므로 구조적 배제가 안 된다 — 당일 매도 최대벽 live path에서 이 게이트로
 *  배제한다(백엔드 query_day_ask_peak의 session_open 하한과 동일 목적, 총잔량 지표 동치). 마감측은
 *  isContinuousBook이 단일가 붕괴(3레벨)로 처리하고, 과거일 마감후 재확장(~15:30:14)은 백엔드
 *  session_close 상한이 맡으므로 라이브 래칫엔 불필요. */
export function isAfterRegularOpen(ms: number): boolean {
  return kstMinuteOfDay(ms) >= KRX_OPEN_MIN;
}
