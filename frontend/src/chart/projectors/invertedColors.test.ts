import { describe, expect, it } from 'vitest';
import { rangeBundleFixture } from '../../../tests/fixtures/rangeBundle';
import { createVirtualAxis } from '../../util/virtualAxis';
import { projectCandleCached } from './candle';
import { projectVolumeCached } from './volume';

describe('inverted candle and volume colors', () => {
  it('recolors cached past/today bars together, preserving values and auction gray, and restores normal colors', () => {
    const open = Date.UTC(2026, 4, 27), tomorrow = open + 86_400_000;
    const segments = [open, tomorrow].map((t, i) => ({ date: `202605${27 + i}`,
      session_open_ms: t, session_close_ms: t + 23_400_000, source: 'kiwoom_live' as const }));
    const axis = createVirtualAxis(segments.map(s => ({ date: s.date,
      sessionOpenMs: s.session_open_ms, sessionCloseMs: s.session_close_ms })));
    const bundle = rangeBundleFixture({ segments, candles: [
      { ts_ms: open, open: 100, close: 110, high: 115, low: 95, vol_a: 12, vol_b: 3 },
      { ts_ms: open + 60_000, open: 110, close: 100, high: 115, low: 95, vol_a: 4, vol_b: 6 },
      { ts_ms: open + 120_000, open: 100, close: 100, high: 101, low: 99, vol_a: 1, vol_b: 2 },
      { ts_ms: open + 22_860_000, open: 100, close: 110, high: 115, low: 95, vol_a: 9, vol_b: 8 },
      { ts_ms: tomorrow, open: 100, close: 110, high: 115, low: 95, vol_a: 5, vol_b: 7 },
    ] });
    const normalContext = { muteAuctionCandles: true, swapColors: false };
    const swappedContext = { ...normalContext, swapColors: true };
    const normal = projectCandleCached(bundle, axis, normalContext);
    const normalVolume = projectVolumeCached(bundle, axis);
    const swapped = projectCandleCached(bundle, axis, swappedContext);
    const swappedVolume = projectVolumeCached(bundle, axis, true);
    for (const i of [0, 1, 2, 4]) {
      const expected = i === 1 ? normal[0].color : normal[1].color;
      expect(swapped[i]).toEqual({ ...normal[i], color: expected, borderColor: expected, wickColor: expected });
    }
    expect(swapped[3]).toEqual(normal[3]);
    for (let i = 0; i < normalVolume.length; i++) {
      const expected = i === 1 ? normalVolume[0].color : normalVolume[1].color;
      expect(swappedVolume[i]).toEqual({ ...normalVolume[i], color: expected });
    }
    const tail = { ...bundle.candles.at(-1)!, close: 90, low: 85, vol_a: 15 };
    const tick = { ...bundle, candles: [...bundle.candles.slice(0, -1), tail] };
    const next = projectCandleCached(tick, axis, swappedContext);
    const nextVolume = projectVolumeCached(tick, axis, true);
    expect(next[0]).toBe(swapped[0]);
    expect(nextVolume[0]).toBe(swappedVolume[0]);
    expect(next.at(-1)).toMatchObject({ close: 90, color: normal[0].color });
    expect(nextVolume.at(-1)).toMatchObject({ value: 22, color: normalVolume[0].color });
    expect(projectCandleCached(bundle, axis, normalContext)).toEqual(normal);
    expect(projectVolumeCached(bundle, axis)).toEqual(normalVolume);
    expect(bundle.candles.at(-1)?.close).toBe(110);
  });
});
