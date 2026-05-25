import { describe, it, expect } from 'vitest';
import { projectRatio, type RatioPaneContext } from './ratio';
import { createVirtualAxis } from '../../util/virtualAxis';

const sessionOpenMs = 1_779_062_400_000;
const axis = createVirtualAxis([
  { date: '20260518', sessionOpenMs, sessionCloseMs: sessionOpenMs + 23_400_000 },
]);

const baseCtx: RatioPaneContext = {
  auctionWindowMask: false,
  outlierFilterEnabled: false,
  outlierThreshold: 100,
};

describe('projectRatio', () => {
  it('emits {time, value} using quoteImbalance from bid_total / ask_total', () => {
    const bundle: any = {
      quote_ratio: {
        points: [
          { t: sessionOpenMs, bid_total: 100, ask_total: 100 }, // balanced → 0
          { t: sessionOpenMs + 1000, bid_total: 100, ask_total: 200 }, // sell-heavy → +1.0
        ],
      },
    };
    const data = projectRatio(bundle, axis, baseCtx) as { time: number; value: number }[];
    expect(data[0].time).toBe(0);
    expect(data[0].value).toBe(0);
    expect(data[1].value).toBeCloseTo(1.0, 5);
  });

  it('drops pre-open auction points via axis.contains', () => {
    const bundle: any = {
      quote_ratio: {
        points: [
          { t: sessionOpenMs - 30 * 60_000, bid_total: 100, ask_total: 200 },
          { t: sessionOpenMs, bid_total: 100, ask_total: 100 },
        ],
      },
    };
    expect(projectRatio(bundle, axis, baseCtx)).toHaveLength(1);
  });

  it('emits in-auction points as WhitespaceData (line breaks; time scale preserved) when auctionWindowMask=true', () => {
    const auctionStartMs = sessionOpenMs + 22_800_000; // 15:20 KST
    const bundle: any = {
      quote_ratio: {
        points: [
          { t: sessionOpenMs, bid_total: 100, ask_total: 200 },              // outside → kept
          { t: auctionStartMs + 60_000, bid_total: 100, ask_total: 1000 },   // inside → whitespace
          { t: auctionStartMs + 120_000, bid_total: 100, ask_total: 1000 },  // inside → whitespace
        ],
      },
    };
    const masked = projectRatio(bundle, axis, { ...baseCtx, auctionWindowMask: true });

    // 1 kept data point + 2 in-auction whitespaces = 3 entries.
    // Whitespace at each in-auction time preserves the chart's bar-index
    // density so AuctionWindowOverlay can compute timeToCoordinate for the
    // full auction band (ADR-0029).
    expect(masked).toHaveLength(3);

    // First entry: kept pre-auction data point.
    const first = masked[0] as { time: number; value: number };
    expect(first.time).toBe(0);
    expect(first.value).toBeCloseTo(1.0, 5);

    // Second + third entries: WhitespaceData at exactly the in-auction times.
    const ws1 = masked[1] as { time: number; value?: number };
    const ws2 = masked[2] as { time: number; value?: number };
    expect(ws1.time).toBe((auctionStartMs + 60_000 - sessionOpenMs) / 1000);
    expect(ws1.value).toBeUndefined();
    expect(ws2.time).toBe((auctionStartMs + 120_000 - sessionOpenMs) / 1000);
    expect(ws2.value).toBeUndefined();
  });

  it('keeps auction-window points when auctionWindowMask=false', () => {
    const auctionStartMs = sessionOpenMs + 22_800_000;
    const bundle: any = {
      quote_ratio: {
        points: [
          { t: auctionStartMs + 60_000, bid_total: 100, ask_total: 1000 },
        ],
      },
    };
    const unmasked = projectRatio(bundle, axis, baseCtx);
    expect(unmasked).toHaveLength(1);
    const p = unmasked[0] as { value: number };
    expect(p.value).not.toBe(0);
  });

  it('masks outlier points to 0 when outlierFilterEnabled=true and label >= threshold', () => {
    const bundle: any = {
      quote_ratio: {
        points: [
          { t: sessionOpenMs, bid_total: 100, ask_total: 9900 }, // label=99 (raw 98)
          { t: sessionOpenMs + 1000, bid_total: 100, ask_total: 10000 }, // label=100 (raw 99)
          { t: sessionOpenMs + 2000, bid_total: 100, ask_total: 20000 }, // label=200 (raw 199)
        ],
      },
    };
    const ctx: RatioPaneContext = {
      auctionWindowMask: false,
      outlierFilterEnabled: true,
      outlierThreshold: 100,
    };
    const data = projectRatio(bundle, axis, ctx) as { time: number; value: number }[];
    // Below threshold → kept
    expect(data[0].value).toBeCloseTo(98, 5);
    // At threshold (>=) → masked
    expect(data[1].value).toBe(0);
    // Above threshold → masked
    expect(data[2].value).toBe(0);
  });

  it('does not mask outliers when outlierFilterEnabled=false', () => {
    const bundle: any = {
      quote_ratio: {
        points: [
          { t: sessionOpenMs, bid_total: 100, ask_total: 20000 }, // label=200
        ],
      },
    };
    const data = projectRatio(bundle, axis, baseCtx) as { time: number; value: number }[];
    expect(data[0].value).toBeCloseTo(199, 5);
  });
});
