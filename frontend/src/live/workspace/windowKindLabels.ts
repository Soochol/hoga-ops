/**
 * 창 종류의 표시 이름 SSOT.
 *
 * 창 제목(DataWindow 헤더·안내 카드)과 창 추가 메뉴(WindowAddMenu)가 같은 문자열을
 * 써야 "고른 것 = 생긴 것" 이 맞는다. 분리돼 있던 시절 툴바는 `+호가`·`+투자자`·
 * `+섹터랭킹` 이라 부르고 창 제목은 `10호가`·`잠정투자자`·`섹터 랭킹` 이라 불러
 * 이미 드리프트가 있었다 — 여기 한 곳만 고치면 양쪽이 함께 움직인다.
 */
import type { WindowKind } from '../../state/workspace';

export const WINDOW_KIND_LABEL: Record<WindowKind, string> = {
  chart: '차트',
  book: '10호가',
  broker: '거래원',
  trade: '체결',
  vdist: '매물대',
  program: '프로그램',
  investor: '잠정투자자',
  'sector-ranking': '섹터 랭킹',
};
