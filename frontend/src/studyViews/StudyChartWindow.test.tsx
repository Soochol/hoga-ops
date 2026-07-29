import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { StudyChartWindow } from './StudyChartWindow';
import { useStudyWorkspaceStore } from '../state/studyWorkspace';
import { useStudyTabsStore } from '../state/studyTabs';
import { useWorkspaceStore } from '../state/workspace';
import { useLivePageStore } from '../state/livePage';
import { registerIndicatorDrawerOpener } from '../live/workspace/indicatorDrawerControls';
import {
  useIndicatorActions,
  useWindowIndicators,
  useWindowPaneStretch,
} from '../live/workspace/windowView';
import type { StudyChartRootProps } from './StudyChartWindow';

/**
 * 지도 #900 의 착지점 — `/study` 차트 창이 봉·그리기·보조지표를 자기 헤더에서
 * 소유하는지, 그리고 Provider 가 붙은 뒤 창-스코프 훅이 **`/study` 스토어**를
 * 보는지.
 *
 * 후자가 이 파일의 존재 이유다. Provider 를 붙이는 순간 `LiveChartRoot` 서브트리의
 * 창-스코프 소비자 33개가 창 경로로 전환되는데, 그 경로가 `/live` 스토어를 보면
 * 지표가 **공장 기본값으로 조용히** 렌더된다(#901). 값이 틀린 게 아니라 소리 없이
 * 다른 곳을 보는 실패라 눈으로는 안 잡힌다.
 */

/** 차트 자리에 **창-스코프 훅 소비자**를 세운다 — Provider 아래에서 실제 소비자
 *  33개가 겪는 것과 같은 경로를 한 지점으로 좁힌 대역이다. */
vi.mock('../live/LiveChartRoot', () => ({
  LiveChartRoot: () => {
    probe.indicators = useWindowIndicators();
    probe.actions = useIndicatorActions();
    probe.paneStretch = useWindowPaneStretch();
    return <div data-testid="live-chart-root-stub" />;
  },
}));

const probe: {
  indicators?: ReturnType<typeof useWindowIndicators>;
  actions?: ReturnType<typeof useIndicatorActions>;
  paneStretch?: ReturnType<typeof useWindowPaneStretch>;
} = {};

const CHART_ID = 'w-chart';

function seedStudyWorkspace(timeframe = '5m' as const): void {
  useStudyWorkspaceStore.setState({
    windows: [{
      id: CHART_ID,
      kind: 'chart',
      rect: { x: 0, y: 0, w: 1, h: 1 },
      chart: {
        timeframe,
        lastMinuteTimeframe: '5m',
        indicators: { paneOrder: [], paneStretch: {}, byTimeframe: {} },
      },
    }],
    zOrder: [CHART_ID],
    chartRuntime: {},
  });
}

/** 같은 id 의 `/live` 미끼 창 — 스토어를 헷갈리면 이 값이 새어 나온다. */
function seedLiveDecoy(): void {
  useWorkspaceStore.setState({
    windows: [{
      id: CHART_ID,
      kind: 'chart',
      group: 3,
      rect: { x: 0, y: 0, w: 0.5, h: 0.5 },
      chart: {
        timeframe: 'D',
        indicators: { paneOrder: [], paneStretch: { volume: 9 }, byTimeframe: {} },
      },
    }],
    zOrder: [],
    groupSymbols: { 3: { code: '000660', name: 'SK하이닉스' } },
    chartRuntime: {},
  });
}

function renderWindow(overrides: Partial<Parameters<typeof StudyChartWindow>[0]> = {}) {
  return render(
    <StudyChartWindow
      windowId={CHART_ID}
      code="064350"
      rememberedMinute="5m"
      onTimeframeChange={vi.fn()}
      targetLabel="현대로템"
      loading={false}
      chart={null}
      {...overrides}
    />,
  );
}

beforeEach(() => {
  seedStudyWorkspace();
  seedLiveDecoy();
  useStudyTabsStore.setState({
    tabs: [{
      id: 'tab-1', viewId: 'view-1', code: '064350',
      label: '현대로템 · 복기 · 5m', name: '복기', timeframe: '5m',
    }],
    activeTabId: 'tab-1',
  });
});

