import { describe, it, expect } from 'vitest';
import { buildAskPeakSegments, buildAskPeakOverlaySegments } from './LiveAskPeakSegments';
import type { AskPeak, RangeSegment, Candle } from '../api/types';
import type { VirtualAxis } from '../util/virtualAxis';

// 항등 축: toVirtual(ms)=ms → time = ms/1000.
const axis = { toVirtual: (ms: number) => ms } as unknown as VirtualAxis;
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
const peakWithUntraded = (
  base: Pick<AskPeak, 'date' | 'price' | 'qty' | 't_ms'>,
  untraded: Pick<AskPeak, 'price' | 'qty' | 't_ms'>,
): AskPeak => ({
  ...peak(base),
  untraded_price: untraded.price,
  untraded_qty: untraded.qty,
  untraded_t_ms: untraded.t_ms,
  untraded_max_price: untraded.price,
  untraded_max_qty: untraded.qty,
  untraded_max_t_ms: untraded.t_ms,
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
    expect(today.label).toBe('323,000, 153.1k'); // 가격 + formatQtyCompact(153125)
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
    expect(out[0].label).toBe('100, 0.9k');
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
    expect(off[0].label).toBe('25,100, 0.3k');
    expect(off[0].peakTime).toBe(60);

    const on = buildAskPeakSegments(peaks, segments, candles, axis, '20260613', '#000', 1, true);
    expect(on[0].price).toBe(25200);
    expect(on[0].label).toBe('25,200, 0.9k');
    expect(on[0].peakTime).toBe(120);
    expect(on[0].time0).toBe(off[0].time0);
    expect(on[0].time1).toBe(off[0].time1);
  });
});

