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

  it('emits in-auction points with transparent per-point colors when auctionWindowMask=true', () => {
    const auctionStartMs = sessionOpenMs + 22_800_000; // 15:20 KST
    const bundle: any = {
      quote_ratio: {
        points: [
          { t: sessionOpenMs, bid_total: 100, ask_total: 200 },              // outside → kept
          { t: auctionStartMs + 60_000, bid_total: 100, ask_total: 1000 },   // inside → transparent
          { t: auctionStartMs + 120_000, bid_total: 100, ask_total: 1000 },  // inside → transparent
        ],
      },
    };
    const masked = projectRatio(bundle, axis, { ...baseCtx, auctionWindowMask: true });

    // 1 kept data point + 2 in-auction transparent points = 3 entries.
    // The points stay on the time axis so the AuctionWindowOverlay can
    // compute timeToCoordinate for the full band, but the per-point
    // transparent line/fill colors make the segment invisible (ADR-0029).
    expect(masked).toHaveLength(3);

    const first = masked[0] as { time: number; value: number };
    expect(first.time).toBe(0);
    expect(first.value).toBeCloseTo(1.0, 5);
    expect((first as any).topLineColor).toBeUndefined(); // default style

    // In-auction entries: value present but rendered invisible via colors.
    const hidden1 = masked[1] as any;
    const hidden2 = masked[2] as any;
    expect(hidden1.time).toBe((auctionStartMs + 60_000 - sessionOpenMs) / 1000);
    expect(hidden1.value).toBe(0);
    expect(hidden1.topLineColor).toBe('rgba(0,0,0,0)');
    expect(hidden1.bottomLineColor).toBe('rgba(0,0,0,0)');
    expect(hidden2.topLineColor).toBe('rgba(0,0,0,0)');
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
