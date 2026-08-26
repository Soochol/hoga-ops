// hex 색 → rgba 문자열. **canvas 전용 유틸**이다.
//
// 왜 공용인가: 같은 12줄이 `TradeVolumePocOverlay` 와 `TradeVolumePocConfig` 에 두 벌로
// 복사돼 있었고, 최대벽 강도 pane 의 「없음 구간」 색이 세 번째 복사본을 요구했다.
// canvas 는 `var(--…)` 를 못 받아 색이 hex 문자열로 흘러다니는데, 그 문자열에 알파를
// 씌우는 자리가 여러 곳이라 한 벌로 모은다.
//
// hex 가 아닌 입력(이미 rgba 이거나 CSS 함수 표기)은 **폴백을 낸다** — 조용히 원본을
// 돌려주면 알파가 안 먹은 것을 호출부가 알 수 없다.

/**
 * `#RRGGBB` 에 알파를 씌운 `rgba(...)` 를 만든다.
 *
 * @param fallback hex 파싱 실패 시 낼 값. 생략하면 불투명 회색(눈에 띄되 깨지지 않는 값).
 */
export function withAlpha(color: string, alpha: number, fallback?: string): string {
  const clamped = Math.max(0, Math.min(1, alpha));
  const match = /^#?([0-9a-f]{6})$/i.exec(color);
  if (!match) return fallback ?? `rgba(128, 128, 128, ${clamped})`;
  const raw = match[1];
  const r = Number.parseInt(raw.slice(0, 2), 16);
  const g = Number.parseInt(raw.slice(2, 4), 16);
  const b = Number.parseInt(raw.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${clamped})`;
}
