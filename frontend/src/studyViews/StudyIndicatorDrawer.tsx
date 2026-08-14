/**
 * `/study` 보조지표 드로어 — `/live` `WorkspaceIndicatorDrawer` 의 `/study` 판.
 *
 * 왜 별도 컴포넌트인가: `/live` 쪽은 `useChartWindowView` 가 `/live` 워크스페이스
 * 스토어와 링크 그룹(`groupSymbols`)에서 뷰 값을 조립한다. `/study` 에는 그룹이
 * 없고 스토어도 다르므로, 조립부만 갈리고 그 아래(Provider + `IndicatorPanel`)는
 * 같다.
 *
 * `key={windowId}` 재마운트 규율을 그대로 승계한다 — 대상 창이 바뀔 때 드로어의
 * 로컬 상태(2단계 리셋 확인·HH:MM draft)가 창 경계를 넘지 않게 한다(#712 리뷰 #4).
 */
import { useMemo } from 'react';
import IndicatorPanel, { type CategoryId } from '../live/indicators/IndicatorPanel';
import { WindowViewContext, type WindowViewValue } from '../live/workspace/windowView';
import { STUDY_DEFAULT_MINUTE_TIMEFRAME } from '../state/studyLastMinuteTimeframe';
import { useStudyWorkspaceStore } from '../state/studyWorkspace';
import { STUDY_WINDOW_WORKSPACE } from './studyWindowWorkspace';

/**
 * `/study` 가 **그리지 않는** 지표 — 토글만 있고 아무것도 안 나오는 항목을 뺀다.
 *
 * `depth-delta`(단별 잔량 증감): `mergeStudyRangeBundles` 의 병합 목록에 `depth_delta`
 * 가 없어 sidecar 가 실어 와도 화면에 닿지 않는다. 즉 이 토글은 **원래 아무 일도 하지
 * 않았다** — 숨기는 것이 현상을 바꾸는 게 아니라 드러난 것을 정직하게 만든다.
 * 같은 이유로 `studyReferenceQueries` 가 그 지표를 **요청에서도 뺀다**(응답 -53%).
 *
 * `/study` 에서 이 지표를 지원하려면 셋을 함께 되돌려야 한다: 병합 목록 · 요청 플래그 ·
 * 이 배열. 하나만 켜면 "켰는데 안 보임" 이나 "안 쓰는데 받음" 중 하나가 된다.
 */
const STUDY_HIDDEN_INDICATORS: readonly CategoryId[] = ['depth-delta'];

export function StudyIndicatorDrawer({
  windowId,
  code,
  targetLabel,
  onClose,
}: {
  /** 헤더 버튼이 지정한 대상 창 — 추론하지 않는다(#759 와 같은 규율). */
  windowId: string;
  code: string | null;
  targetLabel: string | null;
  onClose: () => void;
}) {
  const chartConfig = useStudyWorkspaceStore(
    (s) => s.windows.find((w) => w.id === windowId)?.chart,
  );
  const timeframe = chartConfig?.timeframe ?? STUDY_DEFAULT_MINUTE_TIMEFRAME;
  const view: WindowViewValue = useMemo(
    () => ({
      windowId,
      group: null,
      code,
      timeframe,
      // 드로어는 페치를 돌리지 않는다 — 뷰 식별용이 아님(`/live` 와 같은 이유).
      historicalFromDate: null,
      workspace: STUDY_WINDOW_WORKSPACE,
    }),
    [windowId, code, timeframe],
  );

  if (!chartConfig) return null;

  return (
    <WindowViewContext.Provider value={view}>
      <IndicatorPanel
        key={windowId}
        onClose={onClose}
        timeframe={timeframe}
        targetLabel={targetLabel ?? undefined}
        hiddenCategories={STUDY_HIDDEN_INDICATORS}
      />
    </WindowViewContext.Provider>
  );
}
