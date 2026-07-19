import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import {
  WindowViewContext,
  useIndicatorActions,
  useHistoricalRangeActions,
  useWindowIndicator,
  useWindowPaneOrder,
  useWindowPaneStretch,
  useWindowViewGuard,
  type WindowViewValue,
} from './windowView';
import { useLivePageStore } from '../../state/livePage';
import { useWorkspaceStore, type WorkspaceWindow } from '../../state/workspace';
import {
  FACTORY_INDICATOR_SETTINGS,
  resolveIndicatorSettings,
} from '../../state/indicatorSettingsV2';

/** ADR-0119 C2c-2a — 지표 편집 표면의 창/전역 이중 백엔드. */

function chartWindow(id: string): WorkspaceWindow {
  return {
    id,
    kind: 'chart',
    group: 3,
    rect: { x: 0, y: 0, w: 400, h: 300 },
    chart: { timeframe: '5m', indicators: { paneOrder: [], paneStretch: {}, byTimeframe: {} } },
  };
}

function seedWorkspace(windows: WorkspaceWindow[]): void {
  useWorkspaceStore.setState({
    windows,
    zOrder: windows.map((w) => w.id),
    groupSymbols: { 3: { code: '000660', name: 'SK하이닉스' } },
    chartRuntime: {},
  });
}

function windowValue(windowId: string): WindowViewValue {
  return {
    windowId,
    group: 3,
    code: '000660',
    timeframe: '5m',
    historicalFromDate: null,
    indicators: { ...FACTORY_INDICATOR_SETTINGS },
  };
}

function provider(value: WindowViewValue) {
  return ({ children }: { children: ReactNode }) => (
    <WindowViewContext.Provider value={value}>{children}</WindowViewContext.Provider>
  );
}

function chartOf(id: string) {
  const win = useWorkspaceStore.getState().windows.find((w) => w.id === id);
  if (!win?.chart) throw new Error(`no chart window ${id}`);
  return win.chart;
}

beforeEach(() => {
  localStorage.clear();
  seedWorkspace([chartWindow('w1')]);
});

describe('useIndicatorActions — Provider 밖(전역 폴백)', () => {
  it('전역 스토어를 변이하고 워크스페이스는 건드리지 않는다', () => {
    const before = useLivePageStore.getState().movingAverageEnabled;
    const { result } = renderHook(() => useIndicatorActions());
    result.current.setMovingAverageEnabled(!before);
    expect(useLivePageStore.getState().movingAverageEnabled).toBe(!before);
    expect(chartOf('w1').indicators.byTimeframe).toEqual({});
    result.current.setMovingAverageEnabled(before); // 전역 상태 원복
  });
});

describe('useIndicatorActions — Provider 안(창 백엔드)', () => {
  it('창의 봉 버킷을 변이하고 전역은 건드리지 않는다', () => {
    const globalBefore = useLivePageStore.getState().volumeEnabled;
    const { result } = renderHook(() => useIndicatorActions(), {
      wrapper: provider(windowValue('w1')),
    });
    result.current.setVolumeEnabled(false);
    expect(chartOf('w1').indicators.byTimeframe.minute?.volumeEnabled).toBe(false);
    expect(useLivePageStore.getState().volumeEnabled).toBe(globalBefore);
  });

  it('enable↔hidden 결합 시맨틱이 창 버킷에도 적용된다', () => {
    const { result } = renderHook(() => useIndicatorActions(), {
      wrapper: provider(windowValue('w1')),
    });
    result.current.setAskPeakHidden(true);
    result.current.setAskPeakEnabled(true); // 켜는 순간 hidden 초기화
    const bucket = chartOf('w1').indicators.byTimeframe.minute;
    expect(bucket?.askPeakEnabled).toBe(true);
    expect(bucket?.askPeakHidden).toBe(false);
  });

  it('read-modify-write op 이 호출 시점 fresh 설정을 읽는다(stale closure 없음)', () => {
    const { result } = renderHook(() => useIndicatorActions(), {
      wrapper: provider(windowValue('w1')),
    });
    const baseCount = FACTORY_INDICATOR_SETTINGS.movingAverages.length;
    result.current.addMovingAverage();
    result.current.addMovingAverage(); // 두 번째 호출이 첫 결과 위에 쌓여야 한다
    const resolved = resolveIndicatorSettings(chartOf('w1').indicators.byTimeframe, '5m');
    expect(resolved.movingAverages.length).toBe(baseCount + 2);
  });

  it('setPanePrefForTimeframe 은 창의 현재 봉 버킷에 쓴다', () => {
    const { result } = renderHook(() => useIndicatorActions(), {
      wrapper: provider(windowValue('w1')),
    });
    result.current.setPanePrefForTimeframe('5m', 'ratioEnabled', true);
    expect(chartOf('w1').indicators.byTimeframe.minute?.ratioEnabled).toBe(true);
  });

  it('setPaneOrder/setPaneStretch/resetIndicators 가 창 레이아웃·버킷으로 간다', () => {
    const { result } = renderHook(() => useIndicatorActions(), {
      wrapper: provider(windowValue('w1')),
    });
    result.current.setPaneStretch({ volume: 2 } as never);
    result.current.setVolumeEnabled(false);
    result.current.resetIndicators();
    expect(chartOf('w1').indicators.paneStretch).toMatchObject({ volume: 2 }); // 레이아웃 보존
    expect(chartOf('w1').indicators.byTimeframe.minute).toBeUndefined(); // 현재 봉 버킷 리셋
  });
});