describe('buildAskPeakOverlaySegments', () => {
  it('오늘 미체결 qty가 체결가격 기준 qty보다 크면 별도 스타일로 둘 다 만든다', () => {
    const traded = peakWithUntraded(
      { date: '20260613', price: 100, qty: 50, t_ms: 120000 },
      { price: 110, qty: 80, t_ms: 180000 },
    );
    const segments = [seg('20260613', 60000, 240000)];
    const candles = [candle(60000), candle(120000), candle(180000)];

    const out = buildAskPeakOverlaySegments({
      dayAskPeaks: [traded],
      todayAllPriceAskPeak: null,
      segments,
      candles,
      axis,
      todayKst: '20260613',
      baselineStyle: { color: '#1D4ED8', lineWidth: 2 },
      allPriceStyle: { color: '#F97316', lineWidth: 1 },
      intraMax: false,
      showAllPrices: true,
    });

    expect(out).toHaveLength(2);
    expect(out.map((s) => s.price)).toEqual([100, 110]);
    expect(out[0]).toMatchObject({ color: '#1D4ED8', lineWidth: 2 });
    expect(out[1]).toMatchObject({ color: '#F97316', lineWidth: 1 });
  });

  it('미체결 price/time이 달라도 qty가 체결가격 기준 qty보다 크지 않으면 한 줄만 만든다', () => {
    const traded = peakWithUntraded(
      { date: '20260613', price: 100, qty: 80, t_ms: 120000 },
      { price: 110, qty: 80, t_ms: 180000 },
    );

    const out = buildAskPeakOverlaySegments({
      dayAskPeaks: [traded],
      todayAllPriceAskPeak: null,
      segments: [seg('20260613', 60000, 240000)],
      candles: [candle(60000), candle(120000), candle(180000)],
      axis,
      todayKst: '20260613',
      baselineStyle: { color: '#1D4ED8', lineWidth: 2 },
      allPriceStyle: { color: '#F97316', lineWidth: 1 },
      intraMax: false,
      showAllPrices: true,
    });

    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ price: 100, label: '100, 0.1k', color: '#1D4ED8', lineWidth: 2 });
  });

  it('all_*만 있고 untraded_*가 없으면 미체결 선을 만들지 않는다', () => {
    const past: AskPeak = {
      date: '20260611',
      price: 100,
      qty: 50,
      t_ms: 120000,
      max_price: 100,
      max_qty: 50,
      max_t_ms: 120000,
      all_price: 110,
      all_qty: 80,
      all_t_ms: 180000,
      all_max_price: 115,
      all_max_qty: 90,
      all_max_t_ms: 180000,
    };

    const out = buildAskPeakOverlaySegments({
      dayAskPeaks: [past],
      todayAllPriceAskPeak: null,
      segments: [seg('20260611', 60000, 240000)],
      candles: [candle(60000), candle(120000), candle(180000)],
      axis,
      todayKst: '20260613',
      baselineStyle: { color: '#1D4ED8', lineWidth: 2 },
      allPriceStyle: { color: '#F97316', lineWidth: 1 },
      intraMax: false,
      showAllPrices: true,
    });

    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ price: 100, color: '#1D4ED8', lineWidth: 2 });
  });

  it('intraMax=true면 미체결 선도 untraded_max_* triple을 사용한다', () => {
    const traded: AskPeak = {
      date: '20260611',
      price: 100,
      qty: 50,
      t_ms: 120000,
      max_price: 101,
      max_qty: 60,
      max_t_ms: 130000,
      untraded_price: 110,
      untraded_qty: 80,
      untraded_t_ms: 180000,
      untraded_max_price: 115,
      untraded_max_qty: 90,
      untraded_max_t_ms: 190000,
    };

    const out = buildAskPeakOverlaySegments({
      dayAskPeaks: [traded],
      todayAllPriceAskPeak: null,
      segments: [seg('20260611', 60000, 240000)],
      candles: [candle(60000), candle(120000), candle(180000)],
      axis,
      todayKst: '20260613',
      baselineStyle: { color: '#1D4ED8', lineWidth: 2 },
      allPriceStyle: { color: '#F97316', lineWidth: 1 },
      intraMax: true,
      showAllPrices: true,
    });

    expect(out).toHaveLength(2);
    expect(out.map((s) => s.price)).toEqual([101, 115]);
    expect(out[1]).toMatchObject({ label: '115, 0.1k', color: '#F97316', lineWidth: 1 });
  });

  it('intraMax=true면 untraded_max_qty가 max_qty보다 크지 않을 때 미체결 선을 만들지 않는다', () => {
    const traded: AskPeak = {
      date: '20260611',
      price: 100,
      qty: 50,
      t_ms: 120000,
      max_price: 101,
      max_qty: 90,
      max_t_ms: 130000,
      untraded_price: 110,
      untraded_qty: 120,
      untraded_t_ms: 180000,
      untraded_max_price: 115,
      untraded_max_qty: 90,
      untraded_max_t_ms: 190000,
    };

    const out = buildAskPeakOverlaySegments({
      dayAskPeaks: [traded],
      todayAllPriceAskPeak: null,
      segments: [seg('20260611', 60000, 240000)],
      candles: [candle(60000), candle(120000), candle(180000)],
      axis,
      todayKst: '20260613',
      baselineStyle: { color: '#1D4ED8', lineWidth: 2 },
      allPriceStyle: { color: '#F97316', lineWidth: 1 },
      intraMax: true,
      showAllPrices: true,
    });

    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ price: 101, label: '101, 0.1k', color: '#1D4ED8', lineWidth: 2 });
  });

  it('intraMax=true면 close 미체결 triple이 없어도 untraded_max_*만으로 오렌지 선을 만든다', () => {
    const traded: AskPeak = {
      date: '20260611',
      price: 100,
      qty: 50,
      t_ms: 120000,
      max_price: 101,
      max_qty: 60,
      max_t_ms: 130000,
      untraded_price: null,
      untraded_qty: null,
      untraded_t_ms: null,
      untraded_max_price: 115,
      untraded_max_qty: 90,
      untraded_max_t_ms: 190000,
    };

    const out = buildAskPeakOverlaySegments({
      dayAskPeaks: [traded],
      todayAllPriceAskPeak: null,
      segments: [seg('20260611', 60000, 240000)],
      candles: [candle(60000), candle(120000), candle(180000)],
      axis,
      todayKst: '20260613',
      baselineStyle: { color: '#1D4ED8', lineWidth: 2 },
      allPriceStyle: { color: '#F97316', lineWidth: 1 },
      intraMax: true,
      showAllPrices: true,
    });

    expect(out).toHaveLength(2);
    expect(out.map((s) => s.price)).toEqual([101, 115]);
    expect(out[1]).toMatchObject({ label: '115, 0.1k', color: '#F97316', lineWidth: 1 });
  });

  it('미체결 포함 토글이 꺼지면 체결가격 기준선만 만든다', () => {
    const traded = peak({ date: '20260613', price: 100, qty: 50, t_ms: 120000 });
    const allPrice = peak({ date: '20260613', price: 110, qty: 80, t_ms: 180000 });

    const out = buildAskPeakOverlaySegments({
      dayAskPeaks: [traded],
      todayAllPriceAskPeak: allPrice,
      segments: [seg('20260613', 60000, 240000)],
      candles: [candle(60000), candle(120000)],
      axis,
      todayKst: '20260613',
      baselineStyle: { color: '#1D4ED8', lineWidth: 2 },
      allPriceStyle: { color: '#F97316', lineWidth: 1 },
      intraMax: false,
      showAllPrices: false,
    });

    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ price: 100, color: '#1D4ED8', lineWidth: 2 });
  });

  it('오늘 live all-price qty가 체결가격 기준 qty보다 크면 미체결 선을 추가한다', () => {
    const traded = peak({ date: '20260613', price: 100, qty: 50, t_ms: 120000 });
    const allPrice = peak({ date: '20260613', price: 110, qty: 80, t_ms: 180000 });

    const out = buildAskPeakOverlaySegments({
      dayAskPeaks: [traded],
      todayAllPriceAskPeak: allPrice,
      segments: [seg('20260613', 60000, 240000)],
      candles: [candle(60000), candle(120000), candle(180000)],
      axis,
      todayKst: '20260613',
      baselineStyle: { color: '#1D4ED8', lineWidth: 2 },
      allPriceStyle: { color: '#F97316', lineWidth: 1 },
      intraMax: false,
      showAllPrices: true,
    });

    expect(out).toHaveLength(2);
    expect(out.map((s) => s.price)).toEqual([100, 110]);
    expect(out[1]).toMatchObject({ label: '110, 0.1k', color: '#F97316', lineWidth: 1 });
  });

  it('오늘 live all-price 후보는 rank limit만큼 체결 기준선 뒤에 추가한다', () => {
    const traded = peak({ date: '20260613', price: 100, qty: 50, t_ms: 120000 });
    const allPrice: AskPeak = {
      ...peak({ date: '20260613', price: 110, qty: 90, t_ms: 180000 }),
      all_peaks: [
        { price: 110, qty: 90, t_ms: 180000 },
        { price: 115, qty: 80, t_ms: 190000 },
        { price: 120, qty: 70, t_ms: 200000 },
      ],
    };

    const out = buildAskPeakOverlaySegments({
      dayAskPeaks: [traded],
      todayAllPriceAskPeak: allPrice,
      segments: [seg('20260613', 60000, 240000)],
      candles: [candle(60000), candle(120000), candle(180000), candle(190000), candle(200000)],
      axis,
      todayKst: '20260613',
      baselineStyle: { color: '#1D4ED8', lineWidth: 2 },
      allPriceStyle: { color: '#F97316', lineWidth: 1 },
      intraMax: false,
      showAllPrices: true,
      allPriceRankLimit: 2,
    });

    expect(out).toHaveLength(3);
    expect(out.map((s) => s.price)).toEqual([100, 110, 115]);
  });

  it('오늘 체결가격 기준선과 미체결 포함 triple이 같으면 한 줄만 만든다', () => {
    const traded = peak({ date: '20260613', price: 100, qty: 50, t_ms: 120000 });
    const allPrice = peak({ date: '20260613', price: 100, qty: 50, t_ms: 120000 });

    const out = buildAskPeakOverlaySegments({
      dayAskPeaks: [traded],
      todayAllPriceAskPeak: allPrice,
      segments: [seg('20260613', 60000, 240000)],
      candles: [candle(60000), candle(120000)],
      axis,
      todayKst: '20260613',
      baselineStyle: { color: '#1D4ED8', lineWidth: 2 },
      allPriceStyle: { color: '#F97316', lineWidth: 1 },
      intraMax: false,
      showAllPrices: true,
    });

    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ price: 100, color: '#1D4ED8', lineWidth: 2 });
  });

  it('아직 체결가격 기준 peak가 없으면 토글 ON이어도 미체결 포함 선을 단독 표시하지 않는다', () => {
    const allPrice = peakWithUntraded(
      { date: '20260613', price: 100, qty: 50, t_ms: 120000 },
      { price: 110, qty: 80, t_ms: 180000 },
    );

    const out = buildAskPeakOverlaySegments({
      dayAskPeaks: [],
      todayAllPriceAskPeak: allPrice,
      segments: [seg('20260613', 60000, 240000)],
      candles: [candle(60000), candle(120000), candle(180000)],
      axis,
      todayKst: '20260613',
      baselineStyle: { color: '#1D4ED8', lineWidth: 2 },
      allPriceStyle: { color: '#F97316', lineWidth: 1 },
      intraMax: false,
      showAllPrices: true,
    });

    expect(out).toHaveLength(0);
  });

  it('과거일 AskPeak의 untraded_* 필드로 미체결 선을 추가한다', () => {
    const past: AskPeak = {
      date: '20260611',
      price: 100,
      qty: 50,
      t_ms: 120000,
      max_price: 100,
      max_qty: 50,
      max_t_ms: 120000,
      untraded_price: 110,
      untraded_qty: 80,
      untraded_t_ms: 180000,
      untraded_max_price: 115,
      untraded_max_qty: 90,
      untraded_max_t_ms: 180000,
    };

    const out = buildAskPeakOverlaySegments({
      dayAskPeaks: [past],
      todayAllPriceAskPeak: null,
      segments: [seg('20260611', 60000, 240000)],
      candles: [candle(60000), candle(120000), candle(180000)],
      axis,
      todayKst: '20260613',
      baselineStyle: { color: '#1D4ED8', lineWidth: 2 },
      allPriceStyle: { color: '#F97316', lineWidth: 1 },
      intraMax: false,
      showAllPrices: true,
    });

    expect(out).toHaveLength(2);
    expect(out.map((s) => s.price)).toEqual([100, 110]);
    expect(out[1]).toMatchObject({ color: '#F97316', lineWidth: 1 });
  });
});
