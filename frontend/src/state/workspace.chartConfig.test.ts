import { beforeEach, describe, expect, it } from 'vitest';
import { useWorkspaceStore, WORKSPACE_STORAGE_KEY, type WorkspaceWindow } from './workspace';
import { FACTORY_INDICATOR_SETTINGS, resolveIndicatorSettings } from './indicatorSettingsV2';

/** ADR-0119 C2c-2a — 창별 지표 쓰기 경로·비영속 런타임. */

function chartWindow(id: string, overrides: Partial<WorkspaceWindow> = {}): WorkspaceWindow {
  return {
    id,
    kind: 'chart',
    group: 1,
    rect: { x: 0, y: 0, w: 400, h: 300 },
    chart: { timeframe: '1m', indicators: { paneOrder: [], paneStretch: {}, byTimeframe: {} } },
    ...overrides,
  };
}

function bookWindow(id: string): WorkspaceWindow {
  return { id, kind: 'book', group: 1, rect: { x: 0, y: 0, w: 200, h: 300 } };
}

function seed(windows: WorkspaceWindow[]): void {
  useWorkspaceStore.setState({
    windows,
    zOrder: windows.map((w) => w.id),
    groupSymbols: {},
    chartRuntime: {},
  });
}

function chartOf(id: string) {
  const win = useWorkspaceStore.getState().windows.find((w) => w.id === id);
  if (!win?.chart) throw new Error(`no chart window ${id}`);
  return win.chart;
}

beforeEach(() => {
  localStorage.clear();
  seed([chartWindow('c1'), bookWindow('b1')]);
});

describe('patchChartIndicators', () => {
  it('현재 봉(분봉) 버킷에 patch 를 누적하고 영속한다', () => {
    useWorkspaceStore.getState().patchChartIndicators('c1', { movingAverageEnabled: false });
    useWorkspaceStore.getState().patchChartIndicators('c1', { volumeEnabled: false });
    expect(chartOf('c1').indicators.byTimeframe.minute).toEqual({
      movingAverageEnabled: false,
      volumeEnabled: false,
    });
    const persisted = JSON.parse(localStorage.getItem(WORKSPACE_STORAGE_KEY) ?? '{}');
    expect(persisted.windows[0].chart.indicators.byTimeframe.minute.volumeEnabled).toBe(false);
  });

  it('창의 timeframe 이 D 면 D 버킷에 쓴다', () => {
    useWorkspaceStore.getState().setChartTimeframe('c1', 'D');
    useWorkspaceStore.getState().patchChartIndicators('c1', { movingAverageEnabled: false });
    expect(chartOf('c1').indicators.byTimeframe.D).toEqual({ movingAverageEnabled: false });
    expect(chartOf('c1').indicators.byTimeframe.minute).toBeUndefined();
  });

  it('비차트 창·미지의 id 는 no-op', () => {
    const before = useWorkspaceStore.getState().windows;
    useWorkspaceStore.getState().patchChartIndicators('b1', { volumeEnabled: false });
    useWorkspaceStore.getState().patchChartIndicators('nope', { volumeEnabled: false });
    expect(useWorkspaceStore.getState().windows).toBe(before);
  });

  it('다른 창의 설정에는 영향이 없다', () => {
    seed([chartWindow('c1'), chartWindow('c2')]);
    useWorkspaceStore.getState().patchChartIndicators('c1', { volumeEnabled: false });
    expect(chartOf('c2').indicators.byTimeframe).toEqual({});
  });
});

describe('setChartTimeframe', () => {
  it('봉을 바꾸고 분봉이면 lastMinuteTimeframe 을 기억한다', () => {
    useWorkspaceStore.getState().setChartTimeframe('c1', '5m');
    expect(chartOf('c1').timeframe).toBe('5m');
    expect(chartOf('c1').lastMinuteTimeframe).toBe('5m');
    useWorkspaceStore.getState().setChartTimeframe('c1', 'D');
    expect(chartOf('c1').timeframe).toBe('D');
    expect(chartOf('c1').lastMinuteTimeframe).toBe('5m'); // D 는 기억 유지
  });

  it('무효 봉은 no-op', () => {
    useWorkspaceStore.getState().setChartTimeframe('c1', '7m' as never);
    expect(chartOf('c1').timeframe).toBe('1m');
  });

  it('분봉을 떠날 때 팬 창(historicalFromDate)을 기억하고 백필은 리셋한다', () => {
    useWorkspaceStore.getState().extendChartHistoricalRange('c1', '20260701');
    useWorkspaceStore.getState().setChartTimeframe('c1', 'D');
    const rt = useWorkspaceStore.getState().chartRuntime.c1;
    expect(rt.historicalFromDate).toBeNull();
    expect(rt.lastMinuteHistoricalFromDate).toBe('20260701');
  });

  it('복원 대기(hFD=null·기억≠null) 상태에서 분봉→분봉 전환해도 기억이 살아남는다', () => {
    useWorkspaceStore.getState().extendChartHistoricalRange('c1', '20260701');
    useWorkspaceStore.getState().setChartTimeframe('c1', 'D'); // 기억으로 이동
    useWorkspaceStore.getState().setChartTimeframe('c1', '3m'); // 복원 대기 상태
    const rt = useWorkspaceStore.getState().chartRuntime.c1;
    expect(rt.lastMinuteHistoricalFromDate).toBe('20260701');
  });
});

