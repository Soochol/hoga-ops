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
    expect((projectBid(bundle, axis, false) as { time: number; value: number }[])[0].value).toBe(100);
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

describe('closing-auction-window hide', () => {
  it('emits in-window bid/ask points with transparent per-point color when auctionWindowMask=true', () => {
    const auctionStartMs = sessionOpenMs + 22_800_000; // 15:20 KST
    const bundle: any = {
      quote_ratio: {
        points: [
          { t: sessionOpenMs, bid_total: 100, ask_total: 200 },              // outside → kept
          { t: auctionStartMs + 60_000, bid_total: 500, ask_total: 900 },    // inside → transparent
          { t: auctionStartMs + 120_000, bid_total: 600, ask_total: 1000 },  // inside → transparent
        ],
      },
    };
    const bids = projectBid(bundle, axis, true);
    const asks = projectAsk(bundle, axis, true);

    // Each series: 1 kept data point + 2 in-auction transparent points = 3 entries.
    // The transparent per-point color makes the outgoing line segment invisible
    // (ADR-0029), keeping the bar-index density for AuctionWindowOverlay's
    // timeToCoordinate while breaking the visible line.
    expect(bids).toHaveLength(3);
    expect(asks).toHaveLength(3);

    expect(bids[0]).toEqual({ time: 0, value: 100 });
    expect(asks[0]).toEqual({ time: 0, value: 200 });

    const t1 = (auctionStartMs + 60_000 - sessionOpenMs) / 1000;
    const t2 = (auctionStartMs + 120_000 - sessionOpenMs) / 1000;
    expect(bids[1]).toEqual({ time: t1, value: 0, color: 'rgba(0,0,0,0)' });
    expect(asks[1]).toEqual({ time: t1, value: 0, color: 'rgba(0,0,0,0)' });
    expect(bids[2]).toEqual({ time: t2, value: 0, color: 'rgba(0,0,0,0)' });
    expect(asks[2]).toEqual({ time: t2, value: 0, color: 'rgba(0,0,0,0)' });
  });

  it('keeps in-window points when auctionWindowMask=false', () => {
    const auctionStartMs = sessionOpenMs + 22_800_000;
    const bundle: any = {
      quote_ratio: {
        points: [
          { t: auctionStartMs + 60_000, bid_total: 500, ask_total: 900 },
        ],
      },
    };
    expect(projectBid(bundle, axis, false)).toEqual([
      { time: (auctionStartMs + 60_000 - sessionOpenMs) / 1000, value: 500 },
    ]);
    expect(projectAsk(bundle, axis, false)).toEqual([
      { time: (auctionStartMs + 60_000 - sessionOpenMs) / 1000, value: 900 },
    ]);
  });
});
