import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useStudyChartIndicators } from './useStudyChartIndicators';
import { useStudyWorkspaceStore } from '../state/studyWorkspace';
import { useLivePageStore } from '../state/livePage';
import { FACTORY_INDICATOR_SETTINGS } from '../state/indicatorSettingsV2';

/**
 * 창 **밖** 소비자(vdist 데이터 창)가 포커스 차트 창의 봉을 따라가는지, 그리고
 * 지표를 **`/study` 세트**에서 푸는지(ADR-0146).
 *
 * 어느 쪽이든 틀리면 증상은 **"켰는데 안 보임"** 이다 — 차트는 그리려 하는데
 * 페이지가 받아온 번들에 그 데이터가 없다.
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
    indicatorTimeframe: '1m',
  });
});

describe('useStudyChartIndicators', () => {
  it('`/study` 세트를 포커스 창의 봉으로 편다', () => {
    seed([{ id: 's1', timeframe: '1m' }], ['s1']);
    useLivePageStore.getState().patchIndicatorsScoped('study', '1m', {
      volumeDistributionEnabled: true,
    });

    const { result } = renderHook(() => useStudyChartIndicators());

    expect(result.current.volumeDistributionEnabled).toBe(true);
  });

  it('`/live` 세트는 보지 않는다 — 그걸 보면 "켰는데 안 보임" 이 난다', () => {
    seed([{ id: 's1', timeframe: '1m' }], ['s1']);
    useLivePageStore.getState().patchIndicatorsScoped('live', '1m', { depthHeatmapEnabled: true });

    const { result } = renderHook(() => useStudyChartIndicators());

    expect(result.current.depthHeatmapEnabled).toBe(false);
  });

  it('봉은 포커스 창(zOrder 최상단)의 것이다', () => {
    seed([{ id: 's1', timeframe: '1m' }, { id: 's2', timeframe: 'D' }], ['s1', 's2']);
    useLivePageStore.getState().patchIndicatorsScoped('study', 'D', { depthHeatmapEnabled: true });

    const { result } = renderHook(() => useStudyChartIndicators());

    expect(result.current.depthHeatmapEnabled).toBe(true);
  });
});
