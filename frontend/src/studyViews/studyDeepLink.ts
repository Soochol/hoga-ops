/**
 * `/study` 저장뷰 딥링크 — 경로 조립과 "새 브라우저 탭으로 열기" 한 쌍.
 *
 * `live/liveNavigate.ts` 의 `liveDeepLinkPath`/`openLiveInNewTab` 의 `/study` 짝이다.
 *
 * ## ADR-0149 와 충돌하지 않는다 — 두 「탭」을 구별할 것
 *
 * ADR-0149 §5 가 없앤 것은 **앱 안의 저장뷰 탭바**(`StudyTabBar`)와 그 disposition
 * (`openSaveInNewTab`)이다. 그 결정은 그대로다 — 이 모듈은 탭 스토어도, 멀티 뷰 상태도,
 * disposition 개념도 되살리지 않는다. 여기서 여는 것은 **브라우저 탭**이고, 그 탭이 타는
 * 경로는 같은 ADR 의 §7 이 저장뷰 전환의 정식 경로로 못박은 **`?view=` 딥링크**다.
 * 새로 생기는 영속 상태는 0이다.
 *
 * ## 새 탭이 이 탭을 덮지 않는가
 *
 * - `study.activeView.v1` 은 크로스탭 동기화가 없다(`state/persistencePolicy.ts` 의
 *   기본 관례 — localStorage 는 **다음 로드의 시드**일 뿐). 새 탭이 다른 뷰를 열어도
 *   이 탭의 런타임 활성 뷰는 그대로고, 이 탭의 URL 도 자기 `?view=` 를 들고 있어
 *   새로고침 복원까지 안전하다. `/live` 딥링크가 `live.page.v1` 에 대해 받아들인 것과
 *   같은 의미론이다. **실측 시 헷갈리는 지점**(2026-08-20, Chrome trusted ctrl+클릭):
 *   localStorage 는 오리진 공유라 새 탭이 쓴 값을 원래 탭에서 읽어도 보인다 — 그것은
 *   런타임이 옮겨간 증거가 **아니다**. 원래 탭이 안 움직였는지는 라우트와 드로어의
 *   `aria-current` 로 재야 한다(실측: 새 탭 열림·`window.opener === null`·원래 탭
 *   `/live` 유지·하이라이트 0건).
 * - `study.workspace.v1`(창 배치)은 `tab-authoritative-shared-seed` 라 새 탭에서 창을
 *   옮기면 공유 시드가 갱신된다. 이는 사용자가 `/study` 를 손으로 두 번째 탭에 여는
 *   경우에 이미 성립하던 성질이고(그래서 `/live` 와 달리 딥링크 예외가 없다 —
 *   `state/studyWorkspace.ts` 의 `persistFromState` 주석), 이 진입점이 새로 만드는
 *   위험이 아니다.
 */

/** `/study` 딥링크 경로. StudyPage 가 마운트 시 `?view=` 를 읽어 그 저장뷰를 연다 —
 *  영속된 마지막 뷰보다 우선한다(`state/studyActiveView.ts` §URL 과의 우선순위). */
export function studyViewDeepLinkPath(viewId: string): string {
  return `/study?view=${encodeURIComponent(viewId)}`;
}

/** 저장뷰를 새 브라우저 탭으로 연다(ctrl/⌘+클릭).
 *
 *  `noopener` 는 새 탭이 `window.opener` 로 이 창을 조작하지 못하게 하는 표준 방어
 *  (`openLiveInNewTab` 과 동일). 이 창의 활성 저장뷰는 건드리지 않는다 — 호출부가
 *  `openSave`·`navigate` 를 부르지 않는 것이 그 계약의 전부다. */
export function openStudyViewInNewTab(viewId: string): void {
  window.open(studyViewDeepLinkPath(viewId), '_blank', 'noopener');
}
