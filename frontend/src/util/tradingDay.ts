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

// `isAfterRegularOpen`(09:00 KST 고정) / `KRX_OPEN_MIN` 은 여기 있었고 삭제됐다.
// 개장 하한은 이제 `isIndicatorEligibleBook(s, sessionOpenMs)` 의 **필수 인자**다 —
// 시각을 함수 안에 박아 두면 venue 별 확장 세션(NXT/통합 08:00–20:00)에서 프리마켓
// 호가가 통째로 배제된다. 되살리지 말 것: 상수로 부활하는 순간 호출부가 그걸 기본값
// 자리에 넣고 싶어지고, 그게 정확히 이 버그를 되돌리는 경로다.
