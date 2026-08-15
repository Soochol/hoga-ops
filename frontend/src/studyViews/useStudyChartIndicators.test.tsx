import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useStudyChartIndicators } from './useStudyChartIndicators';
import { useStudyWorkspaceStore } from '../state/studyWorkspace';
import { useLivePageStore } from '../state/livePage';
import { FACTORY_INDICATOR_SETTINGS } from '../state/indicatorSettingsV2';

/**
 * 창 **밖** 소비자(vdist 데이터 창)가 포커스 차트 창을 따라가는지.
 *
 * 이 훅이 포커스 창과 다른 값을 보면 증상은 **"켰는데 안 보임"** 이다 — 차트는
 * 그리려 하는데 페이지가 받아온 번들에 그 데이터가 없다. 봉만 맞추던 시절에는
 * 그것으로 충분했지만, 창을 분리할 수 있게 된 뒤로는 스코프도 따라가야 한다.
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
    indicatorsByWindow: {},
    indicatorTimeframe: '1m',
  });
});

describe('useStudyChartIndicators', () => {
  it('연동 창이면 공용 세트를 그 창의 봉으로 편다', () => {
    seed([{ id: 's1', timeframe: '1m' }], ['s1']);
    useLivePageStore.setState({ indicatorsByTimeframe: { minute: { volumeDistributionEnabled: true } } });

    const { result } = renderHook(() => useStudyChartIndicators());

    expect(result.current.volumeDistributionEnabled).toBe(true);
  });

  it('포커스 창이 분리돼 있으면 그 창의 설정을 따라간다', () => {
    seed([{ id: 's1', timeframe: '1m' }, { id: 's2', timeframe: '1m' }], ['s1', 's2']);
    // s2 가 포커스(zOrder 최상단)이고, 그 창만 분리해 히트맵을 켠다.
    useLivePageStore.getState().detachWindowIndicators('study:s2');
    useLivePageStore.getState().patchIndicatorsScoped('study:s2', '1m', { depthHeatmapEnabled: true });

    const { result } = renderHook(() => useStudyChartIndicators());

    expect(result.current.depthHeatmapEnabled).toBe(true);
    // 공용 세트는 그대로 — 분리 창의 편집이 새지 않는다.
    expect(useLivePageStore.getState().indicatorsByTimeframe.minute).toBeUndefined();
  });

  it('포커스가 연동 창이면 다른 창의 분리 설정을 보지 않는다', () => {
    seed([{ id: 's1', timeframe: '1m' }, { id: 's2', timeframe: '1m' }], ['s2', 's1']);
    useLivePageStore.getState().detachWindowIndicators('study:s2');
    useLivePageStore.getState().patchIndicatorsScoped('study:s2', '1m', { depthHeatmapEnabled: true });

    const { result } = renderHook(() => useStudyChartIndicators());

    expect(result.current.depthHeatmapEnabled).toBe(false);
  });
});
