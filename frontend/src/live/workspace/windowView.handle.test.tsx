import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import {
  WindowViewContext,
  useIndicatorActions,
  useHistoricalRangeActions,
  useIsFocusedWindow,
  useWindowPaneOrder,
  useWindowPaneStretch,
  useWindowViewGuard,
  type WindowViewValue,
  type WindowWorkspaceAdapter,
} from './windowView';
import { useWorkspaceStore, type WorkspaceWindow } from '../../state/workspace';
import { useStudyWorkspaceStore } from '../../state/studyWorkspace';
import { FACTORY_INDICATOR_SETTINGS } from '../../state/indicatorSettingsV2';

/**
 * #907 — 창-스코프 훅이 `/live` 스토어 하드코딩을 버리고 주입된 핸들을 본다.
 *
 * 대조군으로 **실제 `/study` 스토어**를 쓴다. 가짜 스토어를 만들면 "두 창 모양이
 * 호환된다"(#906)는 전제 자체를 테스트가 우회해 버려, 정작 배선할 때 어긋나는 걸
 * 못 잡는다. 매 단언마다 `/live` 스토어가 **안 움직였는지**도 함께 본다 — 이
 * 작업이 없애려는 실패는 "틀린 값"이 아니라 "조용히 다른 스토어를 봄"이다.
 */

const STUDY_CODE = '064350';

function studyChartId(): string {
  return useStudyWorkspaceStore.getState().windows.find((w) => w.kind === 'chart')!.id;
}

/** `/study` 판 어댑터 — #908 이 붙일 것의 최소형. 코드는 스토어가 아니라 여기서
 *  나온다(`/study` 에는 링크 그룹이 없다). */
const STUDY_WORKSPACE: WindowWorkspaceAdapter = {
  store: useStudyWorkspaceStore,
  getCode: () => STUDY_CODE,
};

function studyView(windowId: string): WindowViewValue {
  return {
    windowId,
    group: null,
    code: STUDY_CODE,
    timeframe: '5m',
    historicalFromDate: null,
    indicators: { ...FACTORY_INDICATOR_SETTINGS },
    workspace: STUDY_WORKSPACE,
  };
}

function provider(value: WindowViewValue) {
  return ({ children }: { children: ReactNode }) => (
    <WindowViewContext.Provider value={value}>{children}</WindowViewContext.Provider>
  );
}

/** `/live` 쪽에 같은 id 의 창을 심어둔다 — 훅이 스토어를 헷갈리면 이 값이 새어
 *  나온다(id 충돌은 조용한 폴백의 가장 고약한 형태다). */
function seedLiveDecoy(id: string): void {
  const decoy: WorkspaceWindow = {
    id,
    kind: 'chart',
    group: 3,
    rect: { x: 0, y: 0, w: 0.5, h: 0.5 },
    chart: {
      timeframe: 'D',
      indicators: { paneOrder: ['candle'], paneStretch: { volume: 9 }, byTimeframe: {} },
    },
  };
  useWorkspaceStore.setState({
    windows: [decoy],
    zOrder: [],
    groupSymbols: { 3: { code: '000660', name: 'SK하이닉스' } },
    chartRuntime: {},
  });
}

function liveChartOf(id: string) {
  return useWorkspaceStore.getState().windows.find((w) => w.id === id)?.chart;
}

function studyChartOf(id: string) {
  return useStudyWorkspaceStore.getState().windows.find((w) => w.id === id)?.chart;
}

