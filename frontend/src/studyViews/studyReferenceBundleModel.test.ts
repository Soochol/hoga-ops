import { describe, expect, it } from 'vitest';
import type { StudyViewReference } from '../api/studyViews';
import type { Candle, RangeBundle } from '../api/types';
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
      points: [{ t: 1_000, bid_total: 100, ask_total: 90, bid_max: 100, ask_max: 90, imb_max_bid: 100, imb_max_ask: 90, band_pct: 0 }],
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

  it('캘린더 저장은 **스크리너 일봉만** 요청한다 (1분봉 입력이 전부 null)', () => {
    expect(studyReferenceQueryInputs({ ...save, timeframe: 'D' })).toMatchObject({
      isMinute: false,
      range: { code: null, from: null, to: null, timeframe: null },
      // 예전엔 여기가 `{ code, from, to, timeframe: '1m' }` 이었다 —
      // 일봉 98개를 그리려고 1분봉 36,000개를 받던 경로(`aggregateReferenceCandles` 주석).
      candles: { code: null, from: null, to: null, timeframe: null },
      screenerDaily: { code: '005930', from: '20260616', to: '20260618' },
    });
  });

  it('구간이 아무리 넓어도 1분봉을 요청하지 않는다 — 캡이 아니라 부재다', () => {
    // 예전에는 `initialHistoricalDaysFor` 캡으로 "월봉 10년치 1분봉 전량 요청" 을
    // 막았다. 이제 캘린더 봉은 그 쿼리를 아예 안 걸므로 캡이 지킬 것이 없다.
    const to = '20260618';
    expect(studyReferenceQueryInputs({
      ...save,
      timeframe: 'M',
      range: { ...save.range, from_date: '20200101', to_date: to },
    })).toMatchObject({
      candles: { code: null, from: null, to: null, timeframe: null },
      // 스크리너 일봉은 저장 구간 전체를 그대로 커버한다.
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

  it('injects segment sessions (KRX meta) for UN fallback study reference minute charts', () => {
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
      venue: 'UN',
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

  it('캘린더 봉은 hogaplay 1분봉을 **무시한다** — 넘겨도 화면에 안 들어온다', () => {
    // 09:00 KST = 00:00 UTC. 예전에는 이 바들이 정규장 필터를 거쳐 일봉으로
    // 집계됐다. 이제 캘린더 경로는 1분봉을 아예 안 받으므로(쿼리가 비활성),
    // 설령 넘어와도 무시하는 것이 계약이다.
    const model = buildStudyReferenceBundleModel({
      save: { ...save, timeframe: 'D', range: { ...save.range, from_date: '20260616', to_date: '20260616' } },
      venue: 'KRX',
      pastBundle: null,
      rangeCandles: [
        candle(Date.UTC(2026, 5, 16, 0, 0), 1, 2, 1, 2, 10),
        candle(Date.UTC(2026, 5, 16, 1, 0), 3, 9, 3, 5, 5),
      ],
      screenerDailyCandles: [],
    });

    expect(model.bundle?.candles).toEqual([]);
  });

  it('주가 기준이 다른 두 소스를 **섞지 않는다** — 분할 종목의 봉 스파이크 회귀', () => {
    // 이 PR 을 낳은 실측(010120, 5:1 액면분할): 스크리너는 수정주가, hogaplay
    // 1분봉은 그날의 원주가다. 예전 병합은 hogaplay 를 우선하고 없는 날만 스크리너로
    // 채웠는데, 그 하루가 close 293,000 → **57,300** → 278,500 으로 꽂혔다.
    //
    // 여기서는 그 모양을 그대로 재현한다: hogaplay 가 이틀만 있고(원주가 배수 5),
    // 가운데 하루가 비었다. 병합이 살아 있으면 가운데만 1/5 로 튄다.
    const d16 = Date.UTC(2026, 5, 16, 0, 0);
    const d17 = Date.UTC(2026, 5, 17, 0, 0);
    const d18 = Date.UTC(2026, 5, 18, 0, 0);
    const model = buildStudyReferenceBundleModel({
      save: { ...save, timeframe: 'D', range: { ...save.range, from_date: '20260616', to_date: '20260618' } },
      venue: 'KRX',
      pastBundle: null,
      // hogaplay 원주가 — 20260617 만 캡처 공백.
      rangeCandles: [
        candle(d16, 250_000, 300_000, 250_000, 293_000, 10),
        candle(d18, 250_000, 300_000, 250_000, 278_500, 10),
      ],
      // 스크리너 수정주가 — 세 날 모두 있고, 전부 1/5 스케일이다.
      screenerDailyCandles: [
        { t_ms: d16, open: 50_000, high: 60_000, low: 50_000, close: 58_600, volume: 1 },
        { t_ms: d17, open: 50_000, high: 60_000, low: 50_000, close: 57_300, volume: 2 },
        { t_ms: d18, open: 50_000, high: 60_000, low: 50_000, close: 55_700, volume: 3 },
      ],
    });

    // 전부 스크리너(수정주가) — 한 축으로 일관된다.
    expect(model.bundle?.candles.map((c) => c.close)).toEqual([58_600, 57_300, 55_700]);
    // 병합이 되살아나면 [293000, 57300, 278500] 이 되어 가운데가 1/5 로 튄다.
    const closes = model.bundle?.candles.map((c) => c.close) ?? [];
    const maxRatio = Math.max(...closes) / Math.min(...closes);
    expect(maxRatio).toBeLessThan(2);
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

describe('studyReferenceBundleModel — 캘린더 맥락 창(studyDailyContext)', () => {
  const d15 = Date.UTC(2026, 5, 15, 0, 0);
  const d16 = Date.UTC(2026, 5, 16, 0, 0);
  const d22 = Date.UTC(2026, 5, 22, 0, 0);
  const window = { from: '20260601', to: '20260630' };
  const dailySave = { ...save, timeframe: 'D' as const };
  const screener = [
    { t_ms: d15, open: 1, high: 2, low: 1, close: 15, volume: 1 },
    { t_ms: d16, open: 1, high: 2, low: 1, close: 16, volume: 1 },
    { t_ms: d22, open: 1, high: 2, low: 1, close: 22, volume: 1 },
  ];

  it('창이 없으면 저장 구간(20260616~18) 밖 일봉을 버린다 — 지금까지의 동작', () => {
    const model = buildStudyReferenceBundleModel({
      save: dailySave, venue: 'KRX', pastBundle: null, rangeCandles: [], screenerDailyCandles: screener,
    });

    expect(model.chartBundle?.candles.map((c) => c.close)).toEqual([16]);
  });

  it('창이 있으면 저장 구간 앞뒤 일봉이 살아남는다', () => {
    const model = buildStudyReferenceBundleModel({
      save: dailySave, venue: 'KRX', pastBundle: null, rangeCandles: [], screenerDailyCandles: screener,
      dailyContext: window,
    });

    expect(model.chartBundle?.candles.map((c) => c.close)).toEqual([15, 16, 22]);
  });

  it('축 기준일은 마지막 캔들 날짜다 — 저장 끝을 쓰면 세그먼트 순서가 깨진다', () => {
    const model = buildStudyReferenceBundleModel({
      save: dailySave, venue: 'KRX', pastBundle: null, rangeCandles: [], screenerDailyCandles: screener,
      dailyContext: window,
    });

    // to_date 가 저장 끝(20260618)이나 요청 상한(20260630)이 아니라 실제 마지막 캔들.
    expect(model.chartBundle?.to_date).toBe('20260622');
    expect(model.chartBundle?.from_date).toBe('20260601');
  });

  it('분봉 저장은 창을 넘겨도 무시한다 — 분봉 경로는 저장 구간 클립 그대로', () => {
    const minute = buildStudyReferenceBundleModel({
      save, venue: 'KRX', pastBundle: pastBundle(),
      rangeCandles: [candle(1_000, 1, 2, 1, 2, 10), candle(9_999_999, 1, 2, 1, 3, 10)],
      screenerDailyCandles: [],
      dailyContext: window,
    });

    // 창 안(20260601~30)이지만 저장 구간(to_ms 3000) 밖인 캔들은 여전히 잘린다.
    expect(minute.chartBundle?.candles.map((c) => c.close)).not.toContain(3);
    expect(minute.chartBundle?.from_date).toBe('20260616');
    expect(minute.chartBundle?.to_date).toBe('20260618');
  });

  it('창은 screenerDaily 쿼리만 넓힌다 — 이제 그것이 캘린더 봉의 유일한 소스다', () => {
    const inputs = studyReferenceQueryInputs(dailySave, window);

    expect(inputs.screenerDaily).toMatchObject({ from: '20260601', to: '20260630' });
    // 1분봉은 캘린더 봉에서 아예 안 걸린다 — 창이 있든 없든 null 이다.
    expect(inputs.candles).toMatchObject({ code: null, from: null, to: null });
  });
});

describe('studyReferenceBundleModel — 결손 사유 보존', () => {
  it('missing_dates 를 번들까지 실어 나른다', () => {
    // #1333 계보: `/study` 번들은 **명시 복사 목록**으로 조립되므로, 목록에 없는
    // 슬라이스는 응답에 있어도 화면에 도달하지 못한다. 결손 사유는 하필 "화면이
    // 아무 말도 안 하는" 증상을 고치려고 만든 값이라, 여기서 떨어지면 기능 전체가
    // 조용히 무동작이 된다.
    const past = pastBundle();
    past.missing_dates = [{ date: '20251218', reason: 'no_upstream_data' }];

    const model = buildStudyReferenceBundleModel({
      save: { ...save, range: { ...save.range, from_ms: 0, to_ms: 300_000 } },
      venue: 'KRX',
      pastBundle: past,
      rangeCandles: [candle(1_000, 1, 2, 1, 2, 10)],
      screenerDailyCandles: [],
    });

    expect(model.bundle?.missing_dates).toEqual([
      { date: '20251218', reason: 'no_upstream_data' },
    ]);
  });
});
