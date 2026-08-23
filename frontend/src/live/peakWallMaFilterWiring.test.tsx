import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AskPeak, BidPeak, Candle, RangeSegment } from '../api/types';
import type { PeakWallLabelSide } from '../chart/PeakWallSegmentsPrimitive';
import type { VirtualAxis } from '../util/virtualAxis';
import { DEFAULT_PREFS, useChartPrefsStore } from '../state/chartPrefs';
import { useLivePageStore } from '../state/livePage';
import { buildPeakWallOverlaySegments } from './peakWallSegments';
import type { PeakDailyMaFilter } from './peakWallDailyMaFilter';
import { usePeakWallRender } from './usePeakWallRender';

/**
 * 이동평균 필터의 **배선** 테스트. 순수 로직은 `peakWallMaFilter.test.ts` 가 덮고,
 * 여기서 재는 것은 「pref 를 실제로 읽어 세그먼트까지 닿는가」다.
 *
 * 2026-08-23 부터 그 배선은 **`usePeakWallRender` 한 곳**에 있다. 종전엔 소비처가 셋이라
 * (선·도킹 라벨·고저 라벨 회피) 셋을 각각 렌더해 확인해야 했고, 실제로 회피 경로만
 * `allPriceRankLimit` 을 빠뜨린 채 살아 있었다. 이제 훅 하나를 재면 셋이 함께 덮인다 —
 * 셋이 **같은 참조**를 받기 때문이다(타입이 강제한다).
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


/** 훅을 그대로 돌려 세그먼트 가격 목록을 낸다. 선·도킹 라벨·회피가 **같은 이 값**을 받는다. */
function renderPrices(
  side: PeakWallLabelSide,
  peak: AskPeak & BidPeak,
  dailyMaFilter: PeakDailyMaFilter | null = null,
): number[] {
  const { result } = renderHook(() => usePeakWallRender({
    side,
    peaks: [peak],
    segments: SEGMENTS,
    candles: CANDLES,
    axis,
    todayKst: DAY,
    applicable: true,
    visibleTimeCutoff: null,
    dailyMaFilter,
  }));
  return result.current.segments.map((s) => s.price);
}

beforeEach(() => {
  act(() => {
    useChartPrefsStore.setState({ ...DEFAULT_PREFS });
    useLivePageStore.setState({ askPeakEnabled: true, bidPeakEnabled: true });
  });
});

describe('매도 최대벽 — 이동평균선 위 벽만', () => {
  const on = () => act(() => {
    useChartPrefsStore.setState({ askPeakAboveMaEnabled: true, askPeakAboveMaPeriod: 3 });
  });
  const off = () => act(() => {
    useChartPrefsStore.setState({ askPeakAboveMaEnabled: false });
  });

  it('ON 이면 MA 아래 벽이 사라진다', () => {
    on();
    expect(renderPrices('ask', wallBelowMa())).toEqual([]);
  });

  it('OFF 면 같은 벽이 그대로 남는다', () => {
    off();
    expect(renderPrices('ask', wallBelowMa())).toEqual([90]);
  });

  it('ON 이어도 MA 위 벽은 남는다', () => {
    on();
    expect(renderPrices('ask', wallAboveMa())).toEqual([110]);
  });
});

describe('매수 최대벽 — 이동평균선 아래 벽만(매도의 거울)', () => {
  const on = () => act(() => {
    useChartPrefsStore.setState({ bidPeakBelowMaEnabled: true, bidPeakBelowMaPeriod: 3 });
  });
  const off = () => act(() => {
    useChartPrefsStore.setState({ bidPeakBelowMaEnabled: false });
  });

  it('ON 이면 MA 위 벽이 사라진다', () => {
    on();
    expect(renderPrices('bid', wallAboveMa())).toEqual([]);
  });

  it('OFF 면 같은 벽이 그대로 남는다', () => {
    off();
    expect(renderPrices('bid', wallAboveMa())).toEqual([110]);
  });

  it('ON 이어도 MA 아래 벽은 남는다', () => {
    on();
    expect(renderPrices('bid', wallBelowMa())).toEqual([90]);
  });
});

