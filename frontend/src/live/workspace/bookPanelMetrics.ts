/**
 * 10호가 창의 폭 계약. 창 기본 크기와 기본 배치도 이 값을 소비한다.
 * Tailwind 동적 클래스 대신 BookPanel의 CSS 변수로 전달한다.
 *
 * 일반 모드 최소 배분: 좌(잔량·체결) 132 / 중앙 163 / 우(요약·잔량) 184px.
 * 중앙은 7자리 가격 + 7ch 등락률 + 시·고·저 칩의 상시 여백 24px를 담는다.
 * 2026-10-06 중앙 139→163, 패널 하한 455→479: absolute 칩도 폭 예산에
 * 포함해 잔량 열 침범을 막는다. 칩 없는 행에도 같은 여백을 둬 가격 정렬을 유지한다.
 *
 * 축소 모드는 요약을 접고 잔량 열을 각각 76px까지 줄인다. 중앙 폭은 그대로이므로
 * 최소 315px가 필요하며, 그보다 좁으면 BookScrollArea가 가로 스크롤을 제공한다.
 */
export const BOOK_PANEL_PRICE_COL_W = 163;
export const BOOK_PANEL_MIN_W = 132 + BOOK_PANEL_PRICE_COL_W + 184;

/** 남는 폭은 잔량 열에 배분한다. 요약은 개행 없이 11호가 높이를 유지해야 한다. */
export const BOOK_PANEL_GRID_COLS = `1fr ${BOOK_PANEL_PRICE_COL_W}px minmax(184px,1fr)`;

/** 세로 스크롤바와 서브픽셀 여유를 포함한 창 크기. */
export const BOOK_WINDOW_CHROME_W = 32;
export const BOOK_WINDOW_DEFAULT_W = BOOK_PANEL_MIN_W + BOOK_WINDOW_CHROME_W;
