
/**
 * `/live` 차트 창의 **hogaplay 저장 데이터 칩** — 지금 디스크를 읽고 있다는 표시이자
 * 푸는 문(2026-08-22 사용자 결정: 해제는 칩의 ×).
 *
 * `SavedRangeChip` 과 시각 껍데기를 공유하지만 **별도 컴포넌트다.** 그쪽 도크스트링은
 * 자기를 "저장뷰 기간 칩" 으로 정의하고 「KRX 기준」 병기 규칙까지 그 의미에 묶어
 * 놓았다 — 두 번째 의미를 얹으면 둘 다 흐려진다. 여기엔 venue 고정이 **없다**(소스만
 * 바꿀 뿐 거래소 선택은 창의 것을 그대로 따른다).
 *
 * **날짜는 실제로 실려 온 캔들에서 뽑는다**(호출부). 켤 때의 구간을 박아 두면 좌측
 * 팬으로 넓어진 뒤 칩이 거짓말을 한다 — 이 모드의 정의가 "기간 이동을 따라간다" 라
 * 고정 표기와 원리적으로 양립하지 않는다. 아직 아무것도 안 왔으면 `null` 을 넘겨
 * 날짜 없이 「불러오는 중」 으로 뜬다(`undefined~undefined` 방지).
 */

/** `20260701` → `07-01` (연도 접음) / `26-07-01` (연도 2자리 유지). */
export function shortDate(yyyymmdd: string, withYear: boolean): string {
  const md = `${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
  return withYear ? `${yyyymmdd.slice(2, 4)}-${md}` : md;
}


/**
 * 칩 한 줄용 기간 표기. **해를 걸치면 연도를 접지 않는다** — 접으면
 * `2025-08-20~2026-07-09` 가 `08-20~07-09` 가 되어 끝이 시작보다 앞선 것처럼 읽힌다
 * (`SavedRangeChip` 이 실측으로 발견한 것과 같은 규칙·같은 이유).
 */
export function hogaplayPeriodLabel(fromDate: string, toDate: string): string {
  if (fromDate === toDate) return shortDate(fromDate, false);
  const crossesYear = fromDate.slice(0, 4) !== toDate.slice(0, 4);
  return `${shortDate(fromDate, crossesYear)}~${shortDate(toDate, crossesYear)}`;
}
