import { describe, expect, it } from 'vitest';
import type { AskPeak, Candle } from '../api/types';
import type { VirtualAxis } from '../util/virtualAxis';
import { candleIndexAtOrBefore, filterPeaksAgainstMa } from './peakWallMaFilter';

const MIN = 60_000;

/** 항등 축 + 세션 판정. `inSessionFrom` 부터를 세션 안으로 본다(기본: 전부). */
function makeAxis(inSessionFrom = Number.NEGATIVE_INFINITY): VirtualAxis {
  return {
    toVirtual: (ms: number) => ms,
    contains: (ms: number) => ms >= inSessionFrom,
  } as unknown as VirtualAxis;
}

function candle(ts_ms: number, close: number): Candle {
  return { ts_ms, open: close, high: close, low: close, close, vol_a: 0, vol_b: 0 };
}

/** close 가 전부 100 인 5분봉 — period 3 이면 sma = [null, null, 100, 100, 100]. */
const CANDLES = [0, 1, 2, 3, 4].map((i) => candle(i * MIN, 100));

function peak(price: number, tMs: number, over: Partial<AskPeak> = {}): AskPeak {
  return {
    date: '20260822',
    price,
    qty: 1000,
    t_ms: tMs,
    max_price: price,
    max_qty: 1000,
    max_t_ms: tMs,
    ...over,
  };
}

const ASK = { side: 'ask' as const, period: 3 };
const BID = { side: 'bid' as const, period: 3 };

describe('candleIndexAtOrBefore', () => {
  it('tMs 이하 마지막 인덱스를 낸다 — 봉 경계 안쪽 시각은 그 봉으로', () => {
    expect(candleIndexAtOrBefore(CANDLES, 3 * MIN)).toBe(3);
    expect(candleIndexAtOrBefore(CANDLES, 3 * MIN + 59_000)).toBe(3);
    expect(candleIndexAtOrBefore(CANDLES, 4 * MIN + 999_999)).toBe(4);
  });

  it('첫 캔들보다 앞선 시각은 -1(판정 불가)', () => {
    expect(candleIndexAtOrBefore(CANDLES, -1)).toBe(-1);
  });
});

describe('filterPeaksAgainstMa — 방향', () => {
  it('매도: MA 위 벽만 남긴다', () => {
    const out = filterPeaksAgainstMa(
      [peak(101, 4 * MIN), peak(99, 4 * MIN)],
      CANDLES, makeAxis(), false, ASK,
    );
    expect(out.map((p) => p.price)).toEqual([101]);
  });

  it('매수: MA 아래 벽만 남긴다(매도의 거울)', () => {
    const out = filterPeaksAgainstMa(
      [peak(101, 4 * MIN), peak(99, 4 * MIN)],
      CANDLES, makeAxis(), false, BID,
    );
    expect(out.map((p) => p.price)).toEqual([99]);
  });

  it('MA 와 정확히 같은 가격은 "위"도 "아래"도 아니다 — 양쪽 다 제외', () => {
    expect(filterPeaksAgainstMa([peak(100, 4 * MIN)], CANDLES, makeAxis(), false, ASK)).toEqual([]);
    expect(filterPeaksAgainstMa([peak(100, 4 * MIN)], CANDLES, makeAxis(), false, BID)).toEqual([]);
  });
});

describe('filterPeaksAgainstMa — fail-open(판정 불가는 남긴다)', () => {
  it('filter=null 이면 손대지 않는다', () => {
    const peaks = [peak(1, 4 * MIN), peak(1_000_000, 4 * MIN)];
    expect(filterPeaksAgainstMa(peaks, CANDLES, makeAxis(), false, null)).toEqual(peaks);
  });

  it('warm-up 구간(평균낼 봉 부족)의 벽은 MA 아래여도 남는다', () => {
    // 인덱스 1 = sma null(period 3). 가격 1 은 MA 100 아래지만 판정하지 않는다.
    const out = filterPeaksAgainstMa([peak(1, 1 * MIN)], CANDLES, makeAxis(), false, ASK);
    expect(out.map((p) => p.price)).toEqual([1]);
  });

  it('로딩된 캔들보다 앞선 벽은 남는다', () => {
    const out = filterPeaksAgainstMa([peak(1, -1)], CANDLES, makeAxis(), false, ASK);
    expect(out.map((p) => p.price)).toEqual([1]);
  });

  it('캔들이 아예 없으면 손대지 않는다', () => {
    const peaks = [peak(1, 4 * MIN)];
    expect(filterPeaksAgainstMa(peaks, [], makeAxis(), false, ASK)).toEqual(peaks);
  });

  it('가격·시각이 유한하지 않은 벽은 남긴다', () => {
    const broken = peak(0, 0, { price: null, t_ms: null, max_price: null, max_t_ms: null });
    expect(filterPeaksAgainstMa([broken], CANDLES, makeAxis(), false, ASK)).toEqual([broken]);
  });
});

describe('filterPeaksAgainstMa — 축 정렬', () => {
  // 이 리포가 실제로 밟을 수 있는 함정: 호출부가 넘기는 candles 는 axis.contains 로 거르기
  // **전** 원본이다. MovingAverageOverlay 는 거른 배열 위에서 SMA 를 그리므로, 여기서 같은
  // 필터를 적용하지 않으면 인덱스가 밀려 화면의 선과 판정이 갈린다.
  it('세션 밖 캔들을 뺀 배열 기준으로 SMA 인덱스를 잡는다', () => {
    // 앞 3봉은 세션 밖(close 1), 뒤 3봉이 세션 안(close 100·100·100).
    const candles = [
      candle(0, 1), candle(1 * MIN, 1), candle(2 * MIN, 1),
      candle(3 * MIN, 100), candle(4 * MIN, 100), candle(5 * MIN, 100),
    ];
    const axis = makeAxis(3 * MIN);
    // 세션 안 배열은 [100,100,100] → period 3 의 sma = [null, null, 100].
    // 마지막 봉(5*MIN)의 MA 는 100 이므로 101 은 살고 99 는 죽는다.
    expect(filterPeaksAgainstMa([peak(101, 5 * MIN)], candles, axis, false, ASK)).toHaveLength(1);
    expect(filterPeaksAgainstMa([peak(99, 5 * MIN)], candles, axis, false, ASK)).toHaveLength(0);
    // 거르지 않았다면 6봉 전체 sma 의 인덱스 5 = (1+100+100)/3 = 67 이 되어 99 도 살아남는다.
    // 세션 밖 봉이 섞이면 판정이 뒤집힌다는 것을 여기서 못박는다.
  });

  it('세션 안 캔들이 하나도 없으면 손대지 않는다', () => {
    const peaks = [peak(1, 4 * MIN)];
    expect(filterPeaksAgainstMa(peaks, CANDLES, makeAxis(Number.POSITIVE_INFINITY), false, ASK))
      .toEqual(peaks);
  });
});

describe('filterPeaksAgainstMa — intraMax 축 선택', () => {
  it('intraMax 면 max_price/max_t_ms 로 판정한다', () => {
    // close 축은 MA 위(101), max 축은 MA 아래(99) — 켜고 끄면 결과가 뒤집혀야 한다.
    const p = peak(101, 4 * MIN, { max_price: 99, max_t_ms: 4 * MIN });
    expect(filterPeaksAgainstMa([p], CANDLES, makeAxis(), false, ASK)).toHaveLength(1);
    expect(filterPeaksAgainstMa([p], CANDLES, makeAxis(), true, ASK)).toHaveLength(0);
  });
});
