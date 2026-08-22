import { describe, it, expect } from 'vitest';
import {
  buildAskPeakSegments,
  buildAskPeakOverlaySegments,
  prepareAskPeakSegmentsForRender,
  styleVisibleMaxAskPeakSegments,
} from './LiveAskPeakSegments';
import {
  buildBidPeakOverlaySegments,
  prepareBidPeakSegmentsForRender,
} from './LiveBidPeakSegments';
import type { AskPeak, BidPeak, RangeSegment, Candle } from '../api/types';
import type { VirtualAxis } from '../util/virtualAxis';
import { createVirtualAxis } from '../util/virtualAxis';
import type { Time } from 'lightweight-charts';

// 항등 축: toVirtual(ms)=ms → time = ms/1000.
// contains: 이동평균 필터가 MovingAverageOverlay 와 같은 「세션 안 캔들」 배열 위에서
// SMA 를 재므로 스텁도 그 축을 갖는다 — 픽스처 캔들은 전부 세션 안이다.
const axis = { toVirtual: (ms: number) => ms, contains: () => true } as unknown as VirtualAxis;
const t = (time: number): Time => time as Time;
const seg = (date: string, o: number, c: number): RangeSegment =>
  ({ date, session_open_ms: o, session_close_ms: c }) as RangeSegment;
const candle = (ts_ms: number): Candle =>
  ({ ts_ms, open: 0, close: 0, high: 0, low: 0, vol_a: 0, vol_b: 0 });