describe('세 컨트롤이 창 헤더에 있다 (#908)', () => {
  it('봉·그리기·보조지표가 창 헤더에서 렌더된다', () => {
    renderWindow();
    const header = screen.getByTestId('study-chart-window-header');
    expect(header).toBeTruthy();
    // 봉 컨트롤은 창 설정을 읽는다(탭이 아니라).
    expect(header.querySelector('[data-testid="live-indicators-button"]')).toBeTruthy();
    expect(header.querySelector('[data-testid="drawing-menu-trigger"]')).toBeTruthy();
    expect(screen.getByRole('button', { name: '분봉 선택 열기: 5분' })).toBeTruthy();
  });

  it('봉 컨트롤은 창 설정을 읽는다 — 창 봉을 바꾸면 따라간다', () => {
    renderWindow();
    act(() => useStudyWorkspaceStore.getState().setChartTimeframe(CHART_ID, '15m'));
    expect(screen.getByRole('button', { name: '분봉 선택 열기: 15분' })).toBeTruthy();
  });

  it('보조지표 버튼은 **자기 창 id** 로 드로어를 요청한다(대상 추론 금지)', () => {
    const opened: string[] = [];
    const release = registerIndicatorDrawerOpener((id) => opened.push(id));
    renderWindow();
    fireEvent.click(screen.getByTestId('live-indicators-button'));
    expect(opened).toEqual([CHART_ID]);
    release();
  });
});

describe('Provider 가 /study 스토어를 향한다 (#901·#907)', () => {
  const chartProps = { code: '064350', timeframe: '5m' } as unknown as StudyChartRootProps;

  it('창-스코프 읽기가 /study 창 설정을 본다 — 같은 id 의 /live 미끼가 아니라', () => {
    act(() => useStudyWorkspaceStore.getState().setChartPaneStretch(CHART_ID, { volume: 2 }));
    renderWindow({ chart: chartProps });
    // /live 미끼는 { volume: 9 } 를 들고 있다. 그 값이 나오면 스토어를 헷갈린 것.
    expect(probe.paneStretch).toEqual({ volume: 2 });
  });

  it('창-스코프 쓰기가 /study 창에 쌓인다 — /live 는 안 움직인다', () => {
    renderWindow({ chart: chartProps });
    act(() => probe.actions!.setRatioEnabled(true));

    const study = useStudyWorkspaceStore.getState().windows[0].chart!;
    expect(study.indicators.byTimeframe.minute).toMatchObject({ ratioEnabled: true });
    expect(useWorkspaceStore.getState().windows[0].chart?.indicators.byTimeframe).toEqual({});
    // 읽기도 곧바로 그 값을 본다(구독 생존).
    expect(probe.indicators?.ratioEnabled).toBe(true);
  });

  it('창 봉이 바뀌면 지표 버킷도 그 봉으로 resolve 된다', () => {
    act(() => {
      useStudyWorkspaceStore.getState().patchChartIndicatorsAt(CHART_ID, 'D', { ratioEnabled: true });
      useStudyWorkspaceStore.getState().patchChartIndicatorsAt(CHART_ID, '5m', { ratioEnabled: false });
    });
    renderWindow({ chart: chartProps });
    expect(probe.indicators?.ratioEnabled).toBe(false); // minute 버킷

    act(() => useStudyWorkspaceStore.getState().setChartTimeframe(CHART_ID, 'D'));
    expect(probe.indicators?.ratioEnabled).toBe(true); // D 버킷
  });
});

describe('창 설정이 지표 SSOT 다 (#904)', () => {
  it('전역 live.indicators 를 바꿔도 창 설정이 이긴다', () => {
    act(() => {
      useLivePageStore.setState({ ratioEnabled: true });
      useStudyWorkspaceStore.getState().patchChartIndicators(CHART_ID, { ratioEnabled: false });
    });
    const chart = useStudyWorkspaceStore.getState().windows[0].chart!;
    expect(chart.indicators.byTimeframe.minute).toMatchObject({ ratioEnabled: false });
    // /live 미끼 창은 손대지 않았다.
    expect(useWorkspaceStore.getState().windows[0].chart?.indicators.byTimeframe).toEqual({});
  });
});
