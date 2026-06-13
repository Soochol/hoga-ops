import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useDayAskPeak } from './useDayAskPeak';
import type { ObSnapshot } from './bucketHogaSeries';

const deep = (t_ms: number, q: number, price = 26000): ObSnapshot => ({
  t_ms, total_ask_qty: 0, total_bid_qty: 0,
  asks: [{ price, qty: q }, ...Array.from({ length: 9 }, () => ({ price: 1, qty: 1 }))],
  bids: Array.from({ length: 10 }, (_, i) => ({ price: 24000 - i, qty: 100 })),
});

describe('useDayAskPeak', () => {
  it('seed로 시작, 증분 ob로 전진', () => {
    const seed = { price: 25100, qty: 5000, t_ms: deep(1, 0).t_ms };
    const { result, rerender } = renderHook(
      ({ ob }: { ob: ObSnapshot[] }) => useDayAskPeak(ob, seed, '005930'),
      { initialProps: { ob: [] as ObSnapshot[] } },
    );
    expect(result.current).toEqual(seed);
    rerender({ ob: [deep(Date.now(), 9000)] });
    expect(result.current!.qty).toBe(9000);
  });

  it('code 변경 시 리셋·재시드', () => {
    const seedA = { price: 1, qty: 9000, t_ms: Date.now() };
    const { result, rerender } = renderHook(
      ({ code, ob, seed }: any) => useDayAskPeak(ob, seed, code),
      { initialProps: { code: 'A', ob: [deep(Date.now(), 12000)], seed: seedA } },
    );
    expect(result.current!.qty).toBe(12000);
    const seedB = { price: 2, qty: 100, t_ms: Date.now() };
    rerender({ code: 'B', ob: [], seed: seedB });
    expect(result.current).toEqual(seedB); // A의 12000 안 새어나옴
  });

  it('mid-day에 더 큰 seed가 늦게 와도 래칫(range 재fetch), 작은 seed는 안 내림', () => {
    const t0 = Date.now();
    const { result, rerender } = renderHook(
      ({ seed, ob }: { seed: any; ob: ObSnapshot[] }) => useDayAskPeak(ob, seed, '005930'),
      { initialProps: { seed: { price: 25100, qty: 5000, t_ms: t0 }, ob: [deep(t0 + 1000, 6000)] } },
    );
    expect(result.current!.qty).toBe(6000); // 라이브 틱이 seed 초과
    // 오전 최대벽(9000)이 늦게 seed로 도착(같은 거래일·code, ob 변화 없음=같은 tMs).
    rerender({ seed: { price: 24000, qty: 9000, t_ms: t0 - 3_600_000 }, ob: [deep(t0 + 1000, 6000)] });
    expect(result.current!.qty).toBe(9000); // 더 큰 seed 래칫됨
    rerender({ seed: { price: 1, qty: 10, t_ms: t0 }, ob: [deep(t0 + 1000, 6000)] });
    expect(result.current!.qty).toBe(9000); // 더 작은 seed는 내리지 않음(단조)
  });
});
