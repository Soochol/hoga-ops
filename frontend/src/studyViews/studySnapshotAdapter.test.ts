import { describe, expect, it } from 'vitest';
import { studySnapshotBundleToChartInput, studySnapshotBundleToRangeBundle } from './studySnapshotAdapter';
import type { StudySnapshotBundle } from '../api/studyViews';

function snapshot(overrides: Partial<StudySnapshotBundle> = {}): StudySnapshotBundle {
  return {
    code: '005930',
    timeframe: '5m',
    snapshot_from_ms: 1000,
    snapshot_to_ms: 2000,
    segments: [{ date: '20260616', session_open_ms: 1000, session_close_ms: 2000 }],
    candles: [{ t: 1000, open: 1, high: 2, low: 1, close: 2, volume: 10 }],
    quote_totals: [
      { t: 1000, bid_total: 100, ask_total: 90, visible: true },
      { t: 1500, visible: false },
    ],
    ratio: [{ t: 1000, value: 0.2, visible: true }],
    fill_strength: [{ t: 1000, buy_qty: 5, sell_qty: 4, visible: true }],
    ask_peaks: [{
      date: '20260616',
      price: 70_500,
      qty: 5_000,
      t_ms: 1_000,
      max_price: 70_700,
      max_qty: 6_000,
      max_t_ms: 1_000,
    }],
    data_warnings: ['partial'],
    ...overrides,
  };
}

describe('studySnapshotBundleToRangeBundle', () => {
  it('adapts display-locked study snapshot into RangeBundle shape', () => {
    const bundle = studySnapshotBundleToRangeBundle(snapshot());

    expect(bundle).toMatchObject({
      code: '005930',
      from_date: '20260616',
      to_date: '20260616',
      bucket_ms: 300_000,
    });
    expect(bundle.candles[0]).toMatchObject({ ts_ms: 1000, open: 1, close: 2, vol_a: 10, vol_b: 0 });
    expect(bundle.quote_ratio.points[0]).toEqual({
      t: 1000,
      bid_total: 100,
      ask_total: 90,
      bid_max: 100,
      ask_max: 90,
      imb_max_bid: 100,
      imb_max_ask: 90,
    });
    expect(bundle.quote_ratio.points).toHaveLength(1);
    expect(bundle.study_ratio.points).toEqual([{ t: 1000, value: 0.2 }]);
    expect(bundle.fill_strength.points[0]).toMatchObject({ t: 1000, buy_qty: 5, sell_qty: 4 });
    expect(bundle.volume_profile_range).toEqual({ bin_count: 0, price_min: 0, price_max: 0, bin_width: 0, bins: [] });
    expect(bundle.volume_profile_by_day).toEqual([]);
    expect(bundle.investorPoints).toEqual([]);
    expect(bundle.ask_peaks).toEqual([{
      date: '20260616',
      price: 70_500,
      qty: 5_000,
      t_ms: 1_000,
      max_price: 70_700,
      max_qty: 6_000,
      max_t_ms: 1_000,
    }]);
  });

  it('filters hidden and incomplete quote/fill points', () => {
    const bundle = studySnapshotBundleToRangeBundle(snapshot({
      quote_totals: [
        { t: 1000, bid_total: 100, ask_total: 90, visible: true },
        { t: 1100, bid_total: 101, visible: true },
        { t: 1200, bid_total: 102, ask_total: 92, visible: false },
      ],
      fill_strength: [
        { t: 1000, buy_qty: 5, sell_qty: 4, visible: true },
        { t: 1100, buy_qty: 6, visible: true },
        { t: 1200, buy_qty: 7, sell_qty: 3, visible: false },
      ],
    }));

    expect(bundle.quote_ratio.points).toEqual([{
      t: 1000,
      bid_total: 100,
      ask_total: 90,
      bid_max: 100,
      ask_max: 90,
      imb_max_bid: 100,
      imb_max_ask: 90,
    }]);
    expect(bundle.fill_strength.points).toEqual([{ t: 1000, buy_qty: 5, sell_qty: 4 }]);
  });

  it('preserves saved ratio display separately from quote totals', () => {
    const bundle = studySnapshotBundleToRangeBundle(snapshot({
      quote_totals: [{ t: 1000, bid_total: 100, ask_total: 90, visible: true }],
      ratio: [
        { t: 1000, value: -49, visible: true },
        { t: 1100, visible: true },
        { t: 1200, value: 2, visible: false },
      ],
    }));

    expect(bundle.quote_ratio.points).toEqual([{
      t: 1000,
      bid_total: 100,
      ask_total: 90,
      bid_max: 100,
      ask_max: 90,
      imb_max_bid: 100,
      imb_max_ask: 90,
    }]);
    expect(bundle.study_ratio.points).toEqual([{ t: 1000, value: -49 }]);
  });

  it('adapts saved ratio display into a chart-ready ratio bundle', () => {
    const input = studySnapshotBundleToChartInput(snapshot({
      quote_totals: [{ t: 1000, bid_total: 100, ask_total: 90, visible: true }],
      ratio: [
        { t: 1000, value: -2, visible: true },
        { t: 1100, value: 0.5, visible: true },
      ],
    }));

    expect(input.bundle.quote_ratio.points).toEqual([{
      t: 1000,
      bid_total: 100,
      ask_total: 90,
      bid_max: 100,
      ask_max: 90,
      imb_max_bid: 100,
      imb_max_ask: 90,
    }]);
    expect(input.ratioBundle.quote_ratio.points).toEqual([
      {
        t: 1000,
        bid_total: 3,
        ask_total: 1,
        bid_max: 3,
        ask_max: 1,
        imb_max_bid: 3,
        imb_max_ask: 1,
      },
      {
        t: 1100,
        bid_total: 1,
        ask_total: 1.5,
        bid_max: 1,
        ask_max: 1.5,
        imb_max_bid: 1,
        imb_max_ask: 1.5,
      },
    ]);
    expect('study_ratio' in input.ratioBundle).toBe(false);
  });

  it('uses inert date defaults when a snapshot has no segments', () => {
    const bundle = studySnapshotBundleToRangeBundle(snapshot({ segments: [] }));

    expect(bundle.from_date).toBe('');
    expect(bundle.to_date).toBe('');
  });
});