const peak = (p: Pick<AskPeak, 'date' | 'price' | 'qty' | 't_ms'>): AskPeak => ({
  ...p,
  max_price: p.price,
  max_qty: p.qty,
  max_t_ms: p.t_ms,
});
describe('buildAskPeakSegments', () => {
  it('과거일=open→close, 오늘=open→마지막 캔들(라이브 엣지) + live 플래그', () => {
    const peaks: AskPeak[] = [
      peak({ date: '20260611', price: 297000, qty: 123456, t_ms: 1 }),
      peak({ date: '20260613', price: 323000, qty: 153125, t_ms: 2 }),
    ];
    const segments = [seg('20260611', 1000, 5000), seg('20260613', 10000, 99999)];
    const candles = [candle(10500), candle(12000)]; // 마지막 12000
    const out = buildAskPeakSegments(peaks, segments, candles, axis, '20260613', '#1D4ED8', 2, false);

    const past = out.find((s) => s.price === 297000)!;
    expect(past.time0).toBe(1); // 1000/1000
    expect(past.time1).toBe(5); // close 5000/1000 (라이브 엣지 아님)
    expect(past.live).toBe(false);

    const today = out.find((s) => s.price === 323000)!;
    expect(today.time0).toBe(10); // 10000/1000
    expect(today.time1).toBe(12); // 마지막 캔들 12000/1000 (session_close 99999 아님)
    expect(today.live).toBe(true);
    expect(today.label).toBe('153.1k'); // 잔량만 — formatQtyCompact(153125)
    expect(today.qty).toBe(153125);
    expect(today.peakTime).toBe(2 / 1000); // axis.toVirtual(t_ms=2)/1000 — peak 발생 시점
    expect(today.color).toBe('#1D4ED8');
    expect(today.lineWidth).toBe(2);
  });

  it('peak 점은 그 시각이 속한 캔들(버킷 시작)에 스냅 — 1캔들 밀림 방지', () => {
    // 캔들 = 버킷 시작(60s 간격): 60000, 120000, 180000. peak t_ms=175000은 [120000,180000) 버킷.
    // 스냅 없으면 toVirtual(175000)=175 → lwc가 다음 캔들(180) 쪽으로 보간 → 1캔들 밀림.
    // 스냅하면 120000(그 버킷 캔들)로 → peakTime=120.
    const peaks: AskPeak[] = [peak({ date: '20260613', price: 100, qty: 50, t_ms: 175000 })];
    const segments = [seg('20260613', 60000, 240000)];
    const candles = [candle(60000), candle(120000), candle(180000)];
    const out = buildAskPeakSegments(peaks, segments, candles, axis, '20260613', '#000', 1, false);
    expect(out[0].peakTime).toBe(120); // 175000이 아니라 버킷 시작 120000/1000
  });

  it('1,000 미만 매도벽 수량도 k 단위 라벨로 표시', () => {
    const peaks: AskPeak[] = [peak({ date: '20260613', price: 100, qty: 900, t_ms: 120000 })];
    const segments = [seg('20260613', 60000, 240000)];
    const candles = [candle(60000), candle(120000), candle(180000)];
    const out = buildAskPeakSegments(peaks, segments, candles, axis, '20260613', '#000', 1, false);
    expect(out[0].label).toBe('0.9k');
  });

  it('peak이 마지막 캔들 버킷보다 뒤면(라이브 엣지) 마지막 캔들에 스냅', () => {
    // 오늘 라이브: peak이 현재 형성 중 버킷(마지막 캔들 이후 시각)이면 마지막 캔들에 스냅.
    const peaks: AskPeak[] = [peak({ date: '20260613', price: 100, qty: 50, t_ms: 185000 })];
    const segments = [seg('20260613', 60000, 240000)];
    const candles = [candle(60000), candle(120000), candle(180000)];
    const out = buildAskPeakSegments(peaks, segments, candles, axis, '20260613', '#000', 1, false);
    expect(out[0].peakTime).toBe(180); // 마지막 캔들 180000/1000
  });

  it('peak이 첫 캔들보다 앞서면(미로드 구간) 원시 t_ms 폴백', () => {
    const peaks: AskPeak[] = [peak({ date: '20260613', price: 100, qty: 50, t_ms: 30000 })];
    const segments = [seg('20260613', 60000, 240000)];
    const candles = [candle(60000), candle(120000)];
    const out = buildAskPeakSegments(peaks, segments, candles, axis, '20260613', '#000', 1, false);
    expect(out[0].peakTime).toBe(30); // 스냅 대상 없음 → 원시 30000/1000 (primitive 보간 폴백이 처리)
  });

  it('segment 없는 날은 건너뜀', () => {
    const out = buildAskPeakSegments(
      [peak({ date: '20260601', price: 1, qty: 1, t_ms: 1 })], [], [], axis, '20260613', '#000', 1, false,
    );
    expect(out).toEqual([]);
  });

  it('오늘이지만 캔들 없으면 session_close로 폴백', () => {
    const out = buildAskPeakSegments(
      [peak({ date: '20260613', price: 100, qty: 50, t_ms: 1 })],
      [seg('20260613', 2000, 8000)], [], axis, '20260613', '#000', 1, false,
    );
    expect(out[0].time1).toBe(8); // 캔들 없음 → close 8000/1000
  });

  it('intraMax=true면 max triple(price/qty/t_ms 대신 max_*) 선택', () => {
    const peaks: AskPeak[] = [{
      date: '20260611',
      price: 25100,
      qty: 300,
      t_ms: 100000,
      max_price: 25200,
      max_qty: 900,
      max_t_ms: 130000,
    }];
    const segments = [seg('20260611', 60000, 240000)];
    const candles = [candle(60000), candle(120000), candle(180000)];

    const off = buildAskPeakSegments(peaks, segments, candles, axis, '20260613', '#000', 1, false);
    expect(off[0].label).toBe('0.3k');
    expect(off[0].peakTime).toBe(60);

    const on = buildAskPeakSegments(peaks, segments, candles, axis, '20260613', '#000', 1, true);
    expect(on[0].price).toBe(25200);
    expect(on[0].label).toBe('0.9k');
    expect(on[0].peakTime).toBe(120);
    expect(on[0].time0).toBe(off[0].time0);
    expect(on[0].time1).toBe(off[0].time1);
  });
});

