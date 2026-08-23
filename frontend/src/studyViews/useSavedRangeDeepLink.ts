import { useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getStudyView } from '../api/studyViews';
import { activateLiveCode } from '../live/liveNavigate';
import { useLivePageStore } from '../state/livePage';
import { savedRangeFocusFromView } from './savedRangeFocus';

/** `/live?view=<id>` 딥링크 한 건의 쿼리 키. 목록(`STUDY_VIEW_SAVES_QUERY`)과 **일부러
 *  다른 축**이다 — 딥링크는 행 하나만 필요하고, 목록을 끌어오면 드로어를 열지도 않은
 *  `/live` 로드마다 저장뷰 전량이 따라온다. */
export function savedViewDeepLinkQuery(viewId: string) {
  return ['study-view', viewId] as const;
}

/**
 * `/live?view=<저장뷰 id>` 딥링크 시드 — 저장뷰를 `/live` 에서 연다.
 *
 * 드로어 행 클릭(`StudyViewsDrawer.openSavedRangeInLive`)과 **같은 목적지**이고, 이쪽은
 * 그 경로의 URL 판이다: ctrl/⌘+클릭의 새 탭과 북마크·새로고침이 여기로 착지한다.
 *
 * ## 순서가 계약이다 (드로어와 동일 — 고칠 때 두 곳을 같이 본다)
 *
 *  1. `activateLiveCode` — 종목 교체. `activationTarget` 이 목적지를 골라 **포커스
 *     그룹만** 바뀌고 핀 걸린 창은 건드리지 않는다(ADR-0153).
 *  2. `focusSavedRange` — 기간 슬롯. **나중**이다. 1단계에는 "종목이 바뀌면 저장 구간
 *     해제" 트리거가 들어 있다(`liveNavigate.activateLiveInstrument`).
 *
 * ⚠ 지금 그 트리거는 **종목 코드로 갈린다**(`… !== page.savedRangeFocus.code`). 그래서
 * 이 딥링크에 한해서는 역순이어도 슬롯이 살아남는다 — 세우는 코드와 활성화하는 코드가
 * 같기 때문이다. 그래도 순서를 지키는 이유는 그 우연에 기대지 않기 위해서다: 트리거의
 * 조건이 한 번만 넓어져도(예: "아무 활성화나 해제") 이 훅은 **조용히** 아무 일도 하지
 * 않는 훅이 된다. 드로어와 같은 순서를 쓰면 그 변경이 두 곳을 같이 깨서 눈에 띈다.
 *
 * ## 시드는 viewId 당 1회다
 *
 * 사용자가 착지 후 팬·줌하거나 다른 종목을 눌러 슬롯을 풀었을 때, 쿼리가 리프레시됐다는
 * 이유로 화면을 저장 구간으로 **되돌리면 안 된다**. `/live` 의 `?code=` 시드가 1회인
 * 것과 같은 규칙이다(`LivePage` 의 `seeded` ref).
 *
 * ## 없는 저장뷰(404)는 조용히 통과한다
 *
 * 삭제된 저장뷰를 가리키는 옛 북마크가 유일한 발생 경로이고, 그때 옳은 화면은 **평소의
 * `/live`** 다 — 워크스페이스 복원이 그대로 서고 사용자는 하던 일을 한다. 토스트를
 * 띄우면 "내가 방금 지운 것" 을 다시 알리는 소음이 된다. `retry: false` 인 이유도
 * 같다: 없는 행은 **영구 조건**이라 재시도가 답을 바꾸지 않는다.
 */
export function useSavedRangeDeepLink(viewId: string | null): void {
  const { data } = useQuery({
    queryKey: savedViewDeepLinkQuery(viewId ?? ''),
    queryFn: () => getStudyView(viewId as string),
    enabled: !!viewId,
    retry: false,
  });
  const seededViewIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!viewId || !data || seededViewIdRef.current === viewId) return;
    seededViewIdRef.current = viewId;
    activateLiveCode(data.code, data.label);
    useLivePageStore.getState().focusSavedRange(savedRangeFocusFromView(data));
  }, [viewId, data]);
}
