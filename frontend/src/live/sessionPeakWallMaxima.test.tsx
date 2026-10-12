import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { AskPeak, AskPeakCandidate } from '../api/types';
import type { ObSnapshot, TradeSnapshot } from './bucketHogaSeries';
import { SessionPeakWallMaxima } from './sessionPeakWallMaxima';
import { useDayAskPeaks } from './useDayAskPeaks';
import { useDayBidPeaks } from './useDayBidPeaks';

const today = '20261012';
const open = Date.UTC(2026, 9, 12, 0);
function book(minute: number, qty: number): ObSnapshot {
  return {
    t_ms: open + minute * 60_000,
    total_ask_qty: qty, total_bid_qty: qty,
    asks: Array.from({ length: 10 }, (_, i) => ({ price: 110 + i, qty: i === 0 ? qty : 1 })),
    bids: Array.from({ length: 10 }, (_, i) => ({ price: 100 - i, qty: i === 0 ? qty : 1 })),
  };
}
function trades(minute: number): TradeSnapshot {
  return { t_ms: open + minute * 60_000 + 1_000,
    trades: [{ side: 1, price: 110, qty: 1 }, { side: -1, price: 100, qty: 1 }] };
}

describe('daily maximum after display-buffer eviction', () => {
  for (const [side, hook] of [['ask', useDayAskPeaks], ['bid', useDayBidPeaks]] as const) {
    it(`${side}: preserves a new maximum through sliding, replacement, and empty buffers`, () => {
      const large = book(20, 15_000);
      const small = book(21, 100);
      const { result, rerender } = renderHook(
        ({ ob, trade }) => hook(ob, trade, [], today, open, '000660'),
        { initialProps: { ob: [large, small], trade: [trades(20), trades(21)] } },
      );
      expect(result.current[0].qty).toBe(15_000);
      rerender({ ob: [small, book(22, 200)], trade: [trades(21), trades(22)] });
      expect(result.current[0].qty).toBe(15_000);
      expect(result.current[0].all_peaks?.[0].qty).toBe(15_000);
      rerender({ ob: [book(40, 300)], trade: [trades(40)] });
      expect(result.current[0].qty).toBe(15_000);
      rerender({ ob: [], trade: [] });
      expect(result.current[0].qty).toBe(15_000);
      rerender({ ob: [book(50, 20_000)], trade: [trades(50)] });
      expect(result.current[0].qty).toBe(20_000);
      expect(result.current[0].traded_record_peaks?.map((p) => p.qty)).toEqual([15_000, 20_000]);
    });

    it(`${side}: resets when the selected venue changes with the same opening time`, () => {
      const { result, rerender } = renderHook(
        ({ venue, qty }) => hook([book(20, qty)], [trades(20)], [], today, open, '000660', null, [], venue),
        { initialProps: { venue: 'KRX', qty: 15_000 } },
      );
      expect(result.current[0].qty).toBe(15_000);
      rerender({ venue: 'UN', qty: 100 });
      expect(result.current[0].qty).toBe(100);
      expect(result.current[0].traded_record_peaks?.map((p) => p.qty)).toEqual([100]);
    });
  }
});

function row(candidates: AskPeakCandidate[], unreached: AskPeakCandidate[] = []): AskPeak {
  const best = candidates[0];
  return { date: today, price: best.price, qty: best.qty, t_ms: best.t_ms,
    max_price: best.price, max_qty: best.qty, max_t_ms: best.t_ms,
    traded_peaks: candidates, all_peaks: candidates, unreached_peaks: unreached };
}

describe('SessionPeakWallMaxima', () => {
  it('keeps distinct price maxima bounded to three and does not ratchet unreached walls', () => {
    const accumulator = new SessionPeakWallMaxima();
    const old = { price: 110, qty: 1_000, t_ms: open };
    accumulator.update([row([old], [old])], today, 'scope');
    const candidates = Array.from({ length: 20 }, (_, i) => ({ price: 100 + i, qty: 200 + i, t_ms: open + 60_000 }));
    const result = accumulator.update([row(candidates)], today, 'scope')[0];
    expect(result.qty).toBe(1_000);
    expect(result.traded_peaks).toHaveLength(3);
    expect(new Set(result.traded_peaks?.map((p) => p.price)).size).toBe(3);
    expect(result.unreached_peaks).toEqual([]);
  });

  it('clears old candidates on a scope change even when the next input has no today row', () => {
    const accumulator = new SessionPeakWallMaxima();
    accumulator.update([row([{ price: 110, qty: 1_000, t_ms: open }])], today, '000660');
    expect(accumulator.update([], today, '005930')).toEqual([]);
    expect(accumulator.update([row([{ price: 100, qty: 100, t_ms: open }])], today, '005930')[0].qty).toBe(100);
  });
});
