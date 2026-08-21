import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useStudyChartIndicators } from './useStudyChartIndicators';
import { useStudyWorkspaceStore } from '../state/studyWorkspace';
import { useLivePageStore } from '../state/livePage';
import { FACTORY_INDICATOR_SETTINGS } from '../state/indicatorSettingsV2';

/**
 * 창 **밖** 소비자(vdist 데이터 창)가 포커스 차트 창의 **봉과 세트**를 함께
 * 따라가는지(ADR-0146 + ADR-0152).
 *
 * 어느 쪽이든 틀리면 증상은 **"켰는데 안 보임"** 이다 — 차트는 그리려 하는데
 * 페이지가 받아온 번들에 그 데이터가 없다. 창별 독립이 켜진 뒤에는 **봉만**
 * 따라가는 것으로 부족하다: 포커스 창이 자기 세트에 켠 지표를 이 훅이 페이지
 * 세트에서 풀면 정확히 그 증상이 난다.
 */

function seed(windows: { id: string; timeframe: string }[], zOrder: string[]): void {
  useStudyWorkspaceStore.setState({
    windows: windows.map((w) => ({
      id: w.id,
      kind: 'chart' as const,
      rect: { x: 0, y: 0, w: 0.5, h: 0.5 },
      chart: { timeframe: w.timeframe as 'D' | '1m' },
    })),
    zOrder,
    chartRuntime: {},
  });
}

beforeEach(() => {
  localStorage.clear();
  useLivePageStore.setState({
    ...FACTORY_INDICATOR_SETTINGS,
    indicatorsByTimeframe: {},
    studyIndicatorsByTimeframe: {},
    indicatorsByWindow: {},
    indicatorTimeframe: '1m',
  });
});

describe('useStudyChartIndicators', () => {
  it('`/study` 세트를 포커스 창의 봉으로 편다', () => {
    seed([{ id: 's1', timeframe: '1m' }], ['s1']);
    useLivePageStore.getState().patchIndicatorsScoped({ page: 'study', windowKey: null }, '1m', {
      volumeDistributionEnabled: true,
    });

    const { result } = renderHook(() => useStudyChartIndicators());

    expect(result.current.volumeDistributionEnabled).toBe(true);
  });

  it('`/live` 세트는 보지 않는다 — 그걸 보면 "켰는데 안 보임" 이 난다', () => {
    seed([{ id: 's1', timeframe: '1m' }], ['s1']);
    useLivePageStore.getState().patchIndicatorsScoped({ page: 'live', windowKey: null }, '1m', { depthHeatmapEnabled: true });

    const { result } = renderHook(() => useStudyChartIndicators());

    expect(result.current.depthHeatmapEnabled).toBe(false);
  });

  it('봉은 포커스 창(zOrder 최상단)의 것이다', () => {
    seed([{ id: 's1', timeframe: '1m' }, { id: 's2', timeframe: 'D' }], ['s1', 's2']);
    useLivePageStore.getState().patchIndicatorsScoped({ page: 'study', windowKey: null }, 'D', { depthHeatmapEnabled: true });

    const { result } = renderHook(() => useStudyChartIndicators());

    expect(result.current.depthHeatmapEnabled).toBe(true);
  });

  it('세트도 포커스 창의 것이다 — 페이지 세트로 폴백하면 안 된다', () => {
    // 창별 독립(ADR-0152)의 창 밖 대응물. 두 창의 봉이 같아 **봉 축으로는 구별되지
    // 않으므로**, 세트 축이 유일한 기여자다.
    //
    // 페이지 세트에 반대 값을 심는 것이 요점이다: 비워 두면 폴백이든 창이든
    // 공장값(false)이 나와 이 케이스가 아무것도 증명하지 못한다.
    seed([{ id: 's1', timeframe: '1m' }, { id: 's2', timeframe: '1m' }], ['s1', 's2']);
    useLivePageStore.setState({
      studyIndicatorsByTimeframe: { minute: { depthHeatmapEnabled: true } },
      indicatorsByWindow: {
        'study:s1': { minute: { depthHeatmapEnabled: true } },
        'study:s2': {},
      },
    });

    const { result } = renderHook(() => useStudyChartIndicators());

    // 포커스는 s2 (zOrder 최상단) — 자기 세트가 공장값이므로 false 여야 한다.
    expect(result.current.depthHeatmapEnabled).toBe(false);
  });

  it('포커스가 옮겨가면 그 창의 세트를 본다', () => {
    seed([{ id: 's1', timeframe: '1m' }, { id: 's2', timeframe: '1m' }], ['s2', 's1']);
    useLivePageStore.setState({
      indicatorsByWindow: {
        'study:s1': { minute: { depthHeatmapEnabled: true } },
        'study:s2': {},
      },
    });

    const { result } = renderHook(() => useStudyChartIndicators());

    expect(result.current.depthHeatmapEnabled).toBe(true);
  });
});
