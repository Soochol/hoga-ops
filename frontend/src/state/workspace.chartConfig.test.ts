import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useWorkspaceStore, WORKSPACE_STORAGE_KEY, type WorkspaceWindow } from './workspace';

/** 창별 봉 쓰기 경로·비영속 런타임 (ADR-0119 C2c-2a).
 *
 *  지표는 여기 없다 — 창 소유였다가(#712) 전역 `live.indicators.v2` 로 돌아갔다.
 *  그 계약은 `live/workspace/windowView.actions.test.tsx` 가 본다. */

function chartWindow(id: string, overrides: Partial<WorkspaceWindow> = {}): WorkspaceWindow {
  return {
    id,
    kind: 'chart',
    group: 1,
    rect: { x: 0, y: 0, w: 400, h: 300 },
    chart: { timeframe: '1m' },
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
  // 탭 저장소가 authoritative 이므로(workspace.ts 스코프) 함께 비운다 — 앞 테스트가
  // 남긴 sessionStorage 가 localStorage 픽스처를 가린다.
  sessionStorage.clear();
  localStorage.clear();
  seed([chartWindow('c1'), bookWindow('b1')]);
});

describe('setChartTimeframe', () => {
  it('비차트 창·미지의 id 는 no-op', () => {
    const before = useWorkspaceStore.getState().windows;
    useWorkspaceStore.getState().setChartTimeframe('b1', '5m');
    useWorkspaceStore.getState().setChartTimeframe('nope', '5m');
    expect(useWorkspaceStore.getState().windows).toBe(before);
  });

  it('다른 창의 봉에는 영향이 없다', () => {
    seed([chartWindow('c1'), chartWindow('c2')]);
    useWorkspaceStore.getState().setChartTimeframe('c1', 'D');
    expect(chartOf('c2').timeframe).toBe('1m');
  });

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
    // 날짜만으로는 복원이 안전하지 않다 — 그 값을 만든 봉이 함께 남아야 한다.
    expect(rt.lastMinuteHistoricalTimeframe).toBe('1m');
  });

  it('기억은 그 창을 만든 봉을 도장으로 남긴다(60m 에서 떠나면 60m)', () => {
    useWorkspaceStore.getState().setChartTimeframe('c1', '60m');
    useWorkspaceStore.getState().extendChartHistoricalRange('c1', '20240506');
    useWorkspaceStore.getState().setChartTimeframe('c1', '1m');
    const rt = useWorkspaceStore.getState().chartRuntime.c1;
    // 값은 남지만 도장이 '60m' 이라 1m 복원은 이것을 쓰지 않는다(LiveChartRoot 게이트).
    expect(rt.lastMinuteHistoricalFromDate).toBe('20240506');
    expect(rt.lastMinuteHistoricalTimeframe).toBe('60m');
  });

  it('팬 없이 스쳐 간 분봉은 도장을 덮지 않는다 — 날짜와 봉은 한 쌍으로만 움직인다', () => {
    // 1m 을 깊게 팬 → 60m 을 팬 없이 거쳐 감 → 1m 복귀. 60m 구간에서 도장만
    // 무조건 갱신되면 1m 이 만든 날짜에 '60m' 이 찍혀 1m 복원이 조용히 죽는다.
    useWorkspaceStore.getState().extendChartHistoricalRange('c1', '20260701');
    useWorkspaceStore.getState().setChartTimeframe('c1', '60m'); // 기억 = (20260701, 1m)
    useWorkspaceStore.getState().setChartTimeframe('c1', '1m');  // 60m 에서 팬 0회
    const rt = useWorkspaceStore.getState().chartRuntime.c1;
    expect(rt.lastMinuteHistoricalFromDate).toBe('20260701');
    expect(rt.lastMinuteHistoricalTimeframe).toBe('1m');
  });

  it('복원 대기(hFD=null·기억≠null) 상태에서 분봉→분봉 전환해도 기억이 살아남는다', () => {
    useWorkspaceStore.getState().extendChartHistoricalRange('c1', '20260701');
    useWorkspaceStore.getState().setChartTimeframe('c1', 'D'); // 기억으로 이동
    useWorkspaceStore.getState().setChartTimeframe('c1', '3m'); // 복원 대기 상태
    const rt = useWorkspaceStore.getState().chartRuntime.c1;
    expect(rt.lastMinuteHistoricalFromDate).toBe('20260701');
    expect(rt.lastMinuteHistoricalTimeframe).toBe('1m');
  });

  it('비분봉→비분봉(D→W) 사이를 건너뛰어도 기억이 유지된다', () => {
    // 떠날 때의 봉이 분봉이 아니면 기억을 갱신하지 않는다 — D 에서 W 로 가는 동안
    // 분봉 창 기억이 null 로 덮이면 분봉 복귀 시 팬 창이 영구 소실된다.
    useWorkspaceStore.getState().extendChartHistoricalRange('c1', '20260701');
    useWorkspaceStore.getState().setChartTimeframe('c1', 'D');
    useWorkspaceStore.getState().setChartTimeframe('c1', 'W');
    const rt = useWorkspaceStore.getState().chartRuntime.c1;
    expect(rt.historicalFromDate).toBeNull();
    expect(rt.lastMinuteHistoricalFromDate).toBe('20260701');
    expect(rt.lastMinuteHistoricalTimeframe).toBe('1m');
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

  it('그룹 이동(setWindowGroup)도 그 창의 런타임을 리셋한다 — 종목 교체와 동격', () => {
    useWorkspaceStore.getState().extendChartHistoricalRange('c1', '20260601');
    useWorkspaceStore.getState().setWindowGroup('c1', 2); // 그룹 이동 = 표시 종목 교체
    expect(useWorkspaceStore.getState().chartRuntime.c1).toBeUndefined();
    // 같은 그룹 재지정(no-op)은 런타임을 건드리지 않는다.
    useWorkspaceStore.getState().extendChartHistoricalRange('c1', '20260601');
    useWorkspaceStore.getState().setWindowGroup('c1', 2);
    expect(useWorkspaceStore.getState().chartRuntime.c1?.historicalFromDate).toBe('20260601');
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
    useWorkspaceStore.getState().setChartTimeframe('c1', '5m'); // persist 유발
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
  });

  it('저장값 없는 분봉 창은 하이드레이션에서 분봉 기억을 파생한다(livePage 미러)', async () => {
    localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify({
      windows: [{
        id: 'h5m', kind: 'chart', group: 1,
        rect: { x: 0, y: 0, w: 400, h: 300 },
        chart: { timeframe: '5m' },
      }, {
        id: 'hD', kind: 'chart', group: 1,
        rect: { x: 0, y: 0, w: 400, h: 300 },
        chart: { timeframe: 'D' },
      }],
      zOrder: ['h5m', 'hD'],
      groupSymbols: {},
    }));
    vi.resetModules();
    const mod = await import('./workspace');
    const wins = mod.useWorkspaceStore.getState().windows;
    expect(wins.find((w) => w.id === 'h5m')?.chart?.lastMinuteTimeframe).toBe('5m'); // 분봉→파생
    expect(wins.find((w) => w.id === 'hD')?.chart?.lastMinuteTimeframe).toBeUndefined(); // 비분봉→없음
  });

  it('구 스냅샷의 창별 지표 사본은 창에 실리지 않는다(전역으로 승격 후 소멸)', async () => {
    localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify({
      schema_version: 2,
      windows: [{
        id: 'legacy', kind: 'chart', group: 1,
        rect: { x: 0, y: 0, w: 0.4, h: 0.9 },
        chart: {
          timeframe: '1m',
          indicators: { paneOrder: [], paneStretch: { volume: 5 }, byTimeframe: { minute: { volumeEnabled: false } } },
        },
      }],
      zOrder: ['legacy'],
      groupSymbols: {},
    }));
    vi.resetModules();
    const mod = await import('./workspace');
    const win = mod.useWorkspaceStore.getState().windows.find((w) => w.id === 'legacy');
    expect(win?.chart).toEqual({ timeframe: '1m', lastMinuteTimeframe: '1m' });
    expect(win?.chart && 'indicators' in win.chart).toBe(false);
  });
});
