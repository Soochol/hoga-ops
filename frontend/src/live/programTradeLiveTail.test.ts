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
