import type { RailPanel } from '../state/rightRail';

// 라벨은 한국어다(2026-08-04). 우측 레일(RightRail)이 이미 한글이라 상단/우측 두
// 내비게이션이 언어가 갈렸고, 무엇보다 'Heatmap'(상단)과 '히트맵'(레일)이 **같은
// 목적지를 다른 이름으로** 부르고 있었다. Copy tone 규칙상 영어는 도메인 식별자
// (hogaplay·키움 WS·EGW00201) 몫이고 라우트 라벨은 거기 해당하지 않는다.
//
// 이 값은 화면 라벨이자 **브라우저 탭 제목**이다 — `App.tsx` 의 STATIC_ROUTE_TITLES
// 가 여기서 파생하므로, 라벨을 고치면 document.title 도 함께 따라온다(별도 표 없음).
//
// 예외는 **페이지가 제목을 소유하는 라우트**다: `/live`(종목명 + 시세). 표에서 빠질 뿐
// 라벨이 무관해지진 않는다 — 아래 `WorkspaceNavLabel` 이 폴백을 타입으로 묶는 장치다.
//
// `panel` 은 그 nav 를 눌렀을 때 **함께 열리는 우측 패널**이다(선택). 라이브는
// 관심종목 — 그 페이지에서 곧바로 종목을 고르게 되는 패널이라 nav 한 번에 화면이
// 완성된다. 값이 없는 항목은 열려 있던 패널을 그대로 둔다(닫지도 열지도 않는다).
// 배선은 `TopNav.tsx`, 열기 규칙은 거기 주석 참조. **저장뷰 패널에는 nav 짝이 없다** —
// `/study` 가 사라진 뒤로 우측 레일에서 직접 연다.
//
// `as const satisfies` 는 둘 다 필요하다: `as const` 만이면 패널 이름 오타가 그냥
// 리터럴 타입이 돼 통과하고, `satisfies` 만이면 to·label 이 string 으로 넓어져
// STATIC_ROUTE_TITLES 의 키 리터럴이 사라진다.
export const WORKSPACE_NAV_ITEMS = [
  { to: '/live', label: '라이브', panel: 'watchlist' },
  { to: '/heatmap', label: '히트맵' },
  { to: '/market', label: '시장 종합' },
  { to: '/screener', label: '스크리너' },
  { to: '/sentiment', label: '옵션심리' },
  { to: '/inventory', label: '보관함' },
  { to: '/capture', label: '캡처' },
] as const satisfies readonly { to: string; label: string; panel?: RailPanel }[];

/**
 * `to` 하나의 nav 라벨을 **리터럴 타입으로** 뽑는다.
 *
 * 표에서 빠진 라우트(위 주석의 `/live`)가 라벨을 폴백으로 다시 쓸 때, 값을 손으로
 * 복사하지 않고 타입으로 묶기 위한 것이다. 라벨이 바뀌면 그 복사본이 타입 에러로
 * 드러난다.
 *
 * ⚠ 이 결속은 **라우트 삭제도 원자적으로 만든다**(2026-08-23 실측): `/study` 항목을
 * 지우자 `WorkspaceNavLabel<'/study'>` 를 쓰던 소비자가 TS2322·TS2344 로 함께 깨졌다.
 * 의도대로 작동한 것이다 — 라벨과 그 복사본은 같이 바뀌고, 삭제도 그 「같이」에 든다.
 */
export type WorkspaceNavLabel<To extends (typeof WORKSPACE_NAV_ITEMS)[number]['to']> =
  Extract<(typeof WORKSPACE_NAV_ITEMS)[number], { to: To }>['label'];

// 여기 있던 `SYSTEM_NAV_ITEMS`(`/settings` 한 항목)는 그 라우트와 함께 사라졌다 —
// 설정은 이제 페이지가 아니라 앱 전역 드로어이고, TopNav 가 버튼을 직접 렌더한다.