describe('#907 — 주입된 핸들이 읽기 경로를 가른다', () => {
  beforeEach(() => {
    const id = studyChartId();
    seedLiveDecoy(id);
    useStudyWorkspaceStore.getState().setChartPaneStretch(id, { volume: 2 });
  });

  it('paneStretch 를 /study 창에서 읽는다 — 같은 id 의 /live 미끼를 보지 않는다', () => {
    const id = studyChartId();
    const { result } = renderHook(() => useWindowPaneStretch(), { wrapper: provider(studyView(id)) });
    expect(result.current).toEqual({ volume: 2 });
    expect(liveChartOf(id)?.indicators.paneStretch).toEqual({ volume: 9 }); // 미끼는 그대로
  });

  it('paneOrder 도 같은 경로 — 창 값이 있으면 전역 폴백까지 안 간다', () => {
    const id = studyChartId();
    useStudyWorkspaceStore.getState().setChartPaneOrder(id, ['volume', 'candle']);
    const { result } = renderHook(() => useWindowPaneOrder(), { wrapper: provider(studyView(id)) });
    // normalizePaneOrder 가 candle 을 index 0 으로 강제한다(ADR-0114 §3).
    expect(result.current[0]).toBe('candle');
    expect(result.current).toContain('volume');
  });

  it('구독이 살아 있다 — 주입 스토어가 바뀌면 재렌더된다', () => {
    const id = studyChartId();
    const { result } = renderHook(() => useWindowPaneStretch(), { wrapper: provider(studyView(id)) });
    expect(result.current).toEqual({ volume: 2 });

    act(() => useStudyWorkspaceStore.getState().setChartPaneStretch(id, { volume: 4 }));
    // 핸들을 평범한 함수 묶음으로 바꿨다면 여기서 옛 값이 남는다(#901 의 반응성 제약).
    expect(result.current).toEqual({ volume: 4 });
  });

  it('포커스 판정도 주입 스토어의 zOrder 를 본다', () => {
    const id = studyChartId();
    // /live zOrder 는 비어 있으므로, 여기서 true 가 나오면 study zOrder 를 본 것이다.
    act(() => useStudyWorkspaceStore.getState().focusWindow(id));
    const { result } = renderHook(() => useIsFocusedWindow(), { wrapper: provider(studyView(id)) });
    expect(result.current).toBe(true);

    const other = useStudyWorkspaceStore.getState().windows.find((w) => w.id !== id)!.id;
    act(() => useStudyWorkspaceStore.getState().focusWindow(other));
    expect(result.current).toBe(false);
  });
});

describe('#907 — 주입된 핸들이 쓰기 경로를 가른다', () => {
  beforeEach(() => {
    const id = studyChartId();
    seedLiveDecoy(id);
    useStudyWorkspaceStore.getState().resetChartIndicators(id);
  });

  it('지표 편집이 /study 창 버킷에만 쌓인다', () => {
    const id = studyChartId();
    const { result } = renderHook(() => useIndicatorActions(), { wrapper: provider(studyView(id)) });

    act(() => result.current.setRatioEnabled(true));
    expect(studyChartOf(id)?.indicators.byTimeframe.minute).toMatchObject({ ratioEnabled: true });
    expect(liveChartOf(id)?.indicators.byTimeframe).toEqual({}); // /live 무변경
  });

  it('pane 레이아웃 쓰기도 같은 경로', () => {
    const id = studyChartId();
    const { result } = renderHook(() => useIndicatorActions(), { wrapper: provider(studyView(id)) });

    act(() => result.current.setPaneStretch({ volume: 7 }));
    expect(studyChartOf(id)?.indicators.paneStretch).toEqual({ volume: 7 });
    expect(liveChartOf(id)?.indicators.paneStretch).toEqual({ volume: 9 });
  });

  it('딥 백필 from-date 도 주입 스토어의 chartRuntime 에 쌓인다', () => {
    const id = studyChartId();
    const { result } = renderHook(() => useHistoricalRangeActions(), {
      wrapper: provider(studyView(id)),
    });

    act(() => result.current.extend('2026-01-05'));
    expect(result.current.snapshot().historicalFromDate).toBe('2026-01-05');
    expect(useStudyWorkspaceStore.getState().chartRuntime[id].historicalFromDate).toBe('2026-01-05');
    expect(useWorkspaceStore.getState().chartRuntime[id]).toBeUndefined();

    act(() => result.current.reset());
    expect(result.current.snapshot().historicalFromDate).toBeNull();
  });
});

describe('#907 — 코드 축은 스토어가 아니라 어댑터가 답한다', () => {
  it('/study 는 그룹이 없어 getCode 가 코드를 공급한다', () => {
    const id = studyChartId();
    seedLiveDecoy(id); // /live 미끼는 group 3 → 000660 을 갖고 있다
    useStudyWorkspaceStore.getState().setChartTimeframe(id, '10m');

    const { result } = renderHook(() => useWindowViewGuard(), { wrapper: provider(studyView(id)) });
    // 코드는 어댑터에서, 봉은 주입 스토어에서. 미끼의 '000660'·'D' 가 새면 실패한다.
    expect(result.current()).toEqual({ code: STUDY_CODE, timeframe: '10m' });
  });
});
