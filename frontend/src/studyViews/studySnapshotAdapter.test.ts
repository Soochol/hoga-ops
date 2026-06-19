import { describe, expect, it } from 'vitest';
import {
  bucketStartForCursor,
  studyBrokerBucketsToSeries,
  studySnapshotBundleToChartInput,
  studySnapshotBundleToRangeBundle,
  studySnapshotDetails,
} from './studySnapshotAdapter';
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
    bid_peaks: [{
      date: '20260616',
      price: 69_900,
      qty: 4_800,
      t_ms: 1_000,
      max_price: 69_800,
      max_qty: 5_800,
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
    expect(bundle.bid_peaks).toEqual([{
      date: '20260616',
      price: 69_900,
      qty: 4_800,
      t_ms: 1_000,
      max_price: 69_800,
      max_qty: 5_800,
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
    expect(input.bundle.bid_peaks).toEqual([{
      date: '20260616',
      price: 69_900,
      qty: 4_800,
      t_ms: 1_000,
      max_price: 69_800,
      max_qty: 5_800,
      max_t_ms: 1_000,
    }]);
    expect(input.chartBundle.bid_peaks).toBe(input.bundle.bid_peaks);
    expect(input.ratioBundle.bid_peaks).toEqual(input.bundle.bid_peaks);
  });

  it('uses inert date defaults when a snapshot has no segments', () => {
    const bundle = studySnapshotBundleToRangeBundle(snapshot({ segments: [] }));

    expect(bundle.from_date).toBe('');
    expect(bundle.to_date).toBe('');
  });

  it('builds orderbook and broker lookup maps from saved detail buckets', () => {
    const s = snapshot({
      orderbook_buckets: [{
        t: 1000,
        available: true,
        snapshot: {
          ts_ms: 1999,
          seq: 1,
          ask: Array.from({ length: 10 }, (_, i) => ({ price: 101 + i, qty: 10 + i })),
          bid: Array.from({ length: 10 }, (_, i) => ({ price: 100 - i, qty: 20 + i })),
          tot_ask: 145,
          tot_bid: 245,
        },
      }],
      broker_buckets: [{
        t: 1000,
        available: true,
        brokers: [{ broker: '키움증권', net: 100, dominant_side: 'buy' }],
      }],
      detail_warnings: [{
        kind: 'broker',
        t: 1000,
        code: '005930',
        date: '20260616',
        message: 'partial broker detail',
      }],
    } as Partial<StudySnapshotBundle>);

    const details = studySnapshotDetails(s);

    expect(details.orderbookByBucketStart.get(1000)?.snapshot?.seq).toBe(1);
    expect(details.brokersByBucketStart.get(1000)?.brokers[0].net).toBe(100);
    expect(details.detailWarnings[0].message).toBe('partial broker detail');
  });

  it('builds broker trajectory series from saved broker buckets', () => {
    const s = snapshot({
      broker_buckets: [
        {
          t: 1000,
          available: true,
          brokers: [
            { broker: '키움증권', net: 100, dominant_side: 'buy' },
            { broker: 'JP모간', net: -80, dominant_side: 'sell' },
          ],
        },
        {
          t: 2000,
          available: false,
          brokers: [],
        },
        {
          t: 3000,
          available: true,
          brokers: [
            { broker: '키움증권', net: 250, dominant_side: 'buy' },
            { broker: '미래에셋증권', net: 300, dominant_side: 'buy' },
          ],
        },
      ],
    } as Partial<StudySnapshotBundle>);

    const series = studyBrokerBucketsToSeries(studySnapshotDetails(s).brokersByBucketStart);

    expect(series.map((entry) => entry.broker)).toEqual(['미래에셋증권', '키움증권', 'JP모간']);
    expect(series.find((entry) => entry.broker === '키움증권')?.points).toEqual([
      { ts_ms: 1000, net: 100 },
      { ts_ms: 3000, net: 250 },
    ]);
    expect(series.find((entry) => entry.broker === 'JP모간')).toMatchObject({
      final_net: -80,
      dominant_side: 'sell',
      points: [{ ts_ms: 1000, net: -80 }],
    });
  });

  it('limits broker trajectory series to the active session range', () => {
    const s = snapshot({
      broker_buckets: [
        {
          t: 1000,
          available: true,
          brokers: [{ broker: '키움증권', net: 999, dominant_side: 'buy' }],
        },
        {
          t: 100_000,
          available: true,
          brokers: [{ broker: '키움증권', net: 100, dominant_side: 'buy' }],
        },
        {
          t: 101_000,
          available: true,
          brokers: [{ broker: '키움증권', net: 200, dominant_side: 'buy' }],
        },
      ],
    } as Partial<StudySnapshotBundle>);

    const series = studyBrokerBucketsToSeries(studySnapshotDetails(s).brokersByBucketStart, {
      fromMs: 100_000,
      toMs: 101_999,
    });

    expect(series).toHaveLength(1);
    expect(series[0]).toMatchObject({
      broker: '키움증권',
      final_net: 200,
      dominant_side: 'buy',
      points: [
        { ts_ms: 100_000, net: 100 },
        { ts_ms: 101_000, net: 200 },
      ],
    });
  });

  it('orders broker series by absolute final net within the saved range', () => {
    const s = snapshot({
      broker_buckets: [
        {
          t: 1000,
          available: true,
          brokers: [
            { broker: 'A증권', net: 10, dominant_side: 'buy' },
            { broker: 'B증권', net: 20, dominant_side: 'buy' },
            { broker: 'C증권', net: 30, dominant_side: 'buy' },
          ],
        },
        {
          t: 100_000,
          available: true,
          brokers: [
            { broker: 'B증권', net: 900, dominant_side: 'buy' },
            { broker: 'D증권', net: 800, dominant_side: 'buy' },
            { broker: 'A증권', net: 700, dominant_side: 'buy' },
          ],
        },
        {
          t: 101_000,
          available: true,
          brokers: [
            { broker: 'E증권', net: 1000, dominant_side: 'buy' },
            { broker: 'A증권', net: 600, dominant_side: 'buy' },
            { broker: 'C증권', net: 500, dominant_side: 'buy' },
          ],
        },
      ],
    } as Partial<StudySnapshotBundle>);
    const details = studySnapshotDetails(s);

    const secondDay = studyBrokerBucketsToSeries(details.brokersByBucketStart, {
      fromMs: 100_000,
      toMs: 101_999,
    });

    expect(secondDay.map((entry) => entry.broker)).toEqual(['E증권', 'B증권', 'D증권', 'A증권', 'C증권']);
  });

  it('resolves cursor time by containing bucket, not nearest bucket', () => {
    const candles = [{ ts_ms: 1000 }, { ts_ms: 2000 }, { ts_ms: 3000 }];

    expect(bucketStartForCursor(candles, 1000, 1999)).toBe(1000);
    expect(bucketStartForCursor(candles, 1000, 2000)).toBe(2000);
    expect(bucketStartForCursor(candles, 1000, 999)).toBeNull();
  });
});
