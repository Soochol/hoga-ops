import { describe, it, expect } from 'vitest';
import { projectBid, projectAsk } from './quoteTotals';
import { createVirtualAxis } from '../../util/virtualAxis';

const sessionOpenMs = 1_779_062_400_000;
const axis = createVirtualAxis([
  { date: '20260518', sessionOpenMs, sessionCloseMs: sessionOpenMs + 23_400_000 },
]);

describe('projectBid', () => {
  it('maps quote_ratio.points to {time, bid_total} in virtual seconds', () => {
    const bundle: any = {
      quote_ratio: {
        points: [
          { t: sessionOpenMs, bid_total: 100, ask_total: 200 },
          { t: sessionOpenMs + 1000, bid_total: 150, ask_total: 180 },
        ],
      },
    };
    expect(projectBid(bundle, axis, false)).toEqual([
      { time: 0, value: 100 },
      { time: 1, value: 150 },
    ]);
  });

  it('drops pre-open auction points via axis.contains', () => {
    const bundle: any = {
      quote_ratio: {
        points: [
          { t: sessionOpenMs - 30 * 60_000, bid_total: 99, ask_total: 99 },
          { t: sessionOpenMs, bid_total: 100, ask_total: 200 },
        ],
      },
    };
    expect(projectBid(bundle, axis, false)).toHaveLength(1);
    expect(projectBid(bundle, axis, false)[0].value).toBe(100);
  });
});

describe('projectAsk', () => {
  it('maps quote_ratio.points to {time, ask_total} in virtual seconds', () => {
    const bundle: any = {
      quote_ratio: {
        points: [
          { t: sessionOpenMs, bid_total: 100, ask_total: 200 },
          { t: sessionOpenMs + 1000, bid_total: 150, ask_total: 180 },
        ],
      },
    };
    expect(projectAsk(bundle, axis, false)).toEqual([
      { time: 0, value: 200 },
      { time: 1, value: 180 },
    ]);
  });
});

describe('closing-auction-window mask', () => {
  it('forces bid_total/ask_total to 0 inside the window when auctionWindowMask=true', () => {
    const auctionStartMs = sessionOpenMs + 22_800_000; // 15:20 KST
    const bundle: any = {
      quote_ratio: {
        points: [
          { t: sessionOpenMs, bid_total: 100, ask_total: 200 },              // outside → kept
          { t: auctionStartMs + 60_000, bid_total: 500, ask_total: 900 },    // inside → zeroed
        ],
      },
    };
    const bidsMasked = projectBid(bundle, axis, true);
    const asksMasked = projectAsk(bundle, axis, true);
    expect(bidsMasked[0].value).toBe(100);
    expect(asksMasked[0].value).toBe(200);
    expect(bidsMasked[1].value).toBe(0);
    expect(asksMasked[1].value).toBe(0);
  });

  it('keeps raw totals inside the window when auctionWindowMask=false', () => {
    const auctionStartMs = sessionOpenMs + 22_800_000;
    const bundle: any = {
      quote_ratio: {
        points: [
          { t: auctionStartMs + 60_000, bid_total: 500, ask_total: 900 },
        ],
      },
    };
    expect(projectBid(bundle, axis, false)[0].value).toBe(500);
    expect(projectAsk(bundle, axis, false)[0].value).toBe(900);
  });
});
