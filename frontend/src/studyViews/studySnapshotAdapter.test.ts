import { describe, expect, it } from 'vitest';
import { studySnapshotBundleToRangeBundle } from './studySnapshotAdapter';
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
    expect(bundle.quote_ratio.points[0]).toMatchObject({ t: 1000, bid_total: 100, ask_total: 90 });
    expect(bundle.quote_ratio.points).toHaveLength(1);
    expect(bundle.fill_strength.points[0]).toMatchObject({ t: 1000, buy_qty: 5, sell_qty: 4 });
    expect(bundle.volume_profile_range).toEqual({ bin_count: 0, price_min: 0, price_max: 0, bin_width: 0, bins: [] });
    expect(bundle.volume_profile_by_day).toEqual([]);
    expect(bundle.investorPoints).toEqual([]);
    expect(bundle.ask_peaks).toEqual([]);
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

  it('uses inert date defaults when a snapshot has no segments', () => {
    const bundle = studySnapshotBundleToRangeBundle(snapshot({ segments: [] }));

    expect(bundle.from_date).toBe('');
    expect(bundle.to_date).toBe('');
  });
});
