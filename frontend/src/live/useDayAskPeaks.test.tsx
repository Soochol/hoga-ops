import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useDayAskPeaks } from './useDayAskPeaks';
import type { AskPeak } from '../api/types';
import type { ObSnapshot } from './bucketHogaSeries';

const deep = (t_ms: number, q: number, price = 26000): ObSnapshot => ({
  t_ms, total_ask_qty: 0, total_bid_qty: 0,
  asks: [{ price, qty: q }, ...Array.from({ length: 9 }, () => ({ price: 1, qty: 1 }))],
  bids: Array.from({ length: 10 }, (_, i) => ({ price: 24000 - i, qty: 100 })),
});

const byDate = (peaks: readonly AskPeak[]) => Object.fromEntries(peaks.map((p) => [p.date, p]));

describe('useDayAskPeaks', () => {
  it('과거일 seed는 그대로 통과, 오늘 항목만 live.ob로 ratchet', () => {
    const seeds: AskPeak[] = [
      { date: '20260611', price: 297000, qty: 32621, t_ms: 1 },
      { date: '20260613', price: 25100, qty: 5000, t_ms: 2 },
    ];
    const { result, rerender } = renderHook(
      ({ ob }: { ob: ObSnapshot[] }) => useDayAskPeaks(ob, seeds, '20260613', '005930'),
      { initialProps: { ob: [] as ObSnapshot[] } },
    );
    let m = byDate(result.current);
    expect(m['20260611'].qty).toBe(32621); // 과거일 그대로
    expect(m['20260613'].qty).toBe(5000); // 오늘 seed

    rerender({ ob: [deep(Date.now(), 9000)] });
    m = byDate(result.current);
    expect(m['20260611'].qty).toBe(32621); // 과거일 불변
    expect(m['20260613'].qty).toBe(9000); // 오늘 ratchet 전진
    expect(m['20260613'].date).toBe('20260613');
  });

  it('오늘 seed 없어도 live.ob 신기록이면 오늘 항목 생성', () => {
    const seeds: AskPeak[] = [{ date: '20260611', price: 297000, qty: 32621, t_ms: 1 }];
    const { result, rerender } = renderHook(
      ({ ob }: { ob: ObSnapshot[] }) => useDayAskPeaks(ob, seeds, '20260613', '005930'),
      { initialProps: { ob: [] as ObSnapshot[] } },
    );
    expect(result.current.find((p) => p.date === '20260613')).toBeUndefined();
    rerender({ ob: [deep(Date.now(), 7000)] });
    expect(result.current.find((p) => p.date === '20260613')?.qty).toBe(7000);
  });
});
