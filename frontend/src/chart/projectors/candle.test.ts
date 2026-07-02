import { describe, it, expect } from 'vitest';
import { projectCandle } from './candle';
import { createVirtualAxis } from '../../util/virtualAxis';

const sessionOpenMs = 1_779_062_400_000;
const axis = createVirtualAxis([
  { date: '20260518', sessionOpenMs, sessionCloseMs: sessionOpenMs + 23_400_000 },
]);

describe('projectCandle', () => {
  it('maps OHLC and assigns up color to up candles, down color to down candles', () => {
    const bundle: any = {
      candles: [
        { ts_ms: sessionOpenMs, open: 100, close: 110, high: 115, low: 95, vol_a: 0, vol_b: 0 },
        { ts_ms: sessionOpenMs + 1000, open: 110, close: 105, high: 112, low: 100, vol_a: 0, vol_b: 0 },
      ],
    };
    const data = projectCandle(bundle, axis);
    expect(data).toHaveLength(2);
    expect(data[0].time).toBe(0);
    expect(data[0].open).toBe(100);
    expect(data[0].close).toBe(110);
    expect(data[0].high).toBe(115);
    expect(data[0].low).toBe(95);
    // up vs down differ
    expect(data[0].color).not.toBe(data[1].color);
    expect(data[0].borderColor).toBe(data[0].color);
    expect(data[0].wickColor).toBe(data[0].color);
  });

  it('applies muted color to candles inside the closing Auction Window (15:20-15:30 KST)', () => {
    // sessionOpenMs = 09:00 KST. 15:20 KST = sessionOpenMs + 6h20m = sessionOpenMs + 22_800_000.
    const auctionStartMs = sessionOpenMs + 22_800_000;
    const bundle: any = {
      candles: [
        { ts_ms: sessionOpenMs + 60_000, open: 100, close: 110, high: 115, low: 95, vol_a: 0, vol_b: 0 },
        { ts_ms: auctionStartMs + 60_000, open: 110, close: 115, high: 116, low: 109, vol_a: 0, vol_b: 0 },
      ],
    };
    const data = projectCandle(bundle, axis);
    expect(data[0].color).not.toBe(data[1].color); // first up colored, second muted
    // muted color is the same regardless of close>=open
    const sameSlot: any = {
      candles: [
        { ts_ms: auctionStartMs + 60_000, open: 110, close: 105, high: 116, low: 100, vol_a: 0, vol_b: 0 },
      ],
    };
    expect(projectCandle(sameSlot, axis)[0].color).toBe(data[1].color);
  });

  it('keeps normal up/down candle colors when auction muting is disabled', () => {
    const auctionStartMs = sessionOpenMs + 22_800_000;
    const bundle: any = {
      candles: [
        { ts_ms: sessionOpenMs + 60_000, open: 100, close: 110, high: 115, low: 95, vol_a: 0, vol_b: 0 },
        { ts_ms: auctionStartMs + 60_000, open: 110, close: 115, high: 116, low: 109, vol_a: 0, vol_b: 0 },
        { ts_ms: auctionStartMs + 120_000, open: 115, close: 105, high: 116, low: 100, vol_a: 0, vol_b: 0 },
      ],
    };

    const normal = projectCandle(bundle, axis, { muteAuctionCandles: false });

    expect(normal[1].color).toBe(normal[0].color);
    expect(normal[2].color).not.toBe(normal[0].color);
  });

  it('drops candles outside the segment via axis.contains', () => {
    const bundle: any = {
      candles: [
        { ts_ms: sessionOpenMs - 60_000, open: 100, close: 100, high: 100, low: 100, vol_a: 0, vol_b: 0 },
        { ts_ms: sessionOpenMs, open: 100, close: 110, high: 115, low: 95, vol_a: 0, vol_b: 0 },
      ],
    };
    expect(projectCandle(bundle, axis)).toHaveLength(1);
    expect(projectCandle(bundle, axis)[0].open).toBe(100);
  });
});
