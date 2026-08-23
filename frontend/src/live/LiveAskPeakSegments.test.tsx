import { beforeEach, describe, it, expect, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { act } from 'react';
import type { IChartApi, ISeriesApi, SeriesType } from 'lightweight-charts';
import type { PaneSeriesMap } from '../chart/drawing/chartCoordinates';
import type { PaneId } from '../chart/drawing/types';
import { AskPeakSegmentsPrimitive } from '../chart/AskPeakSegmentsPrimitive';
import { PeakWallRankArrowsPrimitive } from '../chart/PeakWallRankArrowsPrimitive';
import { DEFAULT_PREFS, useChartPrefsStore } from '../state/chartPrefs';
import { useLivePageStore } from '../state/livePage';
import { readFlagLegendValues } from './indicators/flagLegendValueRegistry';
import { PEAK_WALL_LEGEND_RANK_LIMIT } from './peakWallVisibleRanking';
import LiveAskPeakSegments from './LiveAskPeakSegments';
import type { AskPeak, RangeSegment, Candle } from '../api/types';
import type { VirtualAxis } from '../util/virtualAxis';

// 순수 빌더 테스트는 `peakWallSegments.test.ts` 로 옮겼다(2026-08-23, 매도·매수 통합).
// 여기 남는 것은 **이 컴포넌트의 배선**뿐이다 — 레전드 provider 와 순위 화살표 primitive.
const axis = { toVirtual: (ms: number) => ms, contains: () => true } as unknown as VirtualAxis;

/** 캔들 series 에는 이제 primitive 가 **둘** 붙는다 — 벽 세그먼트와 순위 화살표
 *  (`PeakWallRankArrowsPrimitive`). 인덱스로 집으면 부착 순서가 바뀌는 날 조용히 다른
 *  primitive 를 검사하므로, 인스턴스로 골라낸다. */
function segmentsOnly(attached: readonly unknown[]): AskPeakSegmentsPrimitive[] {
  return attached.filter((p): p is AskPeakSegmentsPrimitive => p instanceof AskPeakSegmentsPrimitive);
}

function arrowsOnly(attached: readonly unknown[]): PeakWallRankArrowsPrimitive[] {
  return attached.filter(
    (p): p is PeakWallRankArrowsPrimitive => p instanceof PeakWallRankArrowsPrimitive,
  );
}


/**
 * **레전드 값 provider — 보이는 영역 잔량 상위 3개**(2026-08-22).
 *
 * provider 가 랭킹하는 대상은 `updateSegments` 가 **필터를 모두 통과시킨 뒤** ref 에
 * 넣은 집합이다. 그래서 레전드는 화면에 그려진(그려질) 벽만 이름 부른다 — 「체결된 벽
 * 표시 개수」로 잘려 나간 4번째 벽은 레전드에도 없다.
 *
 * **막는 방향**: (1) provider 가 필터 **전** 집합을 잡는 것, (2) 눈(hidden)이 선과 함께
 * 레전드 값까지 지우는 것(MA 의 "hide 는 선만 숨긴다" 규칙 위반).
 * **못 보는 것**: 랭킹 규칙 자체 — `peakWallVisibleRanking.test.ts` 가 잡는다.
 */
  const day = '20260613';
const open = 60_000;

/** 봉마다 **고가를 다르게** 둔다 — 화살표가 자기 봉의 고가에 매달리는지(공통값이면
 *  어느 봉을 집든 통과한다) 구별하기 위해서다. close 는 100 고정: MA 필터 조건을
 *  건드리면 레전드 테스트의 벽 3개 구성이 바뀐다. */
function legendCandle(ts_ms: number): Candle {
  const high = 100 + (ts_ms - open) / 60_000;
  return { ts_ms, open: 100, high, low: 99, close: 100, vol_a: 1, vol_b: 0 };
}

// 하루에 벽 후보 4개. 「체결된 벽 표시 개수」 3 이라 잔량 하위 1개(500)는 그려지지도,
// 레전드에 오르지도 않아야 한다.
const candidates = [
  { price: 100, qty: 1000, t_ms: open },
  { price: 105, qty: 3000, t_ms: open + 60_000 },
  { price: 110, qty: 2000, t_ms: open + 120_000 },
  { price: 115, qty: 500, t_ms: open + 120_000 },
];
const askPeak: AskPeak = {
  date: day,
  price: 100,
  qty: 1000,
  t_ms: open,
  max_price: 100,
  max_qty: 1000,
  max_t_ms: open,
  traded_peaks: candidates,
  traded_max_peaks: candidates,
};
const rangeSegments: RangeSegment[] = [
  { date: day, session_open_ms: open, session_close_ms: open + 180_000 },
];

function renderAskOverlay() {
  // 이 series 에는 primitive 가 둘 붙는다(세그먼트 + 순위 화살표) — 둘 다 모아 두고
// 검사할 때 인스턴스로 골라낸다.
const attached: unknown[] = [];
  const chart = {
    timeScale: () => ({
      // 가상초 = ms / 1000 → 그날 구간은 [60, 240]. 범위가 그 날을 통째로 덮는다.
      getVisibleRange: () => ({ from: 60 as never, to: 240 as never }),
      options: () => ({ barSpacing: 12 }),
      subscribeVisibleLogicalRangeChange: vi.fn(),
      unsubscribeVisibleLogicalRangeChange: vi.fn(),
    }),
  } as unknown as IChartApi;
  const series = {
    attachPrimitive: vi.fn((primitive: AskPeakSegmentsPrimitive) => {
      attached.push(primitive);
      primitive.attached({
        chart,
        series: series as unknown as ISeriesApi<SeriesType>,
        requestUpdate: vi.fn(),
      } as unknown as Parameters<AskPeakSegmentsPrimitive['attached']>[0]);
    }),
    detachPrimitive: vi.fn(),
  } as unknown as ISeriesApi<SeriesType>;
  const paneSeries = new Map([[('candle' as PaneId), series]]) as PaneSeriesMap;
  render(
    <LiveAskPeakSegments
      paneSeries={paneSeries}
      axis={axis}
      dayAskPeaks={[askPeak]}
      segments={rangeSegments}
      candles={[legendCandle(open), legendCandle(open + 60_000), legendCandle(open + 120_000)]}
      todayKst={day}
    />,
  );
  return attached;
}

describe('LiveAskPeakSegments — 레전드 값 provider', () => {
  beforeEach(() => {
    act(() => {
      useChartPrefsStore.setState({ ...DEFAULT_PREFS, askPeakAllPriceRankLimit: 3 });
      useLivePageStore.setState({ askPeakEnabled: true, askPeakHidden: false });
    });
  });

  it('그려진 벽만 잔량 내림차순 상위 3개로 레전드에 올린다', async () => {
    const attached = renderAskOverlay();
    await waitFor(() => expect(segmentsOnly(attached)).toHaveLength(1));
    await waitFor(() => {
      expect(readFlagLegendValues(null, 'ask-peak', null)).toEqual([
        { key: 'ask-peak-1', label: '1', value: '105, 3k' },
        { key: 'ask-peak-2', label: '2', value: '110, 2k' },
        { key: 'ask-peak-3', label: '3', value: '100, 1k' },
      ]);
    });
  });

  it('눈(hidden)은 선만 지우고 레전드 값은 살린다', async () => {
    act(() => {
      useLivePageStore.setState({ askPeakHidden: true });
    });
    const attached = renderAskOverlay();
    await waitFor(() => expect(segmentsOnly(attached)).toHaveLength(1));
    await waitFor(() => {
      expect(segmentsOnly(attached)[0].segmentsData()).toEqual([]);
      expect(readFlagLegendValues(null, 'ask-peak', null)).toHaveLength(3);
    });
  });

  it('지표를 끄면(enabled=false) 선도 레전드 값도 없다', async () => {
    act(() => {
      useLivePageStore.setState({ askPeakEnabled: false });
    });
    const attached = renderAskOverlay();
    await waitFor(() => expect(segmentsOnly(attached)).toHaveLength(1));
    await waitFor(() => {
      expect(segmentsOnly(attached)[0].segmentsData()).toEqual([]);
      expect(readFlagLegendValues(null, 'ask-peak', null)).toEqual([]);
    });
  });
});

/**
 * **순위 화살표 배선**(2026-08-23).
 *
 * primitive 는 세그먼트를 그리는 것과 **따로** 붙는다 — 앵커가 벽 가격이 아니라 캔들
 * 극값이고 설정으로 따로 끌 수 있어야 해서다. 여기서 재는 것은 배선뿐이다: 상위 3개
 * 선정은 draw 시점이라 primitive 안이고(`peakWallVisibleRanking`), 앵커 규칙은
 * `peakWallRankArrows.test.ts` 가 잡는다.
 *
 * **막는 방향**: (1) 화살표 primitive 가 아예 안 붙거나 빈 채로 남는 것,
 * (2) 눈(hidden)·설정 OFF 가 화살표에 안 먹는 것.
 */
describe('LiveAskPeakSegments — 순위 화살표 배선', () => {
  beforeEach(() => {
    act(() => {
      useChartPrefsStore.setState({ ...DEFAULT_PREFS, askPeakAllPriceRankLimit: 3 });
      useLivePageStore.setState({ askPeakEnabled: true, askPeakHidden: false });
    });
  });

  async function arrowPrimitive() {
    const attached = renderAskOverlay();
    await waitFor(() => expect(arrowsOnly(attached)).toHaveLength(1));
    return arrowsOnly(attached)[0];
  }

  it('그려진 벽마다 화살표를 넘기고 순위 컷은 3 이다', async () => {
    const prim = await arrowPrimitive();
    await waitFor(() => {
      // 「체결된 벽 표시 개수」 3 → 후보 4개 중 3개만 그려지고 화살표도 그 3개.
      // 앵커는 **각자 발생한 봉의 고가** 다: 잔량 3000(+60s)→101, 2000(+120s)→102,
      // 1000(open)→100. 공통값이면 어느 봉을 집어도 통과하므로 봉마다 갈라 뒀다.
      expect(prim.arrowsData().map((a) => a.anchorPrice)).toEqual([101, 102, 100]);
      expect(prim.rankLimit()).toBe(PEAK_WALL_LEGEND_RANK_LIMIT);
    });
  });

  it('눈(hidden)은 화살표도 지운다 — 선과 함께 사라지는 그리기다', async () => {
    act(() => {
      useLivePageStore.setState({ askPeakHidden: true });
    });
    const prim = await arrowPrimitive();
    await waitFor(() => expect(prim.arrowsData()).toEqual([]));
  });

  it('「상위벽 순위 화살표」 설정을 끄면 선은 남고 화살표만 사라진다', async () => {
    act(() => {
      useChartPrefsStore.setState({ askPeakRankArrowEnabled: false });
    });
    const attached = renderAskOverlay();
    await waitFor(() => expect(arrowsOnly(attached)).toHaveLength(1));
    await waitFor(() => {
      expect(arrowsOnly(attached)[0].arrowsData()).toEqual([]);
      expect(segmentsOnly(attached)[0].segmentsData().length).toBeGreaterThan(0);
    });
  });
});
