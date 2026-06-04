import { describe, it, expect } from 'vitest';
import { projectBid, projectAsk, QUOTE_TOTALS_SPEC } from './quoteTotals';
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

    // The last pre-auction point's OUTGOING connector is transparent so the line
    // does not slope from the last continuous bucket into the auction window
    // (ADR-0029 connector-gap fix). Its value is still shown via the incoming
    // segment from the prior visible point.
    expect(bids[0]).toEqual({ time: 0, value: 100, color: 'rgba(0,0,0,0)' });
    expect(asks[0]).toEqual({ time: 0, value: 200, color: 'rgba(0,0,0,0)' });

    const t1 = (auctionStartMs + 60_000 - sessionOpenMs) / 1000;
    const t2 = (auctionStartMs + 120_000 - sessionOpenMs) / 1000;
    expect(bids[1]).toEqual({ time: t1, value: 0, color: 'rgba(0,0,0,0)' });
    expect(asks[1]).toEqual({ time: t1, value: 0, color: 'rgba(0,0,0,0)' });
    expect(bids[2]).toEqual({ time: t2, value: 0, color: 'rgba(0,0,0,0)' });
    expect(asks[2]).toEqual({ time: t2, value: 0, color: 'rgba(0,0,0,0)' });
  });

  it('breaks the connector from the last pre-auction point into the masked run', () => {
    // ADR-0029 gap: the mask transparents each masked point's OUTGOING segment,
    // but the connector FROM the last visible (pre-auction) point INTO the first
    // masked point stayed visible — the 총잔량 line sloped from the last
    // continuous bucket (e.g. 274/404) down into the auction window toward the
    // masked value=0. The last pre-auction point's outgoing segment must be
    // transparent too. (numbers from 한진칼 2026-06-04 3m 15:18 bucket.)
    const auctionStartMs = sessionOpenMs + 22_800_000; // 15:20 KST
    const bundle: any = {
      quote_ratio: {
        points: [
          { t: auctionStartMs - 60_000, bid_total: 274, ask_total: 404 }, // last continuous (15:19)
          { t: auctionStartMs + 60_000, bid_total: 33, ask_total: 3039 },  // auction (masked)
        ],
      },
    };
    const tCont = (auctionStartMs - 60_000 - sessionOpenMs) / 1000;
    const tAuc = (auctionStartMs + 60_000 - sessionOpenMs) / 1000;
    expect(projectBid(bundle, axis, true)).toEqual([
      { time: tCont, value: 274, color: 'rgba(0,0,0,0)' },
      { time: tAuc, value: 0, color: 'rgba(0,0,0,0)' },
    ]);
    expect(projectAsk(bundle, axis, true)).toEqual([
      { time: tCont, value: 404, color: 'rgba(0,0,0,0)' },
      { time: tAuc, value: 0, color: 'rgba(0,0,0,0)' },
    ]);
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

describe('QUOTE_TOTALS_SPEC crosshair marker', () => {
  // The Auction Mask connector-break transparents the last pre-auction point's
  // per-point `color`; for a LineSeries that also drives the crosshair marker,
  // so the marker would vanish at that point (the 15:19 dot on 1m). A solid
  // series-level crosshairMarkerBackgroundColor decouples the marker from the
  // per-point color and keeps the dot — matching 호가비 (BaselineSeries). Lock
  // it so a future options refactor can't silently drop the marker.
  it('pins each line a solid crosshairMarkerBackgroundColor (not transparent)', () => {
    const colors = QUOTE_TOTALS_SPEC.series.map(
      (s) => (s.options as { crosshairMarkerBackgroundColor?: string }).crosshairMarkerBackgroundColor,
    );
    expect(colors).toHaveLength(2);
    for (const c of colors) {
      expect(c).toBeTruthy();
      expect(c).not.toBe('rgba(0,0,0,0)');
    }
  });
});
