/**
 * `/study` 창-스코프 어댑터 (#907 계약의 `/study` 구현, 지도 #900).
 *
 * `windowView` 의 창-스코프 훅들은 이 객체를 통해서만 워크스페이스에 닿는다.
 * `store` 는 zustand 훅 **그대로** 여야 selector 구독이 산다 — 자세한 근거는
 * `windowViewContext.ts` 의 `WindowStoreHandle` 주석.
 */
import { useStudyWorkspaceStore } from '../state/studyWorkspace';
import { useStudyTabsStore } from '../state/studyTabs';
import type { WindowWorkspaceAdapter } from '../live/workspace/windowView';

/**
 * 창의 종목 코드 — `/study` 에는 링크 그룹이 없어 **활성 탭**이 소스다.
 *
 * 호출 시점 `getState()` 로 읽는다. 렌더 클로저(예: `ctx.save?.code`)를 가두면
 * `useWindowViewGuard` 의 존재 이유인 fresh 읽기가 깨진다 — 디바운스/타이머
 * 콜백이 "이 차트의 종목이 아직 활성인가"를 물을 때 한 틱 전 값을 보게 된다.
 *
 * 창 id 는 쓰지 않는다: v1 은 차트 창 1개 고정이고(ADR-0123) 종목은 탭이 정한다.
 * #801 이 창을 늘리는 날 "이 창은 어느 뷰인가"가 생기면 그때 창별로 갈라진다.
 */
function studyWindowCode(): string | null {
  const s = useStudyTabsStore.getState();
  return s.tabs.find((t) => t.id === s.activeTabId)?.code ?? null;
}

export const STUDY_WINDOW_WORKSPACE: WindowWorkspaceAdapter = {
  store: useStudyWorkspaceStore,
  getCode: studyWindowCode,
};
