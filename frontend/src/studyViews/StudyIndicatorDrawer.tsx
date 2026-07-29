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
import IndicatorPanel from '../live/indicators/IndicatorPanel';
import { WindowViewContext, type WindowViewValue } from '../live/workspace/windowView';
import {
  FACTORY_INDICATOR_SETTINGS,
  resolveIndicatorSettings,
} from '../state/indicatorSettingsV2';
import { STUDY_DEFAULT_MINUTE_TIMEFRAME } from '../state/studyLastMinuteTimeframe';
import { useStudyWorkspaceStore } from '../state/studyWorkspace';
import { STUDY_WINDOW_WORKSPACE } from './studyWindowWorkspace';

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
  const byTimeframe = chartConfig?.indicators.byTimeframe;
  const indicators = useMemo(
    () => (byTimeframe ? resolveIndicatorSettings(byTimeframe, timeframe) : FACTORY_INDICATOR_SETTINGS),
    [byTimeframe, timeframe],
  );
  const view: WindowViewValue = useMemo(
    () => ({
      windowId,
      group: null,
      code,
      timeframe,
      // 드로어는 페치를 돌리지 않는다 — 뷰 식별용이 아님(`/live` 와 같은 이유).
      historicalFromDate: null,
      indicators,
      workspace: STUDY_WINDOW_WORKSPACE,
    }),
    [windowId, code, timeframe, indicators],
  );

  if (!chartConfig) return null;

  return (
    <WindowViewContext.Provider value={view}>
      <IndicatorPanel
        key={windowId}
        onClose={onClose}
        timeframe={timeframe}
        targetLabel={targetLabel ?? undefined}
      />
    </WindowViewContext.Provider>
  );
}
