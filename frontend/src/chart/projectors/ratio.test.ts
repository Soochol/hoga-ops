import { describe, it, expect } from 'vitest';
import { projectRatio } from './ratio';
import { createVirtualAxis } from '../../util/virtualAxis';

const sessionOpenMs = 1_779_062_400_000;
const axis = createVirtualAxis([
  { date: '20260518', sessionOpenMs, sessionCloseMs: sessionOpenMs + 23_400_000 },
]);

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
    const data = projectRatio(bundle, axis, false);
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
    expect(projectRatio(bundle, axis, false)).toHaveLength(1);
  });

  it('masks closing-auction-window values to 0 when auctionWindowMask=true', () => {
    const auctionStartMs = sessionOpenMs + 22_800_000; // 15:20 KST
    const bundle: any = {
      quote_ratio: {
        points: [
          { t: sessionOpenMs, bid_total: 100, ask_total: 200 },              // outside → imbalance kept
          { t: auctionStartMs + 60_000, bid_total: 100, ask_total: 1000 },   // inside auction window
        ],
      },
    };
    const unmasked = projectRatio(bundle, axis, false);
    const masked = projectRatio(bundle, axis, true);
    // Outside the window, masked and unmasked agree
    expect(masked[0].value).toBe(unmasked[0].value);
    // Inside the window, masked is forced to 0
    expect(masked[1].value).toBe(0);
    expect(unmasked[1].value).not.toBe(0);
  });
});
