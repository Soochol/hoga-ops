import { describe, expect, it } from 'vitest';
import type { Time } from 'lightweight-charts';
import type { Candle } from '../api/types';
import type { PeakWallSegment } from '../chart/AskPeakSegmentsPrimitive';
import type { VirtualAxis } from '../util/virtualAxis';
import { candleExtremesByVirtualSec, peakWallRankArrowsFromSegments } from './peakWallRankArrows';

// 항등 축: toVirtual(ms)=ms → 가상초 = ms/1000.
const axis = { toVirtual: (ms: number) => ms } as unknown as VirtualAxis;

function candle(ts_ms: number, high: number, low: number): Candle {
  return { ts_ms, open: (high + low) / 2, high, low, close: (high + low) / 2, vol_a: 1, vol_b: 0 };
}

function segment(peakMs: number, price: number, qty: number): PeakWallSegment {
  return {
    time0: 0 as Time,
    time1: 1000 as Time,
    peakTime: (peakMs / 1000) as Time,
    price,
    qty,
    label: `${price}, ${qty}`,
    color: '#base',
    lineWidth: 1,
  };
}

const CANDLES = [candle(60_000, 110, 90), candle(120_000, 130, 100)];
const EXTREMES = candleExtremesByVirtualSec(CANDLES, axis);

/**
 * 화살표 앵커는 **벽 가격이 아니라 그 봉의 극값**이다 — 이 마커의 존재 이유가 "벽 선이
 * 캔들에서 멀 때 어느 봉이었는지" 라서, 벽 가격으로 대체하면 뜻이 사라진다.
 *
 * **막는 방향**: (1) 앵커가 `segment.price` 로 되돌아가는 것, (2) 매수가 고가를 쓰는 것,
 * (3) 캔들을 못 찾았을 때 조용히 벽 가격으로 폴백하는 것.
 * **못 보는 것**: 상위 3개 선정 — 그건 draw 시점이라 `peakWallVisibleRanking` 이 잡는다.
 */
describe('peakWallRankArrowsFromSegments', () => {
  it('매도는 그 봉의 **고가**에 매단다(벽 가격이 아니라)', () => {
    const arrows = peakWallRankArrowsFromSegments([segment(120_000, 200, 5)], 'ask', EXTREMES);
    expect(arrows).toHaveLength(1);
    expect(arrows[0].anchorPrice).toBe(130);
    expect(arrows[0].side).toBe('ask');
  });

  it('매수는 그 봉의 **저가**에 매단다(매도의 거울)', () => {
    const arrows = peakWallRankArrowsFromSegments([segment(120_000, 50, 5)], 'bid', EXTREMES);
    expect(arrows[0].anchorPrice).toBe(100);
    expect(arrows[0].side).toBe('bid');
  });

  it('랭킹 입력(그날 구간·잔량)과 선 색을 그대로 실어 나른다', () => {
    const [a] = peakWallRankArrowsFromSegments([segment(60_000, 100, 42)], 'ask', EXTREMES);
    expect(a).toMatchObject({ time0: 0, time1: 1000, qty: 42, color: '#base', time: 60 });
  });

  it('로드된 캔들 밖의 peak 은 **건너뛴다**(벽 가격으로 폴백하지 않는다)', () => {
    expect(peakWallRankArrowsFromSegments([segment(999_000, 100, 5)], 'ask', EXTREMES)).toEqual([]);
  });
});

describe('candleExtremesByVirtualSec', () => {
  it('가상초를 키로 봉 극값을 담는다 — peakTime 과 **같은 식**이라 정확히 되찾힌다', () => {
    expect(EXTREMES.get(60)).toEqual({ high: 110, low: 90 });
    expect(EXTREMES.get(120)).toEqual({ high: 130, low: 100 });
    expect(EXTREMES.get(61)).toBeUndefined();
  });
});
