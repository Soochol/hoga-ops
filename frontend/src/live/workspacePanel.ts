/** 설정·보조지표 패널(중앙 모달) 공용 크롬 상수.
 *
 * 보조지표(IndicatorPanel)와 설정(SettingsSections) 패널은 "툴바에서
 * 보조지표↔설정을 오가도 패널 위치·폭이 흔들리지 않는다"는 동기화 계약을
 * 갖는다 — 폭·높이·마스터-디테일 그리드를 이 상수로 강제해 copy-paste 드리프트를
 * 막는다(코드리뷰 PR #671 후속). Tailwind JIT는 문자열 리터럴을 스캔하므로
 * 클래스 전체 문자열을 그대로 둔다(동적 조립 금지).
 *
 * 설정 표면이 하나로 합쳐지면서 `App.tsx`(전 라우트 TopNav ⚙)도 같은 폭·셸을
 * 쓴다 — 이름의 「워크스페이스」는 이제 유래이지 적용 범위가 아니다.
 *
 * **2026-08-21: 우측 드로어 → 중앙 모달**(사용자 결정, DESIGN.md 결정 로그).
 * 파일명이 `workspaceDrawer.ts` 였던 것은 그 이력이다 — 이제 드로어가 아니므로
 * 이름을 같이 옮겼다.
 */

/** ModalShell(side='center')에 넘기는 카드 폭. 드로어 시절의 760px 을 그대로
 *  승계한다 — 마스터-디테일(240 nav + 520 디테일)이 이 폭에 맞춰 설계돼 있다. */
export const WORKSPACE_PANEL_WIDTH_CLASS = 'w-[min(760px,100vw)]';

/** 카드 높이. 중앙 모달은 드로어와 달리 높이를 **스스로 정해야** 내부 마스터-디테일
 *  그리드(`h-full`)와 두 스크롤 영역(nav·상세)이 클립할 바닥이 생긴다.
 *
 *  값의 근거(2026-08-21 실측): 보조지표 nav 16항목의 요구 높이가 **903px**,
 *  「현재 봉 초기화」 푸터가 50px 이라 nav 를 전부 보이려면 카드 ≈960px 이 필요하다.
 *  그래서 `min(960px, 86vh)` — 세로 ~1120px 이상 화면에서는 **스크롤이 사라지고**,
 *  그보다 작은 화면에서만 86vh 로 클램프된다. 고정 px 하나면 큰 화면의 여유를 못
 *  쓰고, vh 하나면 초대형 화면에서 카드가 쓸데없이 길어진다. */
export const WORKSPACE_PANEL_HEIGHT_CLASS = 'h-[min(960px,86vh)]';

/** 패널 내부 마스터-디테일 셸: 좌측 nav 240px + 우측 디테일. 두 패널이
 *  동일한 nav 폭을 써야 전환 시 nav가 점프하지 않는다. */
export const WORKSPACE_PANEL_SHELL_CLASS =
  'grid h-full min-h-0 grid-cols-[240px_minmax(0,1fr)] overflow-hidden rounded-lg bg-bg-card';