describe('레이아웃 슬라이스', () => {
  it('setChartPaneOrder 는 normalize 해 창에 저장한다', () => {
    useWorkspaceStore.getState().setChartPaneOrder('c1', ['volume', 'candle'] as never);
    const order = chartOf('c1').indicators.paneOrder;
    expect(order[0]).toBe('candle'); // candle 은 항상 index 0 (ADR-0114)
    expect(order).toContain('volume');
  });

  it('setChartPaneStretch 는 기존 값과 병합한다', () => {
    useWorkspaceStore.getState().setChartPaneStretch('c1', { volume: 2 } as never);
    useWorkspaceStore.getState().setChartPaneStretch('c1', { ratio: 3 } as never);
    expect(chartOf('c1').indicators.paneStretch).toMatchObject({ volume: 2, ratio: 3 });
  });
});

describe('resetChartIndicators', () => {
  it('현재 봉 버킷만 비우고 다른 봉은 보존한다', () => {
    useWorkspaceStore.getState().patchChartIndicators('c1', { volumeEnabled: false });
    useWorkspaceStore.getState().setChartTimeframe('c1', 'D');
    useWorkspaceStore.getState().patchChartIndicators('c1', { movingAverageEnabled: false });
    useWorkspaceStore.getState().resetChartIndicators('c1'); // 현재 봉 = D
    const by = chartOf('c1').indicators.byTimeframe;
    expect(by.D).toBeUndefined();
    expect(by.minute).toEqual({ volumeEnabled: false });
  });
});

describe('applyChartIndicatorPreset', () => {
  it('enable 은 프리셋으로 교체·파라미터는 보존·레이아웃은 프리셋 값', () => {
    useWorkspaceStore.getState().patchChartIndicators('c1', {
      volumeEnabled: false,
      askPeakColor: '#123456',
    });
    useWorkspaceStore.getState().applyChartIndicatorPreset('c1', {
      paneOrder: [],
      paneStretch: {},
      byTimeframeEnable: { minute: { volumeEnabled: true } },
    });
    const by = chartOf('c1').indicators.byTimeframe;
    expect(by.minute?.volumeEnabled).toBe(true); // enable 교체
    expect(by.minute?.askPeakColor).toBe('#123456'); // 파라미터 보존
    const resolved = resolveIndicatorSettings(by, '1m');
    expect(resolved.askPeakColor).toBe('#123456');
  });
});

describe('창별 런타임(historicalFromDate)', () => {
  it('extend 는 단조 감소 — 더 이른 날짜만 반영된다', () => {
    useWorkspaceStore.getState().extendChartHistoricalRange('c1', '20260701');
    useWorkspaceStore.getState().extendChartHistoricalRange('c1', '20260710'); // 더 늦음 → 무시
    expect(useWorkspaceStore.getState().chartRuntime.c1.historicalFromDate).toBe('20260701');
    useWorkspaceStore.getState().extendChartHistoricalRange('c1', '20260601');
    expect(useWorkspaceStore.getState().chartRuntime.c1.historicalFromDate).toBe('20260601');
  });

  it('비차트 창에는 extend 가 no-op', () => {
    useWorkspaceStore.getState().extendChartHistoricalRange('b1', '20260701');
    expect(useWorkspaceStore.getState().chartRuntime.b1).toBeUndefined();
  });

  it('resetChartHistoricalRange 는 런타임 항목을 제거한다', () => {
    useWorkspaceStore.getState().extendChartHistoricalRange('c1', '20260701');
    useWorkspaceStore.getState().resetChartHistoricalRange('c1');
    expect(useWorkspaceStore.getState().chartRuntime.c1).toBeUndefined();
  });

  it('창 닫힘·그룹 종목 교체가 런타임을 정리한다', () => {
    seed([chartWindow('c1'), chartWindow('c2', { group: 2 })]);
    useWorkspaceStore.getState().extendChartHistoricalRange('c1', '20260701');
    useWorkspaceStore.getState().extendChartHistoricalRange('c2', '20260701');
    // 그룹 1 종목 교체 → c1 런타임만 리셋
    useWorkspaceStore.getState().setGroupSymbol(1, { code: '005930', name: '삼성전자' });
    expect(useWorkspaceStore.getState().chartRuntime.c1).toBeUndefined();
    expect(useWorkspaceStore.getState().chartRuntime.c2?.historicalFromDate).toBe('20260701');
    // 창 닫힘 → c2 런타임 정리
    useWorkspaceStore.getState().closeWindow('c2');
    expect(useWorkspaceStore.getState().chartRuntime.c2).toBeUndefined();
  });

  it('런타임은 영속되지 않는다(#713 뷰포트 비저장)', () => {
    useWorkspaceStore.getState().extendChartHistoricalRange('c1', '20260701');
    useWorkspaceStore.getState().patchChartIndicators('c1', { volumeEnabled: false }); // persist 유발
    const persisted = JSON.parse(localStorage.getItem(WORKSPACE_STORAGE_KEY) ?? '{}');
    expect(persisted.chartRuntime).toBeUndefined();
  });
});

describe('창 복제·하이드레이션의 lastMinuteTimeframe', () => {
  it('addWindow 복제가 분봉 기억을 함께 복제한다', () => {
    useWorkspaceStore.getState().setChartTimeframe('c1', '5m');
    useWorkspaceStore.getState().focusWindow('c1');
    const id = useWorkspaceStore.getState().addWindow('chart');
    expect(chartOf(id).lastMinuteTimeframe).toBe('5m');
  });

  it('공장 기본과 무효 저장값은 기억 없음으로 하이드레이트된다', () => {
    expect(chartOf('c1').lastMinuteTimeframe).toBeUndefined();
    expect(resolveIndicatorSettings(chartOf('c1').indicators.byTimeframe, '1m'))
      .toEqual(FACTORY_INDICATOR_SETTINGS);
  });
});
