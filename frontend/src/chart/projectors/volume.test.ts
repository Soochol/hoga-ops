import { rangeBundleFixture } from '../../../tests/fixtures/rangeBundle';
import { describe, it, expect } from 'vitest';
import { projectVolume, projectVolumeCached, VOLUME_SPEC } from './volume';
import { DEFAULT_VOLUME_OVERLAY_STYLE } from '../../state/chartDisplayPrefs';
import { createVirtualAxis } from '../../util/virtualAxis';

const sessionOpenMs = 1_779_062_400_000;
const axis = createVirtualAxis([
  { date: '20260518', sessionOpenMs, sessionCloseMs: sessionOpenMs + 23_400_000 },
]);

describe('projectVolume', () => {
  it('changes historical colors/transparency without changing time or quantities, including inversion and a tail tick', () => {
    const day1 = sessionOpenMs + 86_400_000;
    const bundle = rangeBundleFixture({
      segments: [
        { date: '20260518', session_open_ms: sessionOpenMs, session_close_ms: sessionOpenMs + 23_400_000, source: 'hogaplay' },
        { date: '20260519', session_open_ms: day1, session_close_ms: day1 + 23_400_000, source: 'hogaplay' },
      ],
      candles: [
        { ts_ms: sessionOpenMs, open: 1, close: 2, high: 2, low: 1, vol_a: 10, vol_b: 20 },
        { ts_ms: day1, open: 2, close: 1, high: 2, low: 1, vol_a: 40, vol_b: 10 },
      ],
    });
    const ax = createVirtualAxis(bundle.segments!.map(s => ({ date: s.date, sessionOpenMs: s.session_open_ms, sessionCloseMs: s.session_close_ms })));
    const style = { ...DEFAULT_VOLUME_OVERLAY_STYLE, volumeOverlayUpColor: '#112233', volumeOverlayDownColor: '#445566', volumeOverlayTransparency: 0 };
    const plain = projectVolumeCached(bundle, ax);
    expect(projectVolumeCached(bundle, ax, false, style).map(r => r.color)).toEqual(['#112233ff', '#445566ff']);
    const faded = projectVolumeCached(bundle, ax, true, { ...style, volumeOverlayTransparency: 65 });
    expect(faded.map(r => r.color)).toEqual(['#44556659', '#11223359']);
    expect(faded.map(({ color, ...r }) => r)).toEqual(plain.map(({ color, ...r }) => r));
    const next = projectVolumeCached({ ...bundle, candles: [bundle.candles[0], { ...bundle.candles[1], vol_a: 50 }] }, ax, true,
      { ...style, volumeOverlayTransparency: 65 });
    expect(next[0]).toBe(faded[0]);
    expect(next[1].value).toBe(60);
    expect(projectVolumeCached(bundle, ax, false, { ...style, volumeOverlayTransparency: 100 })[0].color).toBe('#11223300');
  });
  it('emits {time, value, color} per candle; up candles get up color, down candles get down color', () => {
    const bundle = rangeBundleFixture( {
      candles: [
        { ts_ms: sessionOpenMs, open: 100, close: 110, high: 115, low: 95, vol_a: 50, vol_b: 30 }, // up
        { ts_ms: sessionOpenMs + 1000, open: 110, close: 105, high: 112, low: 100, vol_a: 20, vol_b: 10 }, // down
      ],
    });
    const data = projectVolume(bundle, axis);
    expect(data).toHaveLength(2);
    expect(data[0].time).toBe(0);
    expect(data[0].value).toBe(80); // 50 + 30
    expect(data[1].value).toBe(30); // 20 + 10
    // up color used at index 0, down color at index 1 — exact hex depends on tokens
    expect(data[0].color).not.toBe(data[1].color);
  });

  it('drops candles outside the segment via axis.contains', () => {
    const bundle = rangeBundleFixture( {
      candles: [
        { ts_ms: sessionOpenMs - 60_000, open: 100, close: 100, high: 100, low: 100, vol_a: 5, vol_b: 0 }, // pre-open
        { ts_ms: sessionOpenMs, open: 100, close: 110, high: 115, low: 95, vol_a: 50, vol_b: 30 },
      ],
    });
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
    const ax = { classifyAndProject: (t: number) => ({ contained: true, virtual: t }) } as never;
    const dataFn = VOLUME_SPEC.series[0].data;
    expect(dataFn(bundle, ax, {}).length).toBe(1);
  });

  it('contains only the volume histogram', () => {
    expect(VOLUME_SPEC.series).toHaveLength(1);
  });

  it('cached volume bars reproject only today after a live tick', () => {
    const day0Open = sessionOpenMs;
    const day1Open = sessionOpenMs + 24 * 60 * 60 * 1000;
    const past0 = { ts_ms: day0Open, open: 100, close: 101, high: 102, low: 99, vol_a: 1, vol_b: 0 };
    const past1 = { ts_ms: day0Open + 60_000, open: 101, close: 102, high: 103, low: 100, vol_a: 2, vol_b: 0 };
    const today = { ts_ms: day1Open, open: 102, close: 103, high: 104, low: 101, vol_a: 3, vol_b: 0 };
    const segments = [
      { date: '20260518', session_open_ms: day0Open, session_close_ms: day0Open + 23_400_000, source: 'kiwoom_live' },
      { date: '20260519', session_open_ms: day1Open, session_close_ms: day1Open + 23_400_000, source: 'kiwoom_live' },
    ];
    const calls: number[] = [];
    const countingAxis = {
      classifyAndProject: (t: number) => {
        calls.push(t);
        return { contained: true, virtual: t - day0Open };
      },
    } as never;
    const dataFn = VOLUME_SPEC.series[0].data as (...args: Parameters<typeof VOLUME_SPEC.series[0]['data']>) => Array<{ value: number }>;

    dataFn({ segments, candles: [past0, past1, today] } as never, countingAxis, {
    });
    calls.length = 0;
    const data = dataFn(
      { segments, candles: [past0, past1, { ...today, vol_a: 4 }] } as never,
      countingAxis,
      {},
    );

    expect(calls).toEqual([today.ts_ms]);
    expect(data.at(-1)?.value).toBe(4);
  });
});
