// 라벨은 한국어다(2026-08-04). 우측 레일(RightRail)이 이미 한글이라 상단/우측 두
// 내비게이션이 언어가 갈렸고, 무엇보다 'Heatmap'(상단)과 '히트맵'(레일)이 **같은
// 목적지를 다른 이름으로** 부르고 있었다. Copy tone 규칙상 영어는 도메인 식별자
// (hogaplay·kis_live·EGW00201) 몫이고 라우트 라벨은 거기 해당하지 않는다.
//
// 이 값은 화면 라벨이자 **브라우저 탭 제목**이다 — `App.tsx` 의 STATIC_ROUTE_TITLES
// 가 여기서 파생하므로, 라벨을 고치면 document.title 도 함께 따라온다(별도 표 없음).
export const WORKSPACE_NAV_ITEMS = [
  { to: '/live', label: '라이브' },
  { to: '/study', label: '복기' },
  { to: '/heatmap', label: '히트맵' },
  { to: '/screener', label: '스크리너' },
  { to: '/sentiment', label: '옵션심리' },
  { to: '/inventory', label: '보관함' },
  { to: '/capture', label: '캡처' },
] as const;

export const SYSTEM_NAV_ITEMS = [
  { to: '/settings', label: '설정' },
] as const;
