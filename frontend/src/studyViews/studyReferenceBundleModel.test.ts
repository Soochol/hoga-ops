import { describe, expect, it } from 'vitest';
import type { StudyViewReference } from '../api/studyViews';
import type { Candle, RangeBundle } from '../api/types';
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

function candle(ts_ms: number, open: number, high: number, low: number, close: number, vol: number): Candle {
  return { ts_ms, open, high, low, close, vol_a: vol, vol_b: 0 };
}

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
      candles: { code: '005930', from: '20260616', to: '20260618', timeframe: '5m' },
      screenerDaily: { code: null, from: null, to: null },
    });
  });

  it('derives query inputs for calendar reference saves (1m disk candles + screener gap-fill)', () => {
    expect(studyReferenceQueryInputs({ ...save, timeframe: 'D' })).toMatchObject({
      isMinute: false,
      range: { code: null, from: null, to: null, timeframe: null },
      candles: { code: '005930', from: '20260616', to: '20260618', timeframe: '1m' },
      screenerDaily: { code: '005930', from: '20260616', to: '20260618' },
    });
  });

  it('caps the daily 1m candle window to the live initial calendar window; screener covers the full range', () => {
    const to = '20260618';
    expect(studyReferenceQueryInputs({
      ...save,
      timeframe: 'D',
      range: { ...save.range, from_date: '20200101', to_date: to },
    })).toMatchObject({
      candles: {
        code: '005930',
        from: subtractDaysKst(to, initialHistoricalDaysFor('D')),
        to,
        timeframe: '1m',
      },
      // 스크리너 일봉은 캡 밖(2020~)까지 저장 구간 전체를 커버해 갭을 채운다.
      screenerDaily: { code: '005930', from: '20200101', to },
    });
  });

  it('builds a chart-ready bundle and preserves range hoga series for minute saves', () => {
    const past = pastBundle();
    const model = buildStudyReferenceBundleModel({
      save: { ...save, range: { ...save.range, from_ms: 0, to_ms: 300_000 } },
      venue: 'KRX',
      pastBundle: past,
      rangeCandles: [
        candle(3_000, 3, 4, 3, 4, 12),
        candle(1_000, 1, 2, 1, 2, 10),
      ],
      screenerDailyCandles: [],
    });

    expect(model.chartBundle?.candles.map((c) => c.ts_ms)).toEqual([0]);
    expect(model.bundle?.quote_ratio).toBe(past.quote_ratio);
    expect(model.bundle?.fill_strength).toBe(past.fill_strength);
    expect(model.bundle?.broker_late_entries).toEqual([]);
    expect(model.bundle?.from_date).toBe('20260616');
    expect(model.bundle?.to_date).toBe('20260618');
  });

  it('injects segment sessions (KRX meta) for NXT fallback study reference minute charts', () => {
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
      rangeCandles: [candle(Date.UTC(2026, 5, 16, 0, 0), 1, 2, 1, 2, 10)],
      screenerDailyCandles: [],
      sessions: [
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

  it('aggregates hogaplay 1m into daily bars, filtering non-regular-session bars', () => {
    // 09:00 KST = 00:00 UTC; 16:30 KST = 07:30 UTC (장 마감 이후, 제외돼야 함).
    const inSessionOpen = Date.UTC(2026, 5, 16, 0, 0);
    const inSessionMid = Date.UTC(2026, 5, 16, 1, 0);
    const afterClose = Date.UTC(2026, 5, 16, 7, 30);
    const model = buildStudyReferenceBundleModel({
      save: { ...save, timeframe: 'D', range: { ...save.range, from_date: '20260616', to_date: '20260616' } },
      venue: 'KRX',
      pastBundle: null,
      rangeCandles: [
        candle(inSessionOpen, 1, 2, 1, 2, 10),
        candle(inSessionMid, 3, 9, 3, 5, 5),
        candle(afterClose, 100, 200, 100, 150, 99), // 정규장 밖 → OHLC에 반영 안 됨
      ],
      screenerDailyCandles: [],
    });

    // 정규장 두 바만 집계: open=1, high=9, low=1, close=5, vol=15.
    expect(model.bundle?.candles).toHaveLength(1);
    expect(model.bundle?.candles[0]).toMatchObject({ open: 1, high: 9, low: 1, close: 5 });
  });

  it('prefers hogaplay daily and fills capture gaps with screener daily', () => {
    const d16 = Date.UTC(2026, 5, 16, 0, 0);
    const d17 = Date.UTC(2026, 5, 17, 0, 0);
    const model = buildStudyReferenceBundleModel({
      save: { ...save, timeframe: 'D', range: { ...save.range, from_date: '20260616', to_date: '20260617' } },
      venue: 'KRX',
      pastBundle: null,
      // hogaplay 1m는 20260616만 캡처됨.
      rangeCandles: [candle(d16, 1, 4, 1, 4, 10)],
      // 스크리너 일봉은 두 날짜 모두 있으나 20260616은 hogaplay가 이겨야 함.
      screenerDailyCandles: [
        { t_ms: d16, open: 90, high: 99, low: 90, close: 999, volume: 1 },
        { t_ms: d17, open: 50, high: 55, low: 45, close: 50, volume: 2 },
      ],
    });

    // 20260616 = hogaplay close 4, 20260617 = screener close 50 (갭 채움).
    expect(model.bundle?.candles.map((c) => c.close)).toEqual([4, 50]);
  });

  it('builds calendar bundles from screener daily alone when no hogaplay capture exists', () => {
    const model = buildStudyReferenceBundleModel({
      save: { ...save, timeframe: 'D' },
      venue: 'KRX',
      pastBundle: null,
      rangeCandles: [],
      screenerDailyCandles: [{ t_ms: Date.UTC(2026, 5, 16, 0, 0), open: 1, high: 2, low: 1, close: 2, volume: 10 }],
    });

    expect(model.bundle?.candles).toHaveLength(1);
    expect(model.bundle?.quote_ratio.points).toEqual([]);
    expect(model.chartBundle?.from_date).toBe('20260616');
  });
});