describe('styleVisibleMaxAskPeakSegments', () => {
  const baseSeg = (overrides: Partial<ReturnType<typeof buildAskPeakSegments>[number]> = {}) => ({
    time0: 10 as ReturnType<typeof buildAskPeakSegments>[number]['time0'],
    time1: 20 as ReturnType<typeof buildAskPeakSegments>[number]['time1'],
    peakTime: 15 as ReturnType<typeof buildAskPeakSegments>[number]['peakTime'],
    price: 100,
    qty: 100,
    label: '100, 0.1k',
    color: '#1D4ED8',
    lineWidth: 2,
    live: false,
    ...overrides,
  });

  it('visible range와 겹치는 세그먼트 중 qty 상위 N개를 같은 스타일로 강조한다', () => {
    const out = styleVisibleMaxAskPeakSegments(
      [
        baseSeg({ time0: 0 as never, time1: 5 as never, qty: 1000, color: '#1D4ED8' }),
        baseSeg({ time0: 10 as never, time1: 20 as never, qty: 300, color: '#1D4ED8' }),
        baseSeg({ time0: 15 as never, time1: 25 as never, qty: 500, color: '#F97316', lineWidth: 1 }),
        baseSeg({ time0: 18 as never, time1: 28 as never, qty: 400, color: '#1D4ED8' }),
      ],
      { from: t(12), to: t(22) },
      { color: '#EAB308', lineWidth: 3 },
      2,
    );

    expect(out.map((s) => ({ qty: s.qty, color: s.color, lineWidth: s.lineWidth }))).toEqual([
      { qty: 1000, color: '#1D4ED8', lineWidth: 2 },
      { qty: 300, color: '#1D4ED8', lineWidth: 2 },
      { qty: 500, color: '#EAB308', lineWidth: 3 },
      { qty: 400, color: '#EAB308', lineWidth: 3 },
    ]);
  });

  it('visible range가 없으면 원래 스타일을 유지한다', () => {
    const input = [baseSeg({ qty: 500 })];
    const out = styleVisibleMaxAskPeakSegments(input, null, { color: '#EAB308', lineWidth: 3 }, 3);
    expect(out).toEqual(input);
  });

  it('rank limit 0이면 visible max 스타일을 적용하지 않는다', () => {
    const input = [baseSeg({ qty: 500, color: '#1D4ED8', lineWidth: 2 })];
    const out = styleVisibleMaxAskPeakSegments(
      input,
      { from: t(10), to: t(20) },
      { color: '#EAB308', lineWidth: 3 },
      0,
    );
    expect(out).toEqual(input);
  });

  it('동률이면 먼저 나온 visible 세그먼트를 강조한다', () => {
    const out = styleVisibleMaxAskPeakSegments(
      [
        baseSeg({ time0: 10 as never, time1: 20 as never, qty: 500, price: 100 }),
        baseSeg({ time0: 12 as never, time1: 22 as never, qty: 500, price: 110 }),
      ],
      { from: t(10), to: t(22) },
      { color: '#EAB308', lineWidth: 3 },
      1,
    );
    expect(out[0]).toMatchObject({ color: '#EAB308', lineWidth: 3, price: 100 });
    expect(out[1]).toMatchObject({ color: '#1D4ED8', lineWidth: 2, price: 110 });
  });

  it('keeps visible max styling responsive with many peak wall segments', () => {
    const segments = Array.from({ length: 200_000 }, (_, index) => baseSeg({
      time0: index as never,
      time1: (index + 10) as never,
      peakTime: index as never,
      qty: index % 97,
      price: 10_000 + index,
    }));
    const out = styleVisibleMaxAskPeakSegments(
      segments,
      { from: t(0), to: t(200_010) },
      { color: '#EAB308', lineWidth: 3 },
      3,
    );
    const highlighted = out.filter((segment) => segment.color === '#EAB308');

    // 20만 세그먼트에서도 visible-max top 3만 하이라이트한다. 기존 벽시계
    // `elapsedMs < 40ms`(가장 타이트)는 full-suite 워커 경합에 flaky해 제거(issue
    // #434) — 대규모 입력 정확성 단언은 남는다.
    expect(highlighted).toHaveLength(3);
    expect(highlighted.map((segment) => segment.qty)).toEqual([96, 96, 96]);
  });
});

