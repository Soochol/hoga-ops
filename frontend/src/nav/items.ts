import type { RailPanel } from '../state/rightRail';

// 라벨은 한국어다(2026-08-04). 우측 레일(RightRail)이 이미 한글이라 상단/우측 두
// 내비게이션이 언어가 갈렸고, 무엇보다 'Heatmap'(상단)과 '히트맵'(레일)이 **같은
// 목적지를 다른 이름으로** 부르고 있었다. Copy tone 규칙상 영어는 도메인 식별자
// (hogaplay·키움 WS·EGW00201) 몫이고 라우트 라벨은 거기 해당하지 않는다.
//
// 이 값은 화면 라벨이자 **브라우저 탭 제목**이다 — `App.tsx` 의 STATIC_ROUTE_TITLES
// 가 여기서 파생하므로, 라벨을 고치면 document.title 도 함께 따라온다(별도 표 없음).
//
// `panel` 은 그 nav 를 눌렀을 때 **함께 열리는 우측 패널**이다(선택). 라이브는
// 관심종목, 복기는 저장뷰 — 그 페이지에서 곧바로 종목을 고르게 되는 패널이라 nav
// 한 번에 화면이 완성된다. 값이 없는 항목은 열려 있던 패널을 그대로 둔다(닫지도
// 열지도 않는다). 배선은 `TopNav.tsx`, 열기 규칙은 거기 주석 참조.
//
// `as const satisfies` 는 둘 다 필요하다: `as const` 만이면 패널 이름 오타가 그냥
// 리터럴 타입이 돼 통과하고, `satisfies` 만이면 to·label 이 string 으로 넓어져
// STATIC_ROUTE_TITLES 의 키 리터럴이 사라진다.
export const WORKSPACE_NAV_ITEMS = [
  { to: '/live', label: '라이브', panel: 'watchlist' },
  { to: '/study', label: '복기', panel: 'savedViews' },
  { to: '/heatmap', label: '히트맵' },
  { to: '/market', label: '시장 종합' },
  { to: '/screener', label: '스크리너' },
  { to: '/sentiment', label: '옵션심리' },
  { to: '/inventory', label: '보관함' },
  { to: '/capture', label: '캡처' },
] as const satisfies readonly { to: string; label: string; panel?: RailPanel }[];

export const SYSTEM_NAV_ITEMS = [
  { to: '/settings', label: '설정' },
] as const;
