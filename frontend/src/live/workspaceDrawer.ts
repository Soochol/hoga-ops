/** /live 워크스페이스 우측 드로어(ADR-0116) 공용 크롬 상수.
 *
 * 보조지표(IndicatorPanel)와 설정(LiveSettingsModal) 드로어는 "툴바에서
 * 보조지표↔설정을 오가도 패널 위치·폭이 흔들리지 않는다"는 동기화 계약을
 * 갖는다 — 폭·마스터-디테일 그리드를 이 상수로 강제해 copy-paste 드리프트를
 * 막는다(코드리뷰 PR #671 후속). Tailwind JIT는 문자열 리터럴을 스캔하므로
 * 클래스 전체 문자열을 그대로 둔다(동적 조립 금지).
 */

/** ModalShell(side='right')에 넘기는 드로어 폭. 넓은 화면에서 좌측 ~520px
 *  차트가 딤 너머로 남아 즉시 적용을 실시간 확인할 수 있는 값. */
export const WORKSPACE_DRAWER_WIDTH_CLASS = 'w-[min(760px,100vw)]';

/** 드로어 내부 마스터-디테일 셸: 좌측 nav 240px + 우측 디테일. 두 드로어가
 *  동일한 nav 폭을 써야 전환 시 nav가 점프하지 않는다. */
export const WORKSPACE_DRAWER_SHELL_CLASS =
  'grid h-full min-h-0 grid-cols-[240px_minmax(0,1fr)] overflow-hidden rounded-[6px] bg-bg-card';