describe('buildAskPeakOverlaySegments', () => {













  it('체결가격 기준 top-N은 같은 가격 후보를 하나의 벽으로만 취급한다', () => {
    const day = '20260613';
    const out = buildAskPeakOverlaySegments({
      maFilter: null,
      dailyMaFilter: null,
      dayAskPeaks: [{
        date: day,
        price: 100400,
        qty: 22_300,
        t_ms: 60_000,
        max_price: 100400,
        max_qty: 22_300,
        max_t_ms: 60_000,
        traded_peaks: [
          { price: 100400, qty: 22_300, t_ms: 60_000 },
          { price: 100400, qty: 22_800, t_ms: 120_000 },
          { price: 100300, qty: 21_000, t_ms: 180_000 },
          { price: 100200, qty: 20_000, t_ms: 240_000 },
        ],
        traded_max_peaks: [
          { price: 100400, qty: 22_300, t_ms: 60_000 },
          { price: 100400, qty: 22_800, t_ms: 120_000 },
          { price: 100300, qty: 21_000, t_ms: 180_000 },
          { price: 100200, qty: 20_000, t_ms: 240_000 },
        ],
      }],
      segments: [seg(day, 0, 360_000)],
      candles: [candle(60_000), candle(120_000), candle(180_000), candle(240_000)],
      axis,
      todayKst: day,
      baselineStyle: { color: '#1D4ED8', lineWidth: 2 },
      intraMax: false,
      allPriceRankLimit: 3,
    });

    expect(out.map((segment) => [segment.price, segment.qty])).toEqual([
      [100400, 22_800],
      [100300, 21_000],
      [100200, 20_000],
    ]);
  });

  it('과거 날짜도 체결가격 기준 후보를 rank limit만큼 그린다', () => {
    const past: AskPeak = {
      ...peak({ date: '20260612', price: 100, qty: 100, t_ms: 120000 }),
      traded_peaks: [
        { price: 100, qty: 100, t_ms: 120000 },
        { price: 105, qty: 90, t_ms: 130000 },
        { price: 108, qty: 80, t_ms: 140000 },
      ],
    };

    const out = buildAskPeakOverlaySegments({
      maFilter: null,
      dailyMaFilter: null,
      dayAskPeaks: [past],
      segments: [seg('20260612', 60000, 240000)],
      candles: [candle(60000), candle(120000), candle(180000)],
      axis,
      todayKst: '20260613',
      baselineStyle: { color: '#1D4ED8', lineWidth: 2 },
      intraMax: false,
      allPriceRankLimit: 2,
    });

    expect(out).toHaveLength(2);
    expect(out.map((s) => s.price)).toEqual([100, 105]);
    expect(out.map((s) => s.color)).toEqual(['#1D4ED8', '#1D4ED8']);
  });

  it('오늘과 과거 날짜를 각각 rank limit만큼 함께 그린다', () => {
    const past: AskPeak = {
      ...peak({ date: '20260612', price: 100, qty: 100, t_ms: 120000 }),
      traded_peaks: [
        { price: 100, qty: 100, t_ms: 120000 },
        { price: 105, qty: 90, t_ms: 130000 },
        { price: 108, qty: 80, t_ms: 140000 },
      ],
    };
    const today = [
      peak({ date: '20260613', price: 200, qty: 200, t_ms: 220000 }),
      peak({ date: '20260613', price: 205, qty: 190, t_ms: 230000 }),
      peak({ date: '20260613', price: 208, qty: 180, t_ms: 240000 }),
    ];

    const out = buildAskPeakOverlaySegments({
      maFilter: null,
      dailyMaFilter: null,
      dayAskPeaks: [past, ...today],
      segments: [seg('20260612', 60000, 240000), seg('20260613', 260000, 440000)],
      candles: [candle(60000), candle(120000), candle(220000), candle(230000), candle(240000)],
      axis,
      todayKst: '20260613',
      baselineStyle: { color: '#1D4ED8', lineWidth: 2 },
      intraMax: false,
      allPriceRankLimit: 2,
    });

    expect(out).toHaveLength(4);
    expect(out.map((s) => s.price)).toEqual([100, 105, 200, 205]);
  });




  it('ranked 후보가 비어 있으면 scalar 기준선으로 폴백해 한 줄을 렌더한다', () => {
    const out = buildAskPeakOverlaySegments({
      maFilter: null,
      dailyMaFilter: null,
      dayAskPeaks: [{
        date: '20260613',
        price: 100,
        qty: 100,
        t_ms: 120000,
        max_price: 100,
        max_qty: 100,
        max_t_ms: 120000,
        traded_peaks: [],
        traded_max_peaks: [],
      }],
      segments: [seg('20260613', 60000, 240000)],
      candles: [candle(60000), candle(120000), candle(180000), candle(190000)],
      axis,
      todayKst: '20260613',
      baselineStyle: { color: '#1D4ED8', lineWidth: 2 },
      intraMax: false,
    });

    expect(out.map((segment) => segment.price)).toEqual([100]);
    expect(out.map((segment) => segment.color)).toEqual(['#1D4ED8']);
  });


  it('filters ask baseline candidates by visible-time cutoff', () => {
    const day = '20260613';
    const open = Date.UTC(2026, 5, 13, 0, 0);
    const peak = {
      date: day,
      price: 100,
      qty: 100,
      t_ms: open + 60_000,
      max_price: 100,
      max_qty: 100,
      max_t_ms: open + 60_000,
      traded_peaks: [
        { price: 100, qty: 100, t_ms: open + 60_000 },
        { price: 101, qty: 900, t_ms: open + 180_000 },
      ],
      traded_max_peaks: [
        { price: 100, qty: 100, t_ms: open + 60_000 },
        { price: 101, qty: 900, t_ms: open + 180_000 },
      ],
    } as never;

    const segments = buildAskPeakOverlaySegments({
      maFilter: null,
      dailyMaFilter: null,
      dayAskPeaks: [peak],
      segments: [{ date: day, session_open_ms: open, session_close_ms: open + 3600_000 }],
      candles: [{ ts_ms: open, open: 1, high: 2, low: 1, close: 2, vol_a: 1, vol_b: 0 }],
      axis: createVirtualAxis([{ date: day, sessionOpenMs: open, sessionCloseMs: open + 3600_000 }], open),
      todayKst: day,
      baselineStyle: { color: '#fff', lineWidth: 1 },
      intraMax: false,
      visibleTimeCutoff: { date: day, tMs: open + 120_000 },
    });

    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({ price: 100, qty: 100 });
  });

});

