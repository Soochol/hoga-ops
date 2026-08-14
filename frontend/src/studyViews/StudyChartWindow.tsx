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
import { useMemo, type ComponentProps } from 'react';
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
  /** 봉 전환 — **어느 창인지 함께 넘긴다**(#801: 창이 여럿이라 대상이 모호해진다). */
  onTimeframeChange: (windowId: string, tf: LiveTimeframe) => void;
  /** 보조지표 드로어 헤더에 찍히는 대상 이름. */
  targetLabel: string | null;
  /** null = 아직 준비 전(로딩/에러). 헤더는 그때도 렌더한다. */
  chart: StudyChartRootProps | null;
  loading: boolean;
  /** 사이드카(최대벽·POC·거래량분포·히트맵·거래원) 진행 상태.
   *
   *  화면 게이트에서 사이드카를 뺀 뒤(#1304) 캔들은 먼저 뜨지만 지표는 콜드일 때
   *  수십 초 뒤에 온다. 그 사이 **아무 표시가 없으면** "지표를 껐나" 와 "아직 오는
   *  중" 이 구별되지 않고, 실패는 아예 무증상이 된다(전에는 페이지가 통째로 에러라
   *  과했지만 신호는 있었다). 이 두 값이 그 자리를 메운다. */
  sidecarLoading: boolean;
  sidecarFailed: boolean;
};

export function StudyChartWindow(props: StudyChartWindowProps) {
  const { windowId, code } = props;
  const chartConfig = useStudyWorkspaceStore(
    (s) => s.windows.find((w) => w.id === windowId)?.chart,
  );
  const timeframe = chartConfig?.timeframe ?? STUDY_DEFAULT_MINUTE_TIMEFRAME;
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
      workspace: STUDY_WINDOW_WORKSPACE,
    }),
    [windowId, code, timeframe, historicalFromDate],
  );

  return (
    <WindowViewContext.Provider value={view}>
      <StudyChartWindowInner
        {...props}
        timeframe={timeframe}
        // 분봉 슬롯은 **이 창의 기억**이 먼저다(#902). 페이지 값은 창 설정이 아직
        // 없을 때의 폴백 — 창이 여럿이면 옆 창의 기억이 새어 들어오면 안 된다.
        rememberedMinute={chartConfig?.lastMinuteTimeframe ?? props.rememberedMinute}
      />
    </WindowViewContext.Provider>
  );
}

/**
 * 사이드카 지표의 진행/실패를 차트 위에 알리는 칩.
 *
 * **인라인인 이유**(DESIGN.md "Error surfaces — 인라인 vs 토스트"): 이 실패의 원인은
 * 지금 화면에 **보이는 그 차트 창**이다. 토스트로 올리면 시선을 원인에서 떼어놓고,
 * 창이 여럿일 때 **어느 창의 지표가 실패했는지** 말할 수 없다.
 *
 * `pointer-events-none` 이라 차트 조작(드래그·크로스헤어)을 가로채지 않는다. z 는
 * pane 오버레이(≤20)보다 위, 그리기 툴바(49~50)보다 아래.
 */
function SidecarStatusChip({ failed }: { failed: boolean }) {
  return (
    <div
      data-testid="study-sidecar-status"
      className="pointer-events-none absolute right-2 top-2 z-[25] flex items-center gap-1.5 rounded-md px-2 py-1 text-xs shadow-panel"
      style={{ background: 'var(--bg-card)', color: failed ? 'var(--error)' : 'var(--fg-dim)' }}
    >
      <span
        // 로딩만 맥동시킨다 — 실패는 **끝난 상태**라 움직이면 아직 진행 중으로 읽힌다.
        className={`h-1.5 w-1.5 rounded-full ${failed ? '' : 'live-pulse'}`}
        style={{ background: failed ? 'var(--error)' : 'var(--accent)' }}
      />
      {failed ? '지표 불러오기 실패' : '지표 불러오는 중'}
    </div>
  );
}

function StudyChartWindowInner({
  windowId,
  rememberedMinute,
  onTimeframeChange,
  timeframe,
  chart,
  loading,
  sidecarLoading,
  sidecarFailed,
}: StudyChartWindowProps & { timeframe: LiveTimeframe }) {
  // 임계는 `/live` 값을 재사용하지 않는다 — 액션이 2버튼이라 그대로 쓰면 일찍
  // 접힌다(#903, #905 가 실측으로 대체).
  const [fold, headerRef] = useChartHeaderFold(STUDY_HEADER_FOLD);

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
          onChange={(next) => onTimeframeChange(windowId, next)}
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
        {/* 창마다 번들이 따로라(#801) 로딩도 창별이다 — 페이지 플래그는 포커스 창
            기준이므로, 아직 안 받아온 다른 창이 빈 사각형으로 남지 않게 `!chart` 도
            같은 자리로 취급한다. */}
        {loading || !chart ? (
          <div
            data-testid="study-page-loading"
            className="flex h-full items-center justify-center text-sm text-fg-dim"
          >
            학습뷰 불러오는 중...
          </div>
        ) : (
          <ChartErrorBoundary>
            <ChartDrawingShell>
              <LiveChartRoot {...chart} />
            </ChartDrawingShell>
          </ChartErrorBoundary>
        )}
        {/* 차트가 실제로 떠 있을 때만 — 로딩 자리(위 분기)에는 이미 문구가 있고,
            거기 겹쳐 놓으면 "불러오는 중" 이 두 번 나온다. */}
        {chart && !loading && (sidecarLoading || sidecarFailed) && (
          <SidecarStatusChip failed={sidecarFailed} />
        )}
      </div>
    </div>
  );
}
