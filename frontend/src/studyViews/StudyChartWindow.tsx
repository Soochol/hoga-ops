/**
 * `/study` 차트 창 — 봉·그리기·보조지표를 **자기 헤더가 소유**한다 (지도 #900).
 *
 * `/live` `ChartWindow` 의 `/study` 판이자 그 거울상이다. 같은 2층 구조를 쓴다:
 * `WindowFrameCore` 의 26px 타이틀바(종류 라벨) 아래에 컨트롤 행이 오고, 그 밑이
 * 차트다. 컨트롤 행은 창 본문에 있지 타이틀바가 아니다 — `/live` 와 같은 자리.
 *
 * 바깥(`StudyChartWindow`)이 Provider 를 세우고 안(`StudyChartWindowInner`)이
 * 그 값을 쓴다. 한 컴포넌트에서 Provider 를 세우고 동시에 소비할 수 없기 때문에
 * `/live` 가 쪼갠 것과 같은 경계다.
 *
 * Provider 가 붙는 순간 `LiveChartRoot` 서브트리의 창-스코프 훅 소비자 33개가
 * 창 경로로 전환된다(#901). 그 경로가 `/study` 스토어를 보게 만드는 건 #907 의
 * 어댑터고, 여기서는 그걸 실어 주기만 한다.
 */
import { useMemo, useRef, type ComponentProps } from 'react';
import ChartErrorBoundary from '../chart/ChartErrorBoundary';
import { ChartDrawingShell } from '../live/ChartDrawingShell';
import { DrawingMenu } from '../live/DrawingMenu';
import { LiveChartRoot } from '../live/LiveChartRoot';
import { IndicatorsButton } from '../live/LiveToolbar';
import { TimeframeControl } from '../live/TimeframeControl';
import { STUDY_HEADER_FOLD } from '../live/workspace/chartHeaderCompact';
import { requestIndicatorDrawer } from '../live/workspace/indicatorDrawerControls';
import { useChartHeaderFold } from '../live/workspace/useChartHeaderCompact';
import { WindowViewContext, type WindowViewValue } from '../live/workspace/windowView';
import {
  FACTORY_INDICATOR_SETTINGS,
  resolveIndicatorSettings,
} from '../state/indicatorSettingsV2';
import { STUDY_DEFAULT_MINUTE_TIMEFRAME } from '../state/studyLastMinuteTimeframe';
import { useStudyWorkspaceStore } from '../state/studyWorkspace';
import type { LiveTimeframe, MinuteTimeframe } from '../state/livePage';
import { STUDY_WINDOW_WORKSPACE } from './studyWindowWorkspace';

/** 차트 데이터 배선 — 페이지가 쿼리 소유자라 값은 위에서 오지만, 요소를 만드는
 *  건 창이다(로딩 자리·에러 경계·셸 선택이 창의 결정이 되게). */
export type StudyChartRootProps = ComponentProps<typeof LiveChartRoot>;

export type StudyChartWindowProps = {
  windowId: string;
  /** 활성 저장뷰의 종목 — Provider 의 `code`. */
  code: string | null;
  /** 분봉 슬롯 복귀용 기억값(창 설정이 없을 때의 폴백). */
  rememberedMinute: MinuteTimeframe;
  onTimeframeChange: (tf: LiveTimeframe) => void;
  /** 보조지표 드로어 헤더에 찍히는 대상 이름. */
  targetLabel: string | null;
  /** null = 아직 준비 전(로딩/에러). 헤더는 그때도 렌더한다. */
  chart: StudyChartRootProps | null;
  loading: boolean;
};

export function StudyChartWindow(props: StudyChartWindowProps) {
  const { windowId, code } = props;
  const chartConfig = useStudyWorkspaceStore(
    (s) => s.windows.find((w) => w.id === windowId)?.chart,
  );
  const timeframe = chartConfig?.timeframe ?? STUDY_DEFAULT_MINUTE_TIMEFRAME;
  const byTimeframe = chartConfig?.indicators.byTimeframe;
  const indicators = useMemo(
    () => (byTimeframe ? resolveIndicatorSettings(byTimeframe, timeframe) : FACTORY_INDICATOR_SETTINGS),
    [byTimeframe, timeframe],
  );
  // 좌측 팬 딥 백필의 창별 from-date — 비영속 런타임(#713 과 정합).
  const historicalFromDate = useStudyWorkspaceStore(
    (s) => s.chartRuntime[windowId]?.historicalFromDate ?? null,
  );

  const view: WindowViewValue = useMemo(
    () => ({
      windowId,
      // `/study` 에는 링크 그룹이 없다 — 활성 저장뷰가 단일 암묵 그룹(ADR-0123).
      group: null,
      code,
      timeframe,
      historicalFromDate,
      indicators,
      workspace: STUDY_WINDOW_WORKSPACE,
    }),
    [windowId, code, timeframe, historicalFromDate, indicators],
  );

  return (
    <WindowViewContext.Provider value={view}>
      <StudyChartWindowInner {...props} timeframe={timeframe} />
    </WindowViewContext.Provider>
  );
}

function StudyChartWindowInner({
  windowId,
  rememberedMinute,
  onTimeframeChange,
  timeframe,
  chart,
  loading,
}: StudyChartWindowProps & { timeframe: LiveTimeframe }) {
  const headerRef = useRef<HTMLDivElement>(null);
  // 임계는 `/live` 값을 재사용하지 않는다 — 액션이 2버튼이라 그대로 쓰면 일찍
  // 접힌다(#903, #905 가 실측으로 대체).
  const fold = useChartHeaderFold(headerRef, STUDY_HEADER_FOLD);

  return (
    <div className="flex h-full w-full flex-col">
      <div
        ref={headerRef}
        data-testid="study-chart-window-header"
        className="flex shrink-0 items-center gap-1 overflow-hidden bg-bg-card px-1 py-0.5"
      >
        <TimeframeControl
          timeframe={timeframe}
          rememberedMinute={rememberedMinute}
          onChange={onTimeframeChange}
          compact={fold.compactTimeframe}
        />
        <div className="ml-auto flex items-center gap-0.5">
          <DrawingMenu
            code={chart?.code ?? null}
            timeframe={timeframe}
            showLabel={!fold.compactActions}
          />
          <IndicatorsButton
            onClick={() => requestIndicatorDrawer(windowId)}
            showLabel={!fold.compactActions}
          />
        </div>
      </div>
      <div
        data-testid="study-chart-card"
        className="relative min-h-0 min-w-0 flex-1 overflow-hidden"
      >
        {loading ? (
          <div
            data-testid="study-page-loading"
            className="flex h-full items-center justify-center text-sm text-[var(--fg-dimmer)]"
          >
            학습뷰 불러오는 중...
          </div>
        ) : chart ? (
          <ChartErrorBoundary>
            <ChartDrawingShell>
              <LiveChartRoot {...chart} />
            </ChartDrawingShell>
          </ChartErrorBoundary>
        ) : null}
      </div>
    </div>
  );
}
