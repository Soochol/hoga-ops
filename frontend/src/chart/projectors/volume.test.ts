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
    expect(dataFn(bundle, ax).length).toBe(1);
  });
});
