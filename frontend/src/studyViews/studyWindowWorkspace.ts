/**
 * `/study` 창-스코프 어댑터 (#907 계약의 `/study` 구현, 지도 #900).
 *
 * `windowView` 의 창-스코프 훅들은 이 객체를 통해서만 워크스페이스에 닿는다.
 * `store` 는 zustand 훅 **그대로** 여야 selector 구독이 산다 — 자세한 근거는
 * `windowViewContext.ts` 의 `WindowStoreHandle` 주석.
 */
import { studyViewOfWindow, useStudyWorkspaceStore } from '../state/studyWorkspace';
import type { WindowWorkspaceAdapter } from '../live/workspace/windowView';

/**
 * 창의 종목 코드 — **창 → 링크 그룹 → 저장뷰 → code** 세 홉이다(ADR-0155).
 *
 * 여기 있던 것은 "활성 저장뷰 하나"(ADR-0149)였고, 그 시절 주석은 이렇게 적혀 있었다:
 * *"창 id 는 쓰지 않는다 — 차트 창이 여러 개여도 전부 활성 저장뷰에 묶여 있어 종목이
 * 하나이기 때문이다. 창별 저장뷰를 허용하는 날 '이 창은 어느 뷰인가' 가 생기고, 그때
 * 창별로 갈라진다."* **오늘이 그 날이다** — 갈라진 지점이 정확히 이 함수다.
 *
 * 호출 시점 `getState()` 로 읽는다. 렌더 클로저(예: `ctx.save?.code`)를 가두면
 * `useWindowViewGuard` 의 존재 이유인 fresh 읽기가 깨진다 — 디바운스/타이머
 * 콜백이 "이 차트의 종목이 아직 그대로인가"를 물을 때 한 틱 전 값을 보게 된다.
 *
 * 스토어가 `groupViews` 를 **영속**하는 이유가 여기다: 새로고침 직후 저장뷰 목록
 * 쿼리가 뜨기 전에도 답할 수 있어야 한다.
 *
 * 반환은 **workarea 공간**이다(어댑터 계약). `/study` 저장뷰는 6자리 종목 코드뿐이라
 * 지금은 맨 코드가 곧 workarea 코드다 — 지수 저장뷰가 생기는 날 여기가 갈리고,
 * `liveInstrument.ts` 의 `indexWorkareaCode` 를 태워야 한다.
 */
function studyWindowWorkareaCode(windowId: string): string | null {
  return studyViewOfWindow(useStudyWorkspaceStore.getState(), windowId)?.code ?? null;
}

export const STUDY_WINDOW_WORKSPACE: WindowWorkspaceAdapter = {
  store: useStudyWorkspaceStore,
  getWorkareaCode: studyWindowWorkareaCode,
  scopePrefix: 'study',
};
