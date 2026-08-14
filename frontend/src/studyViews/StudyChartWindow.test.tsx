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
      chart: { timeframe, lastMinuteTimeframe: '5m' },
    }],
    zOrder: [CHART_ID],
    chartRuntime: {},
  });
  // 지표는 앱 전역 1세트 — 창 시드와 함께 전역 버킷도 비운다.
  useLivePageStore.setState({ indicatorsByTimeframe: {}, indicatorTimeframe: '1m' });
}

/** 같은 id 의 `/live` 미끼 창 — 스토어를 헷갈리면 이 값이 새어 나온다. */
function seedLiveDecoy(): void {
  useWorkspaceStore.setState({
    windows: [{
      id: CHART_ID,
      kind: 'chart',
      group: 3,
      rect: { x: 0, y: 0, w: 0.5, h: 0.5 },
      chart: { timeframe: 'D' },
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
      sidecarLoading={false}
      sidecarFailed={false}
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

  it('pane 레이아웃은 전역 1세트를 읽는다', () => {
    act(() => useLivePageStore.getState().setPaneStretch({ volume: 2 } as never));
    renderWindow({ chart: chartProps });
    expect(probe.paneStretch).toMatchObject({ volume: 2 });
  });

  it('지표 쓰기는 전역 v2 로 간다 — 두 워크스페이스 창 모두 안 움직인다', () => {
    renderWindow({ chart: chartProps });
    act(() => probe.actions!.setRatioEnabled(true));

    expect(useLivePageStore.getState().indicatorsByTimeframe.minute)
      .toMatchObject({ ratioEnabled: true });
    // 창에는 봉만 남는다 — 설정 사본이 되살아나면 다시 탭마다 갈린다.
    expect(useStudyWorkspaceStore.getState().windows[0].chart)
      .toEqual({ timeframe: '5m', lastMinuteTimeframe: '5m' });
    expect(useWorkspaceStore.getState().windows[0].chart).toEqual({ timeframe: 'D' });
    // 읽기도 곧바로 그 값을 본다(구독 생존).
    expect(probe.indicators?.ratioEnabled).toBe(true);
  });

  it('창 봉이 바뀌면 전역 버킷도 그 봉으로 resolve 된다', () => {
    act(() => {
      useLivePageStore.getState().patchIndicatorsAt('D', { ratioEnabled: true });
      useLivePageStore.getState().patchIndicatorsAt('5m', { ratioEnabled: false });
    });
    renderWindow({ chart: chartProps });
    expect(probe.indicators?.ratioEnabled).toBe(false); // minute 버킷

    act(() => useStudyWorkspaceStore.getState().setChartTimeframe(CHART_ID, 'D'));
    expect(probe.indicators?.ratioEnabled).toBe(true); // D 버킷
  });
});

describe('전역 v2 가 지표 SSOT 다', () => {
  it('다른 탭이 바꾼 전역 설정이 창에 그대로 반영된다', () => {
    renderWindow({ chart: { code: '064350', timeframe: '5m' } as unknown as StudyChartRootProps });
    expect(probe.indicators?.ratioEnabled).toBe(false);
    // 크로스탭 재수화(`hydrateIndicatorsFromStorage`)가 하는 일과 같은 모양의 쓰기.
    act(() => {
      useLivePageStore.setState({ indicatorsByTimeframe: { minute: { ratioEnabled: true } } });
    });
    expect(probe.indicators?.ratioEnabled).toBe(true);
  });

  // 게이트에서 사이드카를 뺀 뒤(#1304) 지표는 캔들보다 수십 초 늦게 온다. 표시가
  // 없으면 "껐나" 와 "오는 중" 이 구별되지 않고 실패는 무증상이다.
  describe('사이드카 상태 칩', () => {
    // 차트가 떠 있어야 칩이 나온다 — 아래 케이스가 전부 이 prop 에 의존한다.
    const chart = {} as NonNullable<Parameters<typeof StudyChartWindow>[0]['chart']>;

    it('평상시에는 없다 — 다 온 화면에 잔여 표시가 남으면 안 된다', () => {
      renderWindow({ chart });

      expect(screen.queryByTestId('study-sidecar-status')).toBeNull();
    });

    it('로딩 중이면 진행을 알린다', () => {
      renderWindow({ chart, sidecarLoading: true });

      expect(screen.getByTestId('study-sidecar-status').textContent).toContain('불러오는 중');
    });

    it('실패는 조용히 지나가지 않는다', () => {
      renderWindow({ chart, sidecarFailed: true });

      expect(screen.getByTestId('study-sidecar-status').textContent).toContain('실패');
    });

    it('실패가 로딩을 이긴다 — 끝난 상태를 진행 중으로 말하지 않는다', () => {
      renderWindow({ chart, sidecarLoading: true, sidecarFailed: true });

      expect(screen.getByTestId('study-sidecar-status').textContent).toContain('실패');
    });

    // 페이지가 아직 로딩 자리(“학습뷰 불러오는 중...”)를 그리는 동안에는 칩을 겹치지
    // 않는다 — 같은 화면에 "불러오는 중" 이 두 번 뜬다.
    it('페이지 로딩 자리에는 겹쳐 뜨지 않는다', () => {
      renderWindow({ chart, loading: true, sidecarLoading: true });

      expect(screen.getByTestId('study-page-loading')).toBeTruthy();
      expect(screen.queryByTestId('study-sidecar-status')).toBeNull();
    });
  });
});