describe('useWindowIndicator', () => {
  it('Provider 안=창 설정, 밖=전역 값', () => {
    const value = windowValue('w1');
    value.indicators = { ...FACTORY_INDICATOR_SETTINGS, askPeakEnabled: true };
    const inWin = renderHook(() => useWindowIndicator((s) => s.askPeakEnabled), {
      wrapper: provider(value),
    });
    expect(inWin.result.current).toBe(true);

    useLivePageStore.setState({ askPeakEnabled: false });
    const outside = renderHook(() => useWindowIndicator((s) => s.askPeakEnabled));
    expect(outside.result.current).toBe(false);
  });
});

describe('useWindowPaneOrder / useWindowPaneStretch', () => {
  it('Provider 안=창 레이아웃, 밖=전역 레이아웃', () => {
    useWorkspaceStore.getState().setChartPaneStretch('w1', { volume: 3 } as never);
    const inWin = renderHook(() => useWindowPaneStretch(), {
      wrapper: provider(windowValue('w1')),
    });
    expect(inWin.result.current).toMatchObject({ volume: 3 });

    const globalOrder = useLivePageStore.getState().paneOrder;
    const outside = renderHook(() => useWindowPaneOrder());
    expect(outside.result.current).toBe(globalOrder);
  });
});

describe('useHistoricalRangeActions', () => {
  it('Provider 안: extend/snapshot/reset 이 창 런타임을 본다', () => {
    const { result } = renderHook(() => useHistoricalRangeActions(), {
      wrapper: provider(windowValue('w1')),
    });
    result.current.extend('20260601');
    expect(result.current.snapshot().historicalFromDate).toBe('20260601');
    expect(useLivePageStore.getState().historicalFromDate).toBeNull();
    result.current.reset();
    expect(result.current.snapshot().historicalFromDate).toBeNull();
  });

  it('Provider 밖: 전역 스토어에 위임한다', () => {
    const { result } = renderHook(() => useHistoricalRangeActions());
    result.current.extend('20260601');
    expect(useLivePageStore.getState().historicalFromDate).toBe('20260601');
    result.current.reset();
    expect(useLivePageStore.getState().historicalFromDate).toBeNull();
  });
});

describe('useWindowViewGuard', () => {
  it('Provider 안: 호출 시점의 워크스페이스 상태를 읽는다(렌더 이후 변경 반영)', () => {
    const { result } = renderHook(() => useWindowViewGuard(), {
      wrapper: provider(windowValue('w1')),
    });
    expect(result.current()).toEqual({ code: '000660', timeframe: '5m' });
    // 재렌더 없이 스토어만 바꿔도 fresh 하게 읽힌다 — stale 디바운스 가드 계약.
    useWorkspaceStore.getState().setChartTimeframe('w1', 'D');
    useWorkspaceStore.getState().setGroupSymbol(3, { code: '005930', name: '삼성전자' });
    expect(result.current()).toEqual({ code: '005930', timeframe: 'D' });
  });

  it('Provider 밖: 전역 스토어를 fresh 하게 읽는다', () => {
    useLivePageStore.setState({ activeCode: '000660', candleTimeframe: '3m' });
    const { result } = renderHook(() => useWindowViewGuard());
    useLivePageStore.setState({ activeCode: '005930', candleTimeframe: 'W' });
    expect(result.current()).toEqual({ code: '005930', timeframe: 'W' });
  });
});
