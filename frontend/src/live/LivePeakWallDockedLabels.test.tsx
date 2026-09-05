import { render, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { IChartApi, ISeriesApi, SeriesType, Time } from 'lightweight-charts';
import type { PaneSeriesMap } from '../chart/drawing/chartCoordinates';
import type { PaneId } from '../chart/drawing/types';
import type { PeakWallSegment } from '../chart/PeakWallSegmentsPrimitive';
import { PeakWallDockedLabelsPrimitive } from '../chart/PeakWallDockedLabelsPrimitive';
import LivePeakWallDockedLabels from './LivePeakWallDockedLabels';
import type { PeakWallRenderState } from './usePeakWallRender';

function seg(price: number, qty: number, peakSec: number): PeakWallSegment {
  return {
    time0: 60 as Time,
    time1: 240 as Time,
    peakTime: peakSec as Time,
    price,
    qty,
    label: `${price}, ${qty}`,
    color: '#base',
    lineWidth: 2,
  };
}

function wall(over: Partial<PeakWallRenderState> = {}): PeakWallRenderState {
  const segments = over.segments ?? [seg(100, 100, 60), seg(105, 300, 120)];
  return {
    segments,
    legendRankSegments: segments,
    arrowRankSegments: segments,
    stepSegments: [],
    barCandidates: [],
    drawn: true,
    labels: true,
    arrows: true,
    legendCells: true,
    color: '#base',
    lineWidth: 2,
    allWallSegments: [],
    allWallDrawn: false,
    allWallLabels: false,
    allWallColor: '#all',
    allWallLineWidth: 1,
    unreachedSegments: [],
    allWallStepSegments: [],
    unreachedStepSegments: [],
    unreachedDrawn: false,
    unreachedLabels: false,
    unreachedColor: '#unreached',
    unreachedLineWidth: 2,
    tradedHorizontalLine: true,
    tradedTimeMarker: true,
    allWallHorizontalLine: true,
    allWallTimeMarker: true,
    unreachedHorizontalLine: true,
    unreachedTimeMarker: true,
    tradedShownCount: 0,
    tradedHiddenByFilterCount: 0,
    allWallShownCount: 0,
    allWallHiddenByFilterCount: 0,
    unreachedShownCount: 0,
    unreachedHiddenByFilterCount: 0,
    ...over,
  };
}

const EMPTY: PeakWallRenderState = {
  segments: [], legendRankSegments: [], arrowRankSegments: [], stepSegments: [], barCandidates: [], drawn: false, labels: false, arrows: false, legendCells: true, color: '#x', lineWidth: 1,
  allWallSegments: [], allWallDrawn: false, allWallLabels: false, allWallColor: '#x', allWallLineWidth: 1,
  unreachedSegments: [], allWallStepSegments: [], unreachedStepSegments: [], unreachedDrawn: false, unreachedLabels: false, unreachedColor: '#x', unreachedLineWidth: 1,
    tradedHorizontalLine: true,
    tradedTimeMarker: true,
    allWallHorizontalLine: true,
    allWallTimeMarker: true,
    unreachedHorizontalLine: true,
    unreachedTimeMarker: true,
    tradedShownCount: 0,
    tradedHiddenByFilterCount: 0,
    allWallShownCount: 0,
    allWallHiddenByFilterCount: 0,
    unreachedShownCount: 0,
    unreachedHiddenByFilterCount: 0,
};

function renderLabels(askWall: PeakWallRenderState, bidWall: PeakWallRenderState) {
  const attached: PeakWallDockedLabelsPrimitive[] = [];
  const chart = {
    timeScale: () => ({
      getVisibleRange: () => ({ from: 60 as never, to: 240 as never }),
      options: () => ({ barSpacing: 12 }),
      subscribeVisibleLogicalRangeChange: vi.fn(),
      unsubscribeVisibleLogicalRangeChange: vi.fn(),
    }),
  } as unknown as IChartApi;
  const series = {
    attachPrimitive: vi.fn((primitive: PeakWallDockedLabelsPrimitive) => {
      attached.push(primitive);
      primitive.attached({
        chart,
        series: series as unknown as ISeriesApi<SeriesType>,
        requestUpdate: vi.fn(),
      } as unknown as Parameters<PeakWallDockedLabelsPrimitive['attached']>[0]);
    }),
    detachPrimitive: vi.fn(),
  } as unknown as ISeriesApi<SeriesType>;
  const paneSeries = new Map([[('candle' as PaneId), series]]) as PaneSeriesMap;
  render(
    <LivePeakWallDockedLabels paneSeries={paneSeries} askWall={askWall} bidWall={bidWall} />,
  );
  return attached;
}

/**
 * 도킹 라벨은 **계산하지 않는다**(2026-08-23). `usePeakWallRender` 가 낸 세그먼트를
 * 선 오버레이·고저 라벨 회피와 **같은 참조**로 받아 칩만 만든다. 여기서 재는 것은
 * 「받은 세그먼트마다 라벨이 붙는가」와 「`labels` 플래그가 먹는가」뿐이다.
 *
 * **막는 방향**: 이 컴포넌트가 다시 자기 계산을 갖는 것, 그리고 라벨 토글이 안 먹는 것.
 * **못 보는 것**: 필터가 실제로 무엇을 거르는지 — `peakWallMaFilterWiring.test.tsx` 가
 * 훅에서 잰다(선·라벨·회피가 같은 참조라 셋이 함께 덮인다).
 */
describe('LivePeakWallDockedLabels', () => {
  it('그려지는 벽마다 라벨을 붙인다(상위 하나만이 아니다)', async () => {
    const attached = renderLabels(wall(), EMPTY);
    await waitFor(() => {
      expect(attached[0].labelsData().map((l) => l.price).sort((a, b) => a - b))
        .toEqual([100, 105]);
    });
  });

  it('매도 라벨 토글이 꺼지면(labels=false) 매도 라벨만 사라진다', async () => {
    const attached = renderLabels(wall({ labels: false }), wall());
    await waitFor(() => {
      const sides = attached[0].labelsData().map((l) => l.side);
      expect(sides.every((s) => s === 'bid')).toBe(true);
      expect(sides).toHaveLength(2);
    });
  });

  it('매수 라벨 토글이 꺼지면 매수 라벨만 사라진다', async () => {
    const attached = renderLabels(wall(), wall({ labels: false }));
    await waitFor(() => {
      const sides = attached[0].labelsData().map((l) => l.side);
      expect(sides.every((s) => s === 'ask')).toBe(true);
      expect(sides).toHaveLength(2);
    });
  });

  it('양쪽 다 꺼지면 라벨이 없다', async () => {
    const attached = renderLabels(EMPTY, EMPTY);
    await waitFor(() => expect(attached[0].labelsData()).toEqual([]));
  });
});
