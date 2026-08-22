import { render, waitFor } from '@testing-library/react';
import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IChartApi, ISeriesApi, SeriesType } from 'lightweight-charts';
import type { AskPeak, BidPeak, Candle, RangeSegment } from '../api/types';
import type { PaneSeriesMap } from '../chart/drawing/chartCoordinates';
import type { PaneId } from '../chart/drawing/types';
import { AskPeakSegmentsPrimitive } from '../chart/AskPeakSegmentsPrimitive';
import type { PeakWallDockedLabelsPrimitive } from '../chart/PeakWallDockedLabelsPrimitive';
import type { VirtualAxis } from '../util/virtualAxis';
import { DEFAULT_PREFS, useChartPrefsStore } from '../state/chartPrefs';
import { useLivePageStore } from '../state/livePage';
import LiveAskPeakSegments, { buildAskPeakOverlaySegments } from './LiveAskPeakSegments';
import type { PeakDailyMaFilter } from './peakWallDailyMaFilter';
import LiveBidPeakSegments from './LiveBidPeakSegments';
import LivePeakWallDockedLabels from './LivePeakWallDockedLabels';

/**
 * 이동평균 필터의 **배선** 테스트. 순수 로직은 `peakWallMaFilter.test.ts` 가 덮고,
 * 여기서 재는 것은 「pref 를 실제로 읽어 렌더까지 닿는가」다 — 소비처가 셋이라
 * (선·도킹 라벨·고저 라벨 회피 rect) 한 곳만 배선이 빠져도 화면이 어긋난다.
 *
 * 모든 항목은 **양방향**이다: ON 이면 사라지고 OFF 면 남는 것을 같은 픽스처로 잰다.
 * 한 방향만 보면 「항상 통과」 하드코딩도 초록이 된다.
 */

const MIN = 60_000;
const DAY = '20260822';
const OPEN = 0;

const axis = {
  toVirtual: (ms: number) => ms,
  contains: () => true,
} as unknown as VirtualAxis;

function candle(ts_ms: number, close: number): Candle {
  return { ts_ms, open: close, high: close, low: close, close, vol_a: 0, vol_b: 0 };
}

// close 전부 100, 5봉 → period 3 의 SMA 는 인덱스 2 부터 100.
const CANDLES = [0, 1, 2, 3, 4].map((i) => candle(OPEN + i * MIN, 100));
const SEGMENTS: RangeSegment[] = [{
  date: DAY,
  session_open_ms: OPEN,
  session_close_ms: OPEN + 10 * MIN,
}];

/** MA(100) **아래**에 걸린 벽 — 매도 필터 ON 이면 사라지고, 매수 필터 ON 이면 남는다. */
function wallBelowMa(): AskPeak & BidPeak {
  return {
    date: DAY,
    price: 90,
    qty: 500,
    t_ms: OPEN + 4 * MIN,
    max_price: 90,
    max_qty: 500,
    max_t_ms: OPEN + 4 * MIN,
  };
}

/** MA(100) **위**에 걸린 벽 — 매수 필터 ON 이면 사라진다. */
function wallAboveMa(): AskPeak & BidPeak {
  return { ...wallBelowMa(), price: 110, max_price: 110 };
}

function makeSeries<T extends { attached: (...args: never[]) => void }>(attached: T[]) {
  const chart = {
    timeScale: () => ({
      getVisibleRange: () => ({ from: 0 as never, to: 600 as never }),
      options: () => ({ barSpacing: 12 }),
      subscribeVisibleLogicalRangeChange: vi.fn(),
      unsubscribeVisibleLogicalRangeChange: vi.fn(),
    }),
  } as unknown as IChartApi;
  const series = {
    attachPrimitive: vi.fn((primitive: T) => {
      attached.push(primitive);
      primitive.attached({
        chart,
        series: series as unknown as ISeriesApi<SeriesType>,
        requestUpdate: vi.fn(),
      } as never);
    }),
    detachPrimitive: vi.fn(),
  } as unknown as ISeriesApi<SeriesType>;
  return new Map([[('candle' as PaneId), series]]) as PaneSeriesMap;
}

beforeEach(() => {
  act(() => {
    useChartPrefsStore.setState({
      ...DEFAULT_PREFS,
      // 픽스처가 5봉뿐이라 기본 20 이면 SMA 가 전부 null(warm-up) 이 되어 필터가
      // fail-open 으로 통과해 버린다 — 그러면 이 테스트는 아무것도 재지 않는다.
      askPeakAboveMaPeriod: 3,
      bidPeakBelowMaPeriod: 3,
    });
    useLivePageStore.setState({ askPeakEnabled: true, bidPeakEnabled: true });
  });
});


