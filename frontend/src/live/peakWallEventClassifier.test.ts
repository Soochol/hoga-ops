import { describe, expect, it } from 'vitest';
import {
  classifyAskWallEvents,
  classifyBidWallEvents,
  rankPeakCandidates,
  toTouchTicksFromTrades,
} from './peakWallEventClassifier';

describe('peakWallEventClassifier', () => {
  it('classifies ask walls with >= touch semantics and ranks each family independently', () => {
    const classified = classifyAskWallEvents(
      [
        { price: 100, qty: 500, t_ms: 1_000 },
        { price: 101, qty: 900, t_ms: 1_000 },
        { price: 102, qty: 700, t_ms: 1_000 },
        { price: 103, qty: 800, t_ms: 1_000 },
      ],
      [
        { price: 101, t_ms: 2_000 },
      ],
    );

    expect(classified.postTouch).toEqual([
      { price: 101, qty: 900, t_ms: 1_000 },
      { price: 100, qty: 500, t_ms: 1_000 },
    ]);
    expect(classified.postUntouched).toEqual([
      { price: 103, qty: 800, t_ms: 1_000 },
      { price: 102, qty: 700, t_ms: 1_000 },
    ]);
    expect(classified.all).toEqual([
      { price: 101, qty: 900, t_ms: 1_000 },
      { price: 103, qty: 800, t_ms: 1_000 },
      { price: 102, qty: 700, t_ms: 1_000 },
    ]);
  });

  it('classifies bid walls with <= touch semantics', () => {
    const classified = classifyBidWallEvents(
      [
        { price: 100, qty: 500, t_ms: 1_000 },
        { price: 99, qty: 900, t_ms: 1_000 },
        { price: 98, qty: 700, t_ms: 1_000 },
      ],
      [
        { price: 99, t_ms: 2_000 },
      ],
    );

    expect(classified.postTouch).toEqual([
      { price: 99, qty: 900, t_ms: 1_000 },
      { price: 100, qty: 500, t_ms: 1_000 },
    ]);
    expect(classified.postUntouched).toEqual([
      { price: 98, qty: 700, t_ms: 1_000 },
    ]);
  });

  it('splits repeated same-price walls when only the earlier event has a later touch', () => {
    const classified = classifyAskWallEvents(
      [
        { price: 100, qty: 500, t_ms: 1_000 },
        { price: 100, qty: 900, t_ms: 3_000 },
      ],
      [
        { price: 100, t_ms: 2_000 },
      ],
    );

    expect(classified.postTouch).toEqual([
      { price: 100, qty: 500, t_ms: 1_000 },
    ]);
    expect(classified.postUntouched).toEqual([
      { price: 100, qty: 900, t_ms: 3_000 },
    ]);
    expect(classified.all).toEqual([
      { price: 100, qty: 900, t_ms: 3_000 },
      { price: 100, qty: 500, t_ms: 1_000 },
    ]);
  });

  it('ignores trades that occur before the wall event', () => {
    const classified = classifyAskWallEvents(
      [
        { price: 100, qty: 500, t_ms: 2_000 },
      ],
      [
        { price: 100, t_ms: 1_000 },
      ],
    );

    expect(classified.postTouch).toEqual([]);
    expect(classified.postUntouched).toEqual([
      { price: 100, qty: 500, t_ms: 2_000 },
    ]);
  });

  it('classifies large live buffers without scanning every wall against every touch', () => {
    const base = Date.UTC(2026, 5, 23, 0, 0, 0);
    const events = Array.from({ length: 20_000 }, (_, i) => ({
      price: 40_000 + (i % 20),
      qty: 100 + i,
      t_ms: base + i * 100,
    }));
    const touches = Array.from({ length: 2_000 }, (_, i) => ({
      price: 40_010,
      t_ms: base + i * 1_000,
    }));

    const started = performance.now();
    const classified = classifyAskWallEvents(events, touches);
    const elapsed = performance.now() - started;

    expect(classified.postTouch[0]).toEqual({ price: 40_010, qty: 20090, t_ms: base + 1_999_000 });
    expect(classified.postUntouched[0]).toEqual({ price: 40_019, qty: 20099, t_ms: base + 1_999_900 });
    expect(elapsed).toBeLessThan(300);
  });

  it('ignores side=0 trades when building touch classification input', () => {
    expect(toTouchTicksFromTrades([
      {
        t_ms: 2_000,
        trades: [
          { t_ms: 2_000, side: 0, price: 100, qty: 1 },
          { t_ms: 2_000, side: 2, price: 100, qty: 1 },
          { t_ms: 2_000, side: 1, price: 100, qty: 1 },
        ],
      },
    ])).toEqual([
      { price: 100, t_ms: 2_000 },
    ]);
  });

  it('caps ranked candidates to the top three by qty then time then price', () => {
    expect(rankPeakCandidates([
      { price: 104, qty: 100, t_ms: 1_000 },
      { price: 101, qty: 700, t_ms: 3_000 },
      { price: 103, qty: 700, t_ms: 2_000 },
      { price: 102, qty: 500, t_ms: 1_000 },
      { price: 100, qty: 900, t_ms: 4_000 },
    ])).toEqual([
      { price: 100, qty: 900, t_ms: 4_000 },
      { price: 103, qty: 700, t_ms: 2_000 },
      { price: 101, qty: 700, t_ms: 3_000 },
    ]);
  });
});
