import { describe, expect, it } from 'vitest';
import { mergeProgramTradeSeriesWithLiveTail } from './programTradeLiveTail';

describe('mergeProgramTradeSeriesWithLiveTail', () => {
  it('keeps persisted history and appends only snapshots after the seam', () => {
    const persisted = {
      source: 'kis_program_trade' as const,
      points: [
        {
          t: 100,
          net_qty: 1,
          net_amount: 1_000,
          delta_qty: 1,
          delta_amount: 1_000,
          gap_risk: false,
        },
        {
          t: 200,
          net_qty: 2,
          net_amount: 2_000,
          delta_qty: 1,
          delta_amount: 1_000,
          gap_risk: false,
        },
      ],
    };
    const live = [
      { t_ms: 150, kind: 'program', net_qty: 99, net_amount: 99_000 },
      { t_ms: 200, kind: 'program', net_qty: 20, net_amount: 20_000 },
      { t_ms: 300, kind: 'program', net_qty: 3, net_amount: 3_000 },
    ];

    expect(mergeProgramTradeSeriesWithLiveTail(persisted, live)).toEqual({
      source: 'kis_program_trade',
      points: [
        ...persisted.points,
        {
          t: 300,
          net_qty: 3,
          net_amount: 3_000,
          delta_qty: null,
          delta_amount: null,
          gap_risk: false,
        },
      ],
    });
  });

  it('sorts out-of-order live snapshots and keeps the last duplicate', () => {
    const merged = mergeProgramTradeSeriesWithLiveTail(null, [
      { t_ms: 300, kind: 'program', net_qty: 3, net_amount: 3_000 },
      { t_ms: 100, kind: 'program', net_qty: 1, net_amount: 1_000 },
      { t_ms: 300, kind: 'program', net_qty: 30, net_amount: 30_000 },
    ]);

    expect(merged.points.map((point) => point.t)).toEqual([100, 300]);
    expect(merged.points[1].net_qty).toBe(30);
  });

  it('drops invalid timestamps and normalizes invalid cumulative values to null', () => {
    const merged = mergeProgramTradeSeriesWithLiveTail(undefined, [
      { t_ms: 'bad', kind: 'program', net_qty: 1, net_amount: 1_000 },
      { t_ms: 100, kind: 'program', net_qty: Number.NaN, net_amount: 'bad' },
    ]);

    expect(merged).toEqual({
      source: 'kis_program_trade',
      points: [{
        t: 100,
        net_qty: null,
        net_amount: null,
        delta_qty: null,
        delta_amount: null,
        gap_risk: false,
      }],
    });
  });
});

describe('persisted history reuse', () => {
  const p = (t: number, net_amount = t) => ({ t, net_amount, net_qty: t, gap_risk: false });

  it('normalizes unsorted persisted duplicates once, preserves references, and advances the seam on refresh', () => {
    const kept = p(200, 999);
    const persisted = { points: [p(200), p(100), kept] };
    const first = mergeProgramTradeSeriesWithLiveTail(persisted, []);
    expect(first.points).toEqual([persisted.points[1], kept]);
    expect(mergeProgramTradeSeriesWithLiveTail(persisted, [{ t_ms: 150 }]).points).toBe(first.points);
    const live = [{ t_ms: 300, net_amount: 123 }];
    const next = mergeProgramTradeSeriesWithLiveTail(persisted, live);
    expect(next.points[1]).toBe(kept);
    expect(next.points[2].net_amount).toBe(123);
    const promoted = p(300, 456);
    const refreshed = mergeProgramTradeSeriesWithLiveTail({ points: [...first.points, promoted] }, live);
    expect(refreshed.points.at(-1)).toBe(promoted);
  });

  it('does not read persisted timestamps again for live-only updates', () => {
    let reads = 0;
    const past = Array.from({ length: 10_000 }, (_, i) => ({
      ...p(i), get t() { reads += 1; return i; },
    }));
    const persisted = { points: past };
    mergeProgramTradeSeriesWithLiveTail(persisted, []);
    reads = 0;
    const next = mergeProgramTradeSeriesWithLiveTail(persisted, [{ t_ms: 20_000, net_amount: 100 }]);
    expect(reads).toBe(0);
    expect(next.points).toHaveLength(10_001);
  });
});
