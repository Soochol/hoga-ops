import { describe, expect, it } from 'vitest';
import { LineSeries } from 'lightweight-charts';
import type { RangeBundle } from '../../api/types';
import { createVirtualAxis } from '../../util/virtualAxis';
import { PROGRAM_TRADE_SPEC, projectProgramTradeNetAmount } from './programTrade';

const OPEN = Date.UTC(2026, 4, 12, 0, 0, 0);
const CLOSE = Date.UTC(2026, 4, 12, 6, 30, 0);
const EXTENDED_OPEN = Date.UTC(2026, 4, 11, 23, 0, 0);
const EXTENDED_CLOSE = Date.UTC(2026, 4, 12, 11, 0, 0);
const HIDDEN_COLOR = 'rgba(0,0,0,0)';

function quotePoint(t: number, synthetic = false): RangeBundle['quote_ratio']['points'][number] {
  return {
    t,
    bid_total: synthetic ? 0 : 100,
    ask_total: synthetic ? 0 : 120,
    bid_max: synthetic ? 0 : 60,
    ask_max: synthetic ? 0 : 70,
    imb_max_bid: synthetic ? 0 : 40,
    imb_max_ask: synthetic ? 0 : 50,
    ...(synthetic ? { __syntheticHogaGap: true } : {}),
  } as RangeBundle['quote_ratio']['points'][number];
}

function bucketStart(t: number): number {
  return OPEN + Math.floor((t - OPEN) / 60_000) * 60_000;
}

function bundle(
  points: NonNullable<RangeBundle['program_trade']>['points'],
  quoteTimes = points.map((p) => bucketStart(p.t)),
): RangeBundle {
  return {
    code: '005930',
    from_date: '20260512',
    to_date: '20260512',
    bucket_ms: 60_000,
    segments: [{ date: '20260512', session_open_ms: OPEN, session_close_ms: CLOSE }],
    candles: [],
    quote_ratio: { bucket_ms: 60_000, points: quoteTimes.map((t) => quotePoint(t)) },
    fill_strength: { bucket_ms: 60_000, points: [] },
    volume_profile_range: { bin_count: 0, price_min: 0, price_max: 0, bin_width: 0, bins: [] },
    volume_profile_by_day: [],
    investorPoints: [],
    ask_peaks: [],
    volume_distributions: [],
    program_trade: { points },
  };
}

describe('programTrade projector', () => {
  it('uses a line series for cumulative program net amount', () => {
    expect(PROGRAM_TRADE_SPEC.series[0].type).toBe(LineSeries);
  });

  it('uses the live bundle because it aligns to hoga time slots', () => {
    expect(PROGRAM_TRADE_SPEC.live).toBe(true);
  });

  it('maps program_trade.points to signed cumulative net-amount line data', () => {
    const axis = createVirtualAxis([{ date: '20260512', sessionOpenMs: OPEN, sessionCloseMs: CLOSE }], OPEN);
    const out = projectProgramTradeNetAmount(bundle([
      { t: OPEN + 60_000, net_qty: 100, net_amount: 1_500_000, delta_amount: 1_500_000, gap_risk: false },
      { t: OPEN + 120_000, net_qty: -30, net_amount: -400_000, delta_amount: -1_900_000, gap_risk: false },
    ]), axis);

    expect(out.map((p) => ({ time: p.time, value: p.value }))).toEqual([
      { time: axis.toVirtual(OPEN + 60_000) / 1000, value: 1_500_000 },
      { time: axis.toVirtual(OPEN + 120_000) / 1000, value: -400_000 },
    ]);
    expect('color' in out[0]).toBe(false);
  });

  it('uses the latest cumulative value inside each display bucket', () => {
    const axis = createVirtualAxis([{ date: '20260512', sessionOpenMs: OPEN, sessionCloseMs: CLOSE }], OPEN);
    const out = projectProgramTradeNetAmount(bundle([
      { t: OPEN + 60_005, net_qty: 100, net_amount: 1_000_000, gap_risk: false },
      { t: OPEN + 60_030, net_qty: 110, net_amount: 1_100_000, gap_risk: false },
      { t: OPEN + 119_999, net_qty: 120, net_amount: 1_200_000, gap_risk: false },
    ]), axis);

    expect(out).toEqual([
      { time: axis.toVirtual(OPEN + 60_000) / 1000, value: 1_200_000 },
    ]);
  });

  it('returns [] when the optional sidecar is absent', () => {
    const axis = createVirtualAxis([{ date: '20260512', sessionOpenMs: OPEN, sessionCloseMs: CLOSE }], OPEN);
    const b = bundle([]);
    delete b.program_trade;
    expect(projectProgramTradeNetAmount(b, axis)).toEqual([]);
  });

  it('does not render program points in the NXT extended-hours window', () => {
    const b = bundle([
      { t: EXTENDED_OPEN + 30 * 60_000, net_qty: 10, net_amount: 100_000, gap_risk: false },
      { t: OPEN + 60_000, net_qty: 20, net_amount: 200_000, gap_risk: false },
      { t: CLOSE + 30 * 60_000, net_qty: 30, net_amount: 300_000, gap_risk: false },
    ], [OPEN + 60_000]);
    b.segments = [{ date: '20260512', session_open_ms: EXTENDED_OPEN, session_close_ms: EXTENDED_CLOSE }];
    const axis = createVirtualAxis([{ date: '20260512', sessionOpenMs: EXTENDED_OPEN, sessionCloseMs: EXTENDED_CLOSE }], EXTENDED_OPEN);

    expect(projectProgramTradeNetAmount(b, axis)).toEqual([
      { time: axis.toVirtual(OPEN + 60_000) / 1000, value: 200_000 },
    ]);
  });

  it('breaks the connector across hoga gap sentinels like quote totals', () => {
    const b = bundle([
      { t: OPEN + 60_000, net_qty: 10, net_amount: 100_000, gap_risk: false },
      { t: OPEN + 180_000, net_qty: 20, net_amount: 200_000, gap_risk: false },
    ], []);
    b.quote_ratio.points = [
      quotePoint(OPEN + 60_000),
      quotePoint(OPEN + 120_000, true),
      quotePoint(OPEN + 180_000),
    ];
    const axis = createVirtualAxis([{ date: '20260512', sessionOpenMs: OPEN, sessionCloseMs: CLOSE }], OPEN);

    expect(projectProgramTradeNetAmount(b, axis)).toEqual([
      { time: axis.toVirtual(OPEN + 60_000) / 1000, value: 100_000, color: HIDDEN_COLOR },
      { time: axis.toVirtual(OPEN + 120_000) / 1000, value: 0, color: HIDDEN_COLOR },
      { time: axis.toVirtual(OPEN + 180_000) / 1000, value: 200_000 },
    ]);
  });

  it('matches program points to hoga time slots by display bucket', () => {
    const b = bundle([
      { t: OPEN + 60_006, net_qty: 10, net_amount: 100_000, gap_risk: false },
      { t: OPEN + 120_006, net_qty: 20, net_amount: 200_000, gap_risk: false },
    ], []);
    b.quote_ratio.points = [
      quotePoint(OPEN + 60_004),
      quotePoint(OPEN + 120_004),
    ];
    const axis = createVirtualAxis([{ date: '20260512', sessionOpenMs: OPEN, sessionCloseMs: CLOSE }], OPEN);

    expect(projectProgramTradeNetAmount(b, axis)).toEqual([
      { time: axis.toVirtual(OPEN + 60_000) / 1000, value: 100_000 },
      { time: axis.toVirtual(OPEN + 120_000) / 1000, value: 200_000 },
    ]);
  });
});
