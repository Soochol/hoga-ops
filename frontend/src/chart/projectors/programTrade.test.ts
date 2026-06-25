import { describe, expect, it } from 'vitest';
import type { RangeBundle } from '../../api/types';
import { createVirtualAxis } from '../../util/virtualAxis';
import { projectProgramTradeNetAmount } from './programTrade';

const OPEN = Date.UTC(2026, 4, 12, 0, 0, 0);
const CLOSE = Date.UTC(2026, 4, 12, 6, 30, 0);

function bundle(points: NonNullable<RangeBundle['program_trade']>['points']): RangeBundle {
  return {
    code: '005930',
    from_date: '20260512',
    to_date: '20260512',
    bucket_ms: 60_000,
    segments: [{ date: '20260512', session_open_ms: OPEN, session_close_ms: CLOSE }],
    candles: [],
    quote_ratio: { bucket_ms: 60_000, points: [] },
    fill_strength: { bucket_ms: 60_000, points: [] },
    volume_profile_range: { bin_count: 0, price_min: 0, price_max: 0, bin_width: 0, bins: [] },
    volume_profile_by_day: [],
    investorPoints: [],
    ask_peaks: [],
    program_trade: { points },
  };
}

describe('programTrade projector', () => {
  it('maps program_trade.points to signed net-amount histogram data', () => {
    const axis = createVirtualAxis([{ date: '20260512', sessionOpenMs: OPEN, sessionCloseMs: CLOSE }], OPEN);
    const out = projectProgramTradeNetAmount(bundle([
      { t: OPEN + 60_000, net_qty: 100, net_amount: 1_500_000, gap_risk: false },
      { t: OPEN + 120_000, net_qty: -30, net_amount: -400_000, gap_risk: false },
    ]), axis);

    expect(out.map((p) => ({ time: p.time, value: p.value }))).toEqual([
      { time: axis.toVirtual(OPEN + 60_000) / 1000, value: 1_500_000 },
      { time: axis.toVirtual(OPEN + 120_000) / 1000, value: -400_000 },
    ]);
  });

  it('returns [] when the optional sidecar is absent', () => {
    const axis = createVirtualAxis([{ date: '20260512', sessionOpenMs: OPEN, sessionCloseMs: CLOSE }], OPEN);
    const b = bundle([]);
    delete b.program_trade;
    expect(projectProgramTradeNetAmount(b, axis)).toEqual([]);
  });
});
