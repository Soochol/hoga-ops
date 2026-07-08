import { describe, it, expect } from 'vitest';
import { projectVolume, VOLUME_SPEC } from './volume';
import { createVirtualAxis } from '../../util/virtualAxis';

const sessionOpenMs = 1_779_062_400_000;
const axis = createVirtualAxis([
  { date: '20260518', sessionOpenMs, sessionCloseMs: sessionOpenMs + 23_400_000 },
]);

describe('projectVolume', () => {
  it('emits {time, value, color} per candle; up candles get up color, down candles get down color', () => {
    const bundle: any = {
      candles: [
        { ts_ms: sessionOpenMs, open: 100, close: 110, high: 115, low: 95, vol_a: 50, vol_b: 30 }, // up
        { ts_ms: sessionOpenMs + 1000, open: 110, close: 105, high: 112, low: 100, vol_a: 20, vol_b: 10 }, // down
      ],
    };
    const data = projectVolume(bundle, axis);
    expect(data).toHaveLength(2);
    expect(data[0].time).toBe(0);
    expect(data[0].value).toBe(80); // 50 + 30
    expect(data[1].value).toBe(30); // 20 + 10
    // up color used at index 0, down color at index 1 — exact hex depends on tokens
    expect(data[0].color).not.toBe(data[1].color);
  });

  it('drops candles outside the segment via axis.contains', () => {
    const bundle: any = {
      candles: [
        { ts_ms: sessionOpenMs - 60_000, open: 100, close: 100, high: 100, low: 100, vol_a: 5, vol_b: 0 }, // pre-open
        { ts_ms: sessionOpenMs, open: 100, close: 110, high: 115, low: 95, vol_a: 50, vol_b: 30 },
      ],
    };
    const data = projectVolume(bundle, axis);
    expect(data).toHaveLength(1);
    expect(data[0].value).toBe(80);
  });
});

describe('VOLUME_SPEC', () => {
  it('projects one bar per in-session candle (volume gating is pane mount, not data)', () => {
    const bundle = {
      candles: [{ ts_ms: 0, open: 1, close: 2, high: 2, low: 1, vol_a: 5, vol_b: 5 }],
    } as never;
    const ax = { contains: () => true, toVirtual: (t: number) => t } as never;
    const dataFn = VOLUME_SPEC.series[0].data;
    expect(dataFn(bundle, ax, { cumulativeEnabled: false, auctionWindowMask: false }).length).toBe(1);
  });

  it('체결강도 누적 라인은 2번째 시리즈로 존재한다', () => {
    expect(VOLUME_SPEC.series).toHaveLength(2);
    const second = VOLUME_SPEC.series[1];
    expect(second.type).toBeDefined();
    const opts = (typeof second.options === 'function' ? second.options() : second.options) as Record<string, unknown>;
    expect(opts.priceScaleId).toBe('');
  });

  it('토글 off 시 체결강도 누적 시리즈는 빈 데이터', () => {
    const bundle = {
      segments: [{ session_open_ms: 0, session_close_ms: 3_600_000, date: '20260527', source: 'kis_live' }],
      fill_strength: {
        points: [{ t: 120_000, buy_qty: 100, sell_qty: 20, bucketIndex: 1, session_open_ms: 0, session_close_ms: 3_600_000 }],
      },
    } as never;
    const ax = {
      contains: (t: number) => t >= 0 && t <= 3_600_000,
      toVirtual: (t: number) => t,
    } as never;
    const dataFn = VOLUME_SPEC.series[1].data as (...args: unknown[]) => { value: number; time: number }[];
    expect(dataFn(bundle, ax, { cumulativeEnabled: false, auctionWindowMask: false }).length).toBe(0);
  });

  it('cached volume bars reproject only today after a live tick', () => {
    const day0Open = sessionOpenMs;
    const day1Open = sessionOpenMs + 24 * 60 * 60 * 1000;
    const past0 = { ts_ms: day0Open, open: 100, close: 101, high: 102, low: 99, vol_a: 1, vol_b: 0 };
    const past1 = { ts_ms: day0Open + 60_000, open: 101, close: 102, high: 103, low: 100, vol_a: 2, vol_b: 0 };
    const today = { ts_ms: day1Open, open: 102, close: 103, high: 104, low: 101, vol_a: 3, vol_b: 0 };
    const segments = [
      { date: '20260518', session_open_ms: day0Open, session_close_ms: day0Open + 23_400_000, source: 'kis_live' },
      { date: '20260519', session_open_ms: day1Open, session_close_ms: day1Open + 23_400_000, source: 'kis_live' },
    ];
    const calls: number[] = [];
    const countingAxis = {
      contains: (t: number) => {
        calls.push(t);
        return true;
      },
      toVirtual: (t: number) => t - day0Open,
    } as never;
    const dataFn = VOLUME_SPEC.series[0].data as (...args: any[]) => Array<{ value: number }>;

    dataFn({ segments, candles: [past0, past1, today] } as never, countingAxis, {
      cumulativeEnabled: false,
      auctionWindowMask: false,
    });
    calls.length = 0;
    const data = dataFn(
      { segments, candles: [past0, past1, { ...today, vol_a: 4 }] } as never,
      countingAxis,
      { cumulativeEnabled: false, auctionWindowMask: false },
    );

    expect(calls).toEqual([today.ts_ms]);
    expect(data.at(-1)?.value).toBe(4);
  });
});
