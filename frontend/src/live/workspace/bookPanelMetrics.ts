/**
 * 10호가 창의 폭 계약. 창 기본 크기와 기본 배치도 이 값을 소비한다.
 * Tailwind 동적 클래스 대신 BookPanel의 CSS 변수로 전달한다.
 *
 * 좌·우 잔량 열은 일반 184px / 압축 112px를 하한으로 대칭 배분한다.
 * 중앙은 useBookPriceLayout의 자릿수·글꼴 예산을 따르고, 시고저·가격 사이를
 * 4px로 유지한다. 기본 중앙 하한은 114px이며 긴 가격에서는 확장한다.
 *
 * 531px 미만에서는 요약을 정보 팝오버로 옮기고 좌·우 112px로 압축한다.
 * 압축 배치도 가격을 줄이지 않고 필요한 최소 폭 아래에서는 가로 스크롤한다.
 */
export const BOOK_PANEL_PRICE_COL_W = 114;
export const BOOK_PANEL_MIN_W = 184 * 2 + BOOK_PANEL_PRICE_COL_W;
export const BOOK_PANEL_COMPACT_MIN_W = 112 * 2 + BOOK_PANEL_PRICE_COL_W;

/** 남는 폭은 잔량 열에 배분한다. 요약은 개행 없이 실제 매도 호가 높이를 유지해야 한다. */
export const BOOK_PANEL_GRID_COLS = 'minmax(184px,1fr) var(--book-price-width) minmax(184px,1fr)';
export const BOOK_PANEL_COMPACT_GRID_COLS = 'minmax(112px,1fr) var(--book-price-width) minmax(112px,1fr)';

/** 세로 스크롤바와 서브픽셀 여유를 포함한 창 크기. */
export const BOOK_WINDOW_CHROME_W = 32;
export const BOOK_WINDOW_DEFAULT_W = Math.round((479 + BOOK_WINDOW_CHROME_W) * 0.8);
