import { describe, expect, it } from 'vitest';
import type { StudyViewReference } from '../api/studyViews';
import type { RangeBundle } from '../api/types';
import { initialHistoricalDaysFor, subtractDaysKst } from '../live/liveDateTime';
import { buildStudyReferenceBundleModel, studyReferenceQueryInputs } from './studyReferenceBundleModel';

const save: StudyViewReference = {
  schema_version: 2,
  id: 'ref1',
  name: '복기',
  code: '005930',
  label: '삼성전자',
  timeframe: '5m',
  range: { from_date: '20260616', to_date: '20260618', from_ms: 1_000, to_ms: 3_000 },
  viewport: { right_edge_ms: 3_000, bar_span: 120, at_live_edge: false },
  memo: '',
  tags: [],
  created_at_ms: 1,
  updated_at_ms: 2,
};

function pastBundle(): RangeBundle {
  return {
    code: '005930',
    from_date: '20260616',
    to_date: '20260618',
    bucket_ms: 300_000,
    segments: [{ date: '20260616', session_open_ms: 1_000, session_close_ms: 4_000, source: 'hogaplay' }],
    candles: [],
    quote_ratio: {
      bucket_ms: 300_000,
      points: [{ t: 1_000, bid_total: 100, ask_total: 90, bid_max: 100, ask_max: 90, imb_max_bid: 100, imb_max_ask: 90 }],
    },
    fill_strength: { bucket_ms: 300_000, points: [{ t: 1_000, buy_qty: 5, sell_qty: 4 }] },
    program_trade: { points: [{ t: 1_000, net_qty: 10, net_amount: 100, delta_qty: 10, delta_amount: 100, gap_risk: false }], source: 'kis_program_trade' },
    volume_profile_range: { bin_count: 0, price_min: 0, price_max: 0, bin_width: 0, bins: [] },
    volume_profile_by_day: [],
    volume_distributions: [],
    investorPoints: [],
    ask_peaks: [],
    bid_peaks: [],
    price_level_hits: [],
    trade_volume_pocs: [],
    broker_late_entries: [],
  };
}

describe('studyReferenceBundleModel', () => {
  it('derives query inputs for minute reference saves', () => {
    expect(studyReferenceQueryInputs(save)).toMatchObject({
      isMinute: true,
      bucketMs: 300_000,
      range: { code: '005930', from: '20260616', to: '20260618', timeframe: '5m' },
      minuteCandles: { code: '005930', from: '20260616', to: '20260618' },
      dailyCandles: { code: null, from: null, to: null },
    });
  });

  it('derives query inputs for calendar reference saves', () => {
    expect(studyReferenceQueryInputs({ ...save, timeframe: 'D' })).toMatchObject({
      isMinute: false,
      range: { code: null, from: null, to: null, timeframe: null },
      minuteCandles: { code: null, from: null, to: null },
      dailyCandles: { code: '005930', from: '20260616', to: '20260618' },
    });
  });

  it('limits daily study candle requests to the live initial calendar window', () => {
    const to = '20260618';
    expect(studyReferenceQueryInputs({
      ...save,
      timeframe: 'D',
      range: { ...save.range, from_date: '20200101', to_date: to },
    })).toMatchObject({
      dailyCandles: {
        code: '005930',
        from: subtractDaysKst(to, initialHistoricalDaysFor('D')),
        to,
      },
    });
  });

  it('builds a chart-ready bundle and preserves range hoga series for minute saves', () => {
    const past = pastBundle();
    const model = buildStudyReferenceBundleModel({
      save: { ...save, range: { ...save.range, from_ms: 0, to_ms: 300_000 } },
      venue: 'KRX',
      pastBundle: past,
      minuteCandles: [
        { t_ms: 3_000, open: 3, high: 4, low: 3, close: 4, volume: 12 },
        { t_ms: 1_000, open: 1, high: 2, low: 1, close: 2, volume: 10 },
      ],
      dailyCandles: [],
    });

    expect(model.chartBundle?.candles.map((c) => c.ts_ms)).toEqual([0]);
    expect(model.bundle?.quote_ratio).toBe(past.quote_ratio);
    expect(model.bundle?.fill_strength).toBe(past.fill_strength);
    expect(model.bundle?.broker_late_entries).toEqual([]);
    expect(model.bundle?.from_date).toBe('20260616');
    expect(model.bundle?.to_date).toBe('20260618');
  });

  it('uses effective KRX sessions for NXT fallback study reference minute charts', () => {
    const model = buildStudyReferenceBundleModel({
      save: {
        ...save,
        range: {
          ...save.range,
          from_date: '20260616',
          to_date: '20260616',
          from_ms: 0,
          to_ms: Date.UTC(2026, 5, 16, 6, 30),
        },
      },
      venue: 'NXT',
      pastBundle: pastBundle(),
      minuteCandles: [
        { t_ms: Date.UTC(2026, 5, 16, 0, 0), open: 1, high: 2, low: 1, close: 2, volume: 10 },
      ],
      dailyCandles: [],
      minuteEffectiveSessions: [
        {
          date: '20260616',
          venue: 'KRX',
          open_ms: Date.UTC(2026, 5, 16, 0, 0),
          close_ms: Date.UTC(2026, 5, 16, 6, 30),
        },
      ],
    });

    expect(model.chartBundle?.segments.find((s) => s.date === '20260616')).toMatchObject({
      session_open_ms: Date.UTC(2026, 5, 16, 0, 0),
      session_close_ms: Date.UTC(2026, 5, 16, 6, 30),
    });
  });

  it('builds calendar bundles without requiring /api/range data', () => {
    const model = buildStudyReferenceBundleModel({
      save: { ...save, timeframe: 'D' },
      venue: 'KRX',
      pastBundle: null,
      minuteCandles: [],
      dailyCandles: [{ t_ms: Date.UTC(2026, 5, 16, 0, 0), open: 1, high: 2, low: 1, close: 2, volume: 10 }],
    });

    expect(model.bundle?.candles).toHaveLength(1);
    expect(model.bundle?.quote_ratio.points).toEqual([]);
    expect(model.chartBundle?.from_date).toBe('20260616');
  });
});
