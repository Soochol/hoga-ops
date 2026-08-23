/**
 * 저장뷰 딥링크 — 경로 조립과 "새 브라우저 탭으로 열기" 한 쌍.
 *
 * `live/liveNavigate.ts` 의 `liveDeepLinkPath`/`openLiveInNewTab` 과 같은 자리의
 * 저장뷰 짝이고, **같은 페이지(`/live`)로 간다**.
 *
 * ## 목적지가 `/study` 에서 `/live` 로 바뀌었다 (2026-08-23)
 *
 * 2026-08-21 결정으로 드로어 행 클릭·Enter·행 메뉴 「열기」가 이미 `/live` 로 갔고
 * (`StudyViewsDrawer.openSavedRangeInLive`), 그때 ctrl/⌘+클릭만 `/study` 새 탭으로
 * 남아 **같은 행의 두 제스처가 다른 페이지로 갈라져 있었다**. 이제 하나다.
 *
 * 착지 쪽 배선은 `useSavedRangeDeepLink` 가 갖는다 — 종목 활성화와 기간 슬롯을
 * **그 순서로** 세우는 계약이 거기 적혀 있다.
 *
 * 이름을 `studyViewDeepLinkPath` 에서 `savedViewDeepLinkPath` 로 바꾼 이유가 그것이다 —
 * 이 함수가 가리키는 곳은 이제 페이지가 아니라 **저장뷰라는 도메인**이다.
 *
 * ⚠ **디렉터리 이름(`studyViews/`)은 일부러 그대로 뒀다.** 삭제된 것은 페이지
 * (`StudyPage`)이지 도메인이 아니고, 그 도메인의 이름은 백엔드에서도 `study_views.py` ·
 * `/api/study-views/saves` 다(CONTEXT.md 의 「저장 학습뷰」). 프론트만 `savedViews/` 로
 * 바꾸면 ADR-0004 가 계약 표면으로 삼는 **BE↔FE 손 미러**가 이름에서부터 갈린다.
 * 바꾸려면 백엔드 모듈·REST 경로까지 한 번에 — 그건 이 삭제와 별개 작업이다.
 *
 * ## ADR-0149 와 충돌하지 않는다 — 두 「탭」을 구별할 것
 *
 * ADR-0149 §5 가 없앤 것은 **앱 안의 저장뷰 탭바**(`StudyTabBar`)와 그 disposition
 * (`openSaveInNewTab`)이다. 그 결정은 그대로다 — 이 모듈은 탭 스토어도 disposition
 * 개념도 되살리지 않는다. 여기서 여는 것은 **브라우저 탭**이고, 그 탭이 타는 경로는
 * 같은 ADR 의 §7 이 저장뷰 전환의 정식 경로로 못박은 **`?view=` 딥링크**다.
 * 새로 생기는 영속 상태는 0이다.
 *
 * ## 새 탭이 이 탭을 덮지 않는가
 *
 * 근거가 `/study` 시절보다 **단순해졌다**. 저장 구간 슬롯(`livePage.savedRangeFocus`)은
 * **비영속**이라(`state/livePage.ts:199-201`, `persistedPayload` 가 저장을 5필드로
 * 좁힌다) 새 탭이 무엇을 열든 이 탭의 슬롯에 닿을 경로가 아예 없다. 창 배치
 * (`live.workspace.v1`)는 딥링크로 열린 탭이 sessionStorage 로 격리한다(`workspace.ts`)
 * — `openLiveInNewTab` 이 이미 기대는 성질과 같은 것이다.
 *
 * **실측 시 헷갈리는 지점**(2026-08-20, Chrome trusted ctrl+클릭): localStorage 는
 * 오리진 공유라 새 탭이 쓴 **공유 시드**를 원래 탭에서 읽어도 보인다 — 그것은 런타임이
 * 옮겨간 증거가 **아니다**. 원래 탭이 안 움직였는지는 라우트와 드로어의 `aria-current`
 * 로 재야 한다(실측: 새 탭 열림·`window.opener === null`·원래 탭 유지·하이라이트 0건).
 */

/** 저장뷰 딥링크 경로. `LivePage` 가 마운트 시 `?view=` 를 읽어 그 저장뷰의 종목을
 *  활성 그룹에 시드하고 저장 구간 슬롯을 채운다(`useSavedRangeDeepLink`). 시드는
 *  viewId 당 1회이고, 없는 id(삭제된 북마크)는 조용히 평소의 `/live` 가 된다. */
export function savedViewDeepLinkPath(viewId: string): string {
  return `/live?view=${encodeURIComponent(viewId)}`;
}

/** 저장뷰를 새 브라우저 탭으로 연다(ctrl/⌘+클릭).
 *
 *  `noopener` 는 새 탭이 `window.opener` 로 이 창을 조작하지 못하게 하는 표준 방어
 *  (`openLiveInNewTab` 과 동일). 이 탭의 종목·기간 슬롯은 건드리지 않는다 — 호출부가
 *  `activateLiveCode`·`focusSavedRange` 를 부르지 않는 것이 그 계약의 전부다. */
export function openSavedViewInNewTab(viewId: string): void {
  window.open(savedViewDeepLinkPath(viewId), '_blank', 'noopener');
}