/** 캔들 series 에는 이제 primitive 가 **둘** 붙는다 — 벽 세그먼트와 순위 화살표
 *  (`PeakWallRankArrowsPrimitive`). 인덱스로 집으면 부착 순서가 바뀌는 날 조용히 다른
 *  primitive 를 검사하므로, 인스턴스로 골라낸다. */
function segmentsOnly(attached: readonly unknown[]): AskPeakSegmentsPrimitive[] {
  return attached.filter((p): p is AskPeakSegmentsPrimitive => p instanceof AskPeakSegmentsPrimitive);
}

describe('매도 최대벽 선 — 이동평균선 위 벽만', () => {
  async function renderPrices(enabled: boolean, peak: AskPeak): Promise<number[]> {
    act(() => {
      useChartPrefsStore.setState({ askPeakAboveMaEnabled: enabled });
    });
    const attached: AskPeakSegmentsPrimitive[] = [];
    render(
      <LiveAskPeakSegments
        paneSeries={makeSeries(attached)}
        axis={axis}
        dayAskPeaks={[peak]}
        segments={SEGMENTS}
        candles={CANDLES}
        todayKst={DAY}
      />,
    );
    await waitFor(() => expect(segmentsOnly(attached)).toHaveLength(1));
    return segmentsOnly(attached)[0].segmentsData().map((s) => s.price);
  }

  it('ON 이면 MA 아래 벽이 사라진다', async () => {
    expect(await renderPrices(true, wallBelowMa())).toEqual([]);
  });

  it('OFF 면 같은 벽이 그대로 그려진다', async () => {
    expect(await renderPrices(false, wallBelowMa())).toEqual([90]);
  });

  it('ON 이어도 MA 위 벽은 남는다', async () => {
    expect(await renderPrices(true, wallAboveMa())).toEqual([110]);
  });
});

describe('매수 최대벽 선 — 이동평균선 아래 벽만(매도의 거울)', () => {
  async function renderPrices(enabled: boolean, peak: BidPeak): Promise<number[]> {
    act(() => {
      useChartPrefsStore.setState({ bidPeakBelowMaEnabled: enabled });
    });
    const attached: AskPeakSegmentsPrimitive[] = [];
    render(
      <LiveBidPeakSegments
        paneSeries={makeSeries(attached)}
        axis={axis}
        dayBidPeaks={[peak]}
        segments={SEGMENTS}
        candles={CANDLES}
        todayKst={DAY}
      />,
    );
    await waitFor(() => expect(segmentsOnly(attached)).toHaveLength(1));
    return segmentsOnly(attached)[0].segmentsData().map((s) => s.price);
  }

  it('ON 이면 MA 위 벽이 사라진다', async () => {
    expect(await renderPrices(true, wallAboveMa())).toEqual([]);
  });

  it('OFF 면 같은 벽이 그대로 그려진다', async () => {
    expect(await renderPrices(false, wallAboveMa())).toEqual([110]);
  });

  it('ON 이어도 MA 아래 벽은 남는다', async () => {
    expect(await renderPrices(true, wallBelowMa())).toEqual([90]);
  });
});

describe('도킹 라벨 — 선과 같은 필터를 탄다', () => {
  async function renderLabelPrices(enabled: boolean): Promise<number[]> {
    act(() => {
      useChartPrefsStore.setState({
        askPeakAboveMaEnabled: enabled,
        // 매수는 이 블록의 관심사가 아니다 — 켜 두면 같은 픽스처가 반대 방향으로 걸러져
        // 어느 쪽 배선이 재였는지 흐려진다.
        bidPeakBelowMaEnabled: false,
      });
    });
    const attached: PeakWallDockedLabelsPrimitive[] = [];
    render(
      <LivePeakWallDockedLabels
        paneSeries={makeSeries(attached)}
        axis={axis}
        dayAskPeaks={[wallBelowMa()]}
        dayBidPeaks={[]}
        segments={SEGMENTS}
        candles={CANDLES}
        todayKst={DAY}
      />,
    );
    await waitFor(() => expect(attached).toHaveLength(1));
    return attached[0].labelsData().map((label) => label.price);
  }

  it('ON 이면 선과 함께 라벨도 사라진다(라벨만 남는 유령 방지)', async () => {
    expect(await renderLabelPrices(true)).toEqual([]);
  });

  it('OFF 면 라벨이 그대로 남는다', async () => {
    expect(await renderLabelPrices(false)).toEqual([90]);
  });
});

