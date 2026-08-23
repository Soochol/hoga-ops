/**
 * 극값 라벨 문자열 — `"<가격>원 (<±극값 대비율>%)"`.
 *
 * **시각(`MM.DD HH:MM`)은 의도적으로 없다**(2026-08-23 사용자 결정). 이 칩은 캔들 pane
 * 가장자리에 불투명 배경으로 놓이므로 폭이 곧 캔들을 덮는 면적이다 — 시각까지 넣은
 * 옛 포맷은 실측 165px 로, 줌아웃 상태(실측 barSpacing 1.6px)에서 라벨 하나가 약
 * 100봉을 덮었다. 시각을 빼면 ~95px 로 줄어 배치가 성립할 여지가 넓어진다. 극값이
 * *언제* 발생했는지는 dot 의 x 위치와 시간축이 이미 말해 준다.
 *
 * 부호는 음수면 toFixed 의 `-`, 0·양수면 `+`.
 */
export function formatExtremeLabel(price: number, pct: number): string {
  const priceStr = Math.round(price).toLocaleString('ko-KR');
  const pctStr = `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}`;
  return `${priceStr}원 (${pctStr}%)`;
}