describe('live peak-wall inline label suppression', () => {
  it('suppresses ask inline labels after ask styling is applied', () => {
    const raw = buildAskPeakOverlaySegments({
      maFilter: null,
      dailyMaFilter: null,
      dayAskPeaks: [
        peak({ date: '20260612', price: 100, qty: 50, t_ms: 120000 }),
        peak({ date: '20260613', price: 110, qty: 80, t_ms: 180000 }),
      ],
      segments: [seg('20260612', 60000, 240000), seg('20260613', 60000, 240000)],
      candles: [candle(60000), candle(120000), candle(180000)],
      axis,
      todayKst: '20260613',
      baselineStyle: { color: '#1D4ED8', lineWidth: 2 },
      intraMax: false,
    });

    const inline = prepareAskPeakSegmentsForRender(
      raw,
      { from: t(1), to: t(999) },
      { color: '#EAB308', lineWidth: 3 },
      1,
    );
    expect(inline[0].live).toBe(false);
    expect(inline[0].label).toBe('');
    expect(inline[1].live).toBe(true);
    expect(inline[1]).toMatchObject({
      price: 110,
      label: '',
      color: '#EAB308',
      lineWidth: 3,
    });
  });

  it('suppresses bid inline labels', () => {
    const pastBid: BidPeak = {
      date: '20260612',
      price: 100,
      qty: 50,
      t_ms: 120000,
      max_price: 100,
      max_qty: 50,
      max_t_ms: 120000,
    };
    const todayBid: BidPeak = {
      date: '20260613',
      price: 90,
      qty: 80,
      t_ms: 180000,
      max_price: 90,
      max_qty: 80,
      max_t_ms: 180000,
    };
    const raw = buildBidPeakOverlaySegments({
      maFilter: null,
      dailyMaFilter: null,
      dayBidPeaks: [pastBid, todayBid],
      segments: [seg('20260612', 60000, 240000), seg('20260613', 60000, 240000)],
      candles: [candle(60000), candle(120000), candle(180000)],
      axis,
      todayKst: '20260613',
      baselineStyle: { color: '#2563EB', lineWidth: 2 },
      intraMax: false,
    });

    const inline = prepareBidPeakSegmentsForRender(raw);

    expect(inline[0].live).toBe(false);
    expect(inline[0].label).toBe('');
    expect(inline[1].live).toBe(true);
    expect(inline[1]).toMatchObject({ price: 90, label: '', color: '#2563EB', lineWidth: 2 });
  });
});