describe('rank-then-filter 순서', () => {
  // 이 지표의 뜻은 「그날 최대벽 — 조건에 안 맞으면 감춤」이지 「조건에 맞는 벽 중 최대」가
  // 아니다. 순서가 뒤집히면 최대벽이 걸러질 때 2등 벽이 조용히 승격해, 화면의 선이 그날
  // 최대벽이라는 보장이 사라진다. 여기서 그 순서를 못박는다.
  it('최대벽이 걸러져도 2등 벽이 대신 올라오지 않는다', () => {
    const candidates = [
      { price: 90, qty: 900, t_ms: OPEN + 4 * MIN },   // 1등(수량) — MA 아래
      { price: 110, qty: 100, t_ms: OPEN + 4 * MIN },  // 2등 — MA 위
    ];
    const out = buildAskPeakOverlaySegments({
      // 최상위 필드는 MA **위**(110)로 둔다 — 순서를 뒤집었을 때 이 AskPeak 자체는 필터를
      // 통과하고, 그 안의 1등 후보(90)가 확장되어 살아남는 모습이 드러나야 red 가 된다.
      // 최상위까지 MA 아래로 두면 두 순서가 똑같이 빈 배열을 내 아무것도 재지 못한다.
      dayAskPeaks: [{ ...wallAboveMa(), traded_peaks: candidates, traded_max_peaks: candidates }],
      segments: SEGMENTS,
      candles: CANDLES,
      axis,
      todayKst: DAY,
      baselineStyle: { color: '#000', lineWidth: 1 },
      intraMax: false,
      allPriceRankLimit: 1,
      maFilter: { side: 'ask', period: 3 },
      dailyMaFilter: null,
    });
    // filter-then-rank 였다면 2등 110 이 승격해 길이 1 이 된다.
    expect(out).toEqual([]);
  });
});

/**
 * 일봉 MA 필터의 **배선** — 분봉 필터와 같은 양방향 규칙. 다만 이 필터는 데이터가 훅에서
 * 오므로(`usePeakDailyMaFilter`) pref 토글이 아니라 **필터 값 주입**으로 잰다: 소비처가
 * 받은 값을 실제로 쓰는지가 여기서 재는 것이고, pref → 값 변환은 훅의 몫이다.
 */
describe('일봉 MA 필터 — 선·라벨 배선', () => {
  const DAILY_MA: PeakDailyMaFilter = { side: 'ask', byDate: new Map([[DAY, 100]]) };

  async function renderSegmentPrices(dailyMaFilter: PeakDailyMaFilter | null, peak: AskPeak) {
    act(() => {
      // 분봉 필터는 끈다 — 켜 두면 어느 필터가 걸렀는지 구별되지 않는다.
      useChartPrefsStore.setState({ askPeakAboveMaEnabled: false });
    });
    const attached: AskPeakSegmentsPrimitive[] = [];
    render(
      <LiveAskPeakSegments
        paneSeries={makeSeries(attached)}
        axis={axis}
        dayAskPeaks={[peak]}
        segments={SEGMENTS}
        candles={CANDLES}
        todayKst={DAY}
        dailyMaFilter={dailyMaFilter}
      />,
    );
    await waitFor(() => expect(segmentsOnly(attached)).toHaveLength(1));
    return segmentsOnly(attached)[0].segmentsData().map((s) => s.price);
  }

  it('필터가 있으면 일봉 MA 아래 매도벽이 사라진다', async () => {
    expect(await renderSegmentPrices(DAILY_MA, wallBelowMa())).toEqual([]);
  });

  it('필터가 null 이면 같은 벽이 그대로 그려진다', async () => {
    expect(await renderSegmentPrices(null, wallBelowMa())).toEqual([90]);
  });

  it('필터가 있어도 일봉 MA 위 매도벽은 남는다', async () => {
    expect(await renderSegmentPrices(DAILY_MA, wallAboveMa())).toEqual([110]);
  });

  it('도킹 라벨도 같은 필터를 탄다(라벨만 남는 유령 방지)', async () => {
    act(() => {
      useChartPrefsStore.setState({ askPeakAboveMaEnabled: false, bidPeakBelowMaEnabled: false });
    });
    const attached: PeakWallDockedLabelsPrimitive[] = [];
    render(
      <LivePeakWallDockedLabels
        paneSeries={makeSeries(attached)}
        axis={axis}
        dayAskPeaks={[wallBelowMa()]}
        dayBidPeaks={[]}
        segments={SEGMENTS}
        candles={CANDLES}
        todayKst={DAY}
        askDailyMaFilter={DAILY_MA}
      />,
    );
    await waitFor(() => expect(attached).toHaveLength(1));
    expect(attached[0].labelsData().map((l) => l.price)).toEqual([]);
  });
});
