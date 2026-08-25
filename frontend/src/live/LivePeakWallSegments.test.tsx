import { beforeEach, describe, it, expect, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import type { IChartApi, ISeriesApi, SeriesType, Time } from 'lightweight-charts';
import type { PaneSeriesMap } from '../chart/drawing/chartCoordinates';
import type { PaneId } from '../chart/drawing/types';
import {
  PeakWallSegmentsPrimitive,
  type PeakWallLabelSide,
  type PeakWallSegment,
} from '../chart/PeakWallSegmentsPrimitive';
import { PeakWallRankArrowsPrimitive } from '../chart/PeakWallRankArrowsPrimitive';
import { readFlagLegendValues } from './indicators/flagLegendValueRegistry';
import { PEAK_WALL_LEGEND_RANK_LIMIT } from './peakWallVisibleRanking';
import LivePeakWallSegments from './LivePeakWallSegments';
import type { PeakWallRenderState } from './usePeakWallRender';

/** 하루치 벽 하나. `peakMs` 로 캔들 극값 맵과 이어진다. */
function seg(day: number, price: number, qty: number, peakSec: number): PeakWallSegment {
  return {
    time0: day as Time,
    time1: (day + 100) as Time,
    peakTime: peakSec as Time,
    price,
    qty,
    label: `${price}, ${qty}`,
    color: '#base',
    lineWidth: 2,
  };
}

const SEGMENTS: PeakWallSegment[] = [
  seg(0, 100, 1000, 50),
  seg(1000, 105, 3000, 1050),
  seg(2000, 110, 2000, 2050),
];
const EXTREMES = new Map([
  [50, { high: 101, low: 99 }],
  [1050, { high: 106, low: 104 }],
  [2050, { high: 111, low: 109 }],
]);

function wall(over: Partial<PeakWallRenderState> = {}): PeakWallRenderState {
  const segments = over.segments ?? SEGMENTS;
  return {
    segments,
    rankSegments: segments,
    stepSegments: SEGMENTS,
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
    ...over,
  };
}

/** 팬·줌 구독 여부를 재기 위한 모듈 스코프 spy — `timeScale()` 이 호출마다 새 객체를
 *  돌려주므로 안쪽에 `vi.fn()` 을 두면 호출 횟수를 못 센다. */
const subscribeRangeSpy = vi.fn();

function renderOverlay(side: PeakWallLabelSide, state: PeakWallRenderState = wall()) {
  const attached: unknown[] = [];
  const chart = {
    timeScale: () => ({
      // 세그먼트 그날 구간 전체를 덮는 범위.
      getVisibleRange: () => ({ from: -10 as never, to: 2200 as never }),
      options: () => ({ barSpacing: 12 }),
      subscribeVisibleLogicalRangeChange: subscribeRangeSpy,
      unsubscribeVisibleLogicalRangeChange: vi.fn(),
    }),
  } as unknown as IChartApi;
  const series = {
    attachPrimitive: vi.fn((primitive: PeakWallSegmentsPrimitive) => {
      attached.push(primitive);
      primitive.attached({
        chart,
        series: series as unknown as ISeriesApi<SeriesType>,
        requestUpdate: vi.fn(),
      } as unknown as Parameters<PeakWallSegmentsPrimitive['attached']>[0]);
    }),
    detachPrimitive: vi.fn(),
  } as unknown as ISeriesApi<SeriesType>;
  const paneSeries = new Map([[('candle' as PaneId), series]]) as PaneSeriesMap;
  render(
    <LivePeakWallSegments
      paneSeries={paneSeries}
      side={side}
      wall={state}
      candleExtremes={EXTREMES}
    />,
  );
  return attached;
}

const segmentsOnly = (a: readonly unknown[]) =>
  a.filter((p): p is PeakWallSegmentsPrimitive => p instanceof PeakWallSegmentsPrimitive);
const arrowsOnly = (a: readonly unknown[]) =>
  a.filter((p): p is PeakWallRankArrowsPrimitive => p instanceof PeakWallRankArrowsPrimitive);
// attach 순서 = [전체 최대벽, 미도달 벽, 체결된 벽] — 하위 선이 먼저 붙어 체결된 벽이 위에 그려진다.
const allWallPrimOf = (a: readonly unknown[]) => segmentsOnly(a)[0];
const unreachedPrimOf = (a: readonly unknown[]) => segmentsOnly(a)[1];
const tradedPrimOf = (a: readonly unknown[]) => segmentsOnly(a)[2];

/**
 * **매도·매수 공용 오버레이의 배선**(2026-08-23).
 *
 * 계산은 `usePeakWallRender` 가 `LiveChartRoot` 에서 한 번 하고, 이 컴포넌트는 그 결과를
 * primitive 둘과 레전드 provider 에 나눠 준다. 그래서 여기서 재는 것은 **배선뿐**이다 —
 * 세그먼트 계산은 `peakWallSegments.test.ts`, 랭킹은 `peakWallVisibleRanking.test.ts`,
 * 화살표 앵커는 `peakWallRankArrows.test.ts` 가 각각 본다.
 */
describe('LivePeakWallSegments', () => {
  beforeEach(() => {
    subscribeRangeSpy.mockClear();
  });

  it('그려질 때 선과 화살표를 모두 세운다', async () => {
    const attached = renderOverlay('ask');
    await waitFor(() => {
      expect(tradedPrimOf(attached).segmentsData()).toHaveLength(3);
      expect(arrowsOnly(attached)[0].arrowsData()).toHaveLength(3);
      expect(arrowsOnly(attached)[0].rankLimit()).toBe(PEAK_WALL_LEGEND_RANK_LIMIT);
    });
  });

  it('전체 최대벽 선은 allWallDrawn 을 따라 전용 primitive 에 세워진다', async () => {
    const allSegments = [seg(0, 95, 4000, 50)];
    const attached = renderOverlay('ask', wall({
      allWallSegments: allSegments,
      allWallDrawn: true,
    }));
    await waitFor(() => {
      expect(allWallPrimOf(attached).segmentsData()).toHaveLength(1);
      expect(tradedPrimOf(attached).segmentsData()).toHaveLength(3);
    });

    const off = renderOverlay('ask', wall({
      allWallSegments: allSegments,
      allWallDrawn: false,
    }));
    await waitFor(() => {
      expect(tradedPrimOf(off).segmentsData()).toHaveLength(3);
    });
    expect(allWallPrimOf(off).segmentsData()).toEqual([]);
  });

  it('매도는 봉 고가에, 매수는 봉 저가에 화살표를 매단다', async () => {
    const askAttached = renderOverlay('ask');
    await waitFor(() => expect(arrowsOnly(askAttached)).toHaveLength(1));
    expect(arrowsOnly(askAttached)[0].arrowsData().map((a) => a.anchorPrice))
      .toEqual([101, 106, 111]);

    const bidAttached = renderOverlay('bid');
    await waitFor(() => expect(arrowsOnly(bidAttached)).toHaveLength(1));
    expect(arrowsOnly(bidAttached)[0].arrowsData().map((a) => a.anchorPrice))
      .toEqual([99, 104, 109]);
  });

  /**
   * **눈(hidden)은 선·화살표만 지우고 레전드 값은 살린다** — MA 의 "hide 는 선만 숨긴다"
   * 규칙 미러. 훅이 `enabled` 기준으로만 세그먼트를 계산하는 불변식이 여기서 드러난다:
   * `drawn=false` 여도 `segments` 는 채워져 온다.
   */
  it('drawn=false 면 선·화살표는 비지만 레전드 값은 남는다', async () => {
    const attached = renderOverlay('ask', wall({ drawn: false, labels: false, arrows: false }));
    await waitFor(() => {
      expect(tradedPrimOf(attached).segmentsData()).toEqual([]);
      expect(arrowsOnly(attached)[0].arrowsData()).toEqual([]);
      expect(readFlagLegendValues(null, 'ask-peak', 'main', null)).toHaveLength(3);
    });
  });

  it('화살표만 끄면 선은 남는다', async () => {
    const attached = renderOverlay('ask', wall({ arrows: false }));
    await waitFor(() => {
      expect(tradedPrimOf(attached).segmentsData()).toHaveLength(3);
      expect(arrowsOnly(attached)[0].arrowsData()).toEqual([]);
    });
  });

  it('레전드·화살표는 rankSegments(체결된 벽 ∪ 전체 벽)를 같은 집합으로 받는다', async () => {
    // 전체 벽(95, qty 4000)이 체결된 벽 셋(1000·2000·3000)을 제치고 1위가 되는 병합 집합.
    const allWallSeg = seg(0, 95, 4000, 50);
    const attached = renderOverlay('ask', wall({
      rankSegments: [...SEGMENTS, allWallSeg],
      allWallSegments: [allWallSeg],
      allWallDrawn: true,
    }));
    await waitFor(() => {
      expect(readFlagLegendValues(null, 'ask-peak', 'main', null)[0]).toMatchObject({
        label: '1',
        value: '95, 4k',
      });
      // 화살표도 같은 집합에서 나온다 — 병합분 포함 4개.
      expect(arrowsOnly(attached)[0].arrowsData()).toHaveLength(4);
    });
  });

  it('미도달 벽 선은 unreachedDrawn 을 따라 전용 primitive 에 세워진다', async () => {
    const unreachedSeg = [seg(0, 130, 500, 50)];
    const attached = renderOverlay('ask', wall({
      unreachedSegments: unreachedSeg,
      unreachedDrawn: true,
    }));
    await waitFor(() => {
      expect(unreachedPrimOf(attached).segmentsData()).toHaveLength(1);
      expect(tradedPrimOf(attached).segmentsData()).toHaveLength(3);
    });

    const off = renderOverlay('ask', wall({
      unreachedSegments: unreachedSeg,
      unreachedDrawn: false,
    }));
    await waitFor(() => {
      expect(tradedPrimOf(off).segmentsData()).toHaveLength(3);
    });
    expect(unreachedPrimOf(off).segmentsData()).toEqual([]);
  });

  it('레전드는 보이는 영역 잔량 상위 3개를 순위 순으로 낸다', async () => {
    const attached = renderOverlay('bid');
    await waitFor(() => expect(segmentsOnly(attached)).toHaveLength(3));
    await waitFor(() => {
      expect(readFlagLegendValues(null, 'bid-peak', 'main', null)).toEqual([
        { key: 'bid-peak-1', label: '1', value: '105, 3k' },
        { key: 'bid-peak-2', label: '2', value: '110, 2k' },
        { key: 'bid-peak-3', label: '3', value: '100, 1k' },
      ]);
    });
  });

  /**
   * **팬·줌을 구독하지 않는다.** 이 컴포넌트의 계산에는 보이는 범위가 들어가지 않는다 —
   * 팬에 따라가야 하는 것들(레전드 셀 · 순위 화살표 · 고저 라벨 회피)은 전부 **draw 시점
   * 랭킹**이다. 도킹 라벨은 줌 예산 때문에 구독이 필요하고 그쪽에만 있다.
   *
   * ⚠ 범위를 읽는 입력을 다시 넣으면 구독도 되살려야 하고, 그때 이 테스트를 뒤집는다.
   */
  it('visibleLogicalRangeChange 를 구독하지 않는다', async () => {
    const attached = renderOverlay('ask');
    await waitFor(() => expect(segmentsOnly(attached)).toHaveLength(3));
    expect(subscribeRangeSpy).not.toHaveBeenCalled();
  });
});
