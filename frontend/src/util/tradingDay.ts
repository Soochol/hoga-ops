/** KST(UTC+9) 자정 기준 **거래일 번호**. epoch ms가 속한 거래일을 정수로 반환한다
 *  (같은 KST 날짜 = 같은 번호; 다음 KST 자정에 +1). /live의 당일 누적 지표들이 거래일
 *  경계에서 상태를 리셋할 때 쓰는 단일 기준 — **총잔량 급증**(detectSurges)·**당일 매도
 *  최대벽**(computeDayAskPeak) 래칫이 공유한다. 경계 규칙을 한 곳에 가둬 두 래칫이 서로
 *  어긋나지 않게 한다(이전엔 양쪽에 글자 그대로 복제돼 있었다). */
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

export function tradingDayOf(ms: number): number {
  return Math.floor((ms + KST_OFFSET_MS) / 86_400_000);
}