describe('일봉 MA 필터', () => {
  const DAILY: PeakDailyMaFilter = { side: 'ask', byDate: new Map([[DAY, 100]]) };

  beforeEach(() => {
    // 분봉 필터는 끈다 — 켜 두면 어느 필터가 걸렀는지 구별되지 않는다.
    act(() => {
      useChartPrefsStore.setState({ askPeakAboveMaEnabled: false });
    });
  });

  it('필터가 있으면 일봉 MA 아래 매도벽이 사라진다', () => {
    expect(renderPrices('ask', wallBelowMa(), DAILY)).toEqual([]);
  });

  it('필터가 null 이면 같은 벽이 그대로 남는다', () => {
    expect(renderPrices('ask', wallBelowMa(), null)).toEqual([90]);
  });

  it('필터가 있어도 일봉 MA 위 매도벽은 남는다', () => {
    expect(renderPrices('ask', wallAboveMa(), DAILY)).toEqual([110]);
  });
});

/**
 * **rank-then-filter 순서** — 그날 최대벽을 먼저 뽑고 그중 조건에 맞는 것만 남긴다.
 * 반대로 걸면(filter-then-rank) 지표의 뜻이 "그날 최대벽" 에서 "MA 위 벽 중 최대" 로
 * 바뀌어, 최대벽이 조건에 걸리면 2등 벽이 대신 올라온다.
 */
describe('rank-then-filter 순서', () => {
  it('최대벽이 걸러져도 2등 벽이 대신 올라오지 않는다', () => {
    const candidates = [
      { price: 90, qty: 900, t_ms: OPEN + 4 * MIN },   // 최대 — MA 아래라 걸러진다
      { price: 110, qty: 100, t_ms: OPEN + 4 * MIN },  // 2등 — MA 위
    ];
    const out = buildPeakWallOverlaySegments({
      peaks: [{ ...wallAboveMa(), traded_peaks: candidates, traded_max_peaks: candidates }],
      segments: SEGMENTS,
      candles: CANDLES,
      axis,
      todayKst: DAY,
      baselineStyle: { color: '#fff', lineWidth: 1 },
      intraMax: false,
      maFilter: { side: 'ask', period: 3 },
      dailyMaFilter: null,
    });
    // filter-then-rank 였다면 2등 110 이 승격해 길이 1 이 된다.
    expect(out).toEqual([]);
  });
});

/**
 * **회피 경로가 「체결된 벽 표시 개수」를 따라간다** (2026-08-23 수정).
 *
 * 종전엔 고저 극값 라벨의 회피 입력만 `allPriceRankLimit` 을 넘기지 않아 **기본값 1** 로
 * 돌았다. 그래서 그 값을 2·3 으로 둔 사용자는 2·3번째 벽이 그려지는데도 극값 라벨이
 * 그것들을 피하지 않았다. 이제 셋이 같은 훅 결과를 쓰므로 원리적으로 갈릴 수 없다.
 *
 * **막는 방향**: 어느 소비처가 다시 자기 인자로 계산을 돌리는 것.
 * **못 보는 것**: 회피 rect 의 기하 — `HighLowLabelsPrimitive.test.ts` 가 본다.
 */
describe('체결된 벽 표시 개수가 세그먼트 수를 정한다', () => {
  const candidates = [
    { price: 100, qty: 900, t_ms: OPEN + 2 * MIN },
    { price: 101, qty: 800, t_ms: OPEN + 3 * MIN },
    { price: 102, qty: 700, t_ms: OPEN + 4 * MIN },
  ];
  const peak = () => ({
    ...wallAboveMa(),
    traded_peaks: candidates,
    traded_max_peaks: candidates,
  });

  it('1 이면 하루에 한 개, 3 이면 세 개', () => {
    act(() => {
      useChartPrefsStore.setState({ askPeakAllPriceRankLimit: 1 });
    });
    expect(renderPrices('ask', peak())).toHaveLength(1);
    act(() => {
      useChartPrefsStore.setState({ askPeakAllPriceRankLimit: 3 });
    });
    expect(renderPrices('ask', peak())).toHaveLength(3);
  });
});
