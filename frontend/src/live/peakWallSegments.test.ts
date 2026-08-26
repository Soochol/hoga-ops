import { describe, expect, it } from 'vitest';
import type { AskPeak, BidPeak, Candle, RangeSegment } from '../api/types';
import type { VirtualAxis } from '../util/virtualAxis';
import { createVirtualAxis } from '../util/virtualAxis';
import {
  buildPeakWallOverlayResult,
  buildPeakWallOverlaySegments,
  buildPeakWallSegments,
  preparePeakWallSegmentsForRender,
  toAllWallPeakInputs,
  toUnreachedWallPeakInputs,
  toUnreachedStepPeakInputs,
} from './peakWallSegments';

/**
 * 최대벽 세그먼트 빌드의 **순수 계층** 테스트.
 *
 * 2026-08-23 에 `LiveAskPeakSegments`/`LiveBidPeakSegments` 두 파일에 **169줄이 바이트
 * 단위로 중복**돼 있던 것을 한 벌로 합치면서, 그 테스트도 여기로 모았다. 매도·매수 케이스가
 * **같은 파일에서 같은 함수**를 때리는 것이 요점이다 — 종전엔 두 테스트 파일이 각자 자기
 * 복사본을 검증해서, 한쪽만 달라져도 아무도 몰랐다(매수의 죽은 노브가 그 결과였다).
 */

// 항등 축: toVirtual(ms)=ms → time = ms/1000.
// contains: 이동평균 필터가 MovingAverageOverlay 와 같은 「세션 안 캔들」 배열 위에서
// SMA 를 재므로 스텁도 그 축을 갖는다 — 픽스처 캔들은 전부 세션 안이다.
const axis = { toVirtual: (ms: number) => ms, contains: () => true } as unknown as VirtualAxis;
const seg = (date: string, o: number, c: number): RangeSegment =>
  ({ date, session_open_ms: o, session_close_ms: c }) as RangeSegment;
const candle = (ts_ms: number): Candle =>
  ({ ts_ms, open: 1, high: 2, low: 0.5, close: 1.5, vol_a: 1, vol_b: 0 }) as Candle;
const peak = (over: Partial<AskPeak> & { date: string }): AskPeak => ({
  price: null, qty: null, t_ms: null, max_price: null, max_qty: null, max_t_ms: null, ...over,
});

describe('buildPeakWallSegments', () => {
  it('과거일=open→close, 오늘=open→마지막 캔들(라이브 엣지) + live 플래그', () => {
    const peaks: AskPeak[] = [
      peak({ date: '20260611', price: 297000, qty: 123456, t_ms: 1 }),
      peak({ date: '20260613', price: 323000, qty: 153125, t_ms: 2 }),
    ];
    const segments = [seg('20260611', 1000, 5000), seg('20260613', 10000, 99999)];
    const candles = [candle(10500), candle(12000)]; // 마지막 12000
    const out = buildPeakWallSegments(peaks, segments, candles, axis, '20260613', '#1D4ED8', 2, false);

    const past = out.find((s) => s.price === 297000)!;
    expect(past.time0).toBe(1); // 1000/1000
    expect(past.time1).toBe(5); // close 5000/1000 (라이브 엣지 아님)
    expect(past.live).toBe(false);

    const today = out.find((s) => s.price === 323000)!;
    expect(today.time0).toBe(10); // 10000/1000
    expect(today.time1).toBe(12); // 마지막 캔들 12000/1000 (session_close 99999 아님)
    expect(today.live).toBe(true);
    expect(today.label).toBe('323,000, 153.1k'); // 「가격, 잔량」 — 레전드와 같은 formatPriceQty
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
    const out = buildPeakWallSegments(peaks, segments, candles, axis, '20260613', '#000', 1, false);
    expect(out[0].peakTime).toBe(120); // 175000이 아니라 버킷 시작 120000/1000
  });

  it('1,000 미만 매도벽 수량도 k 단위로, 가격과 함께 표시', () => {
    const peaks: AskPeak[] = [peak({ date: '20260613', price: 100, qty: 900, t_ms: 120000 })];
    const segments = [seg('20260613', 60000, 240000)];
    const candles = [candle(60000), candle(120000), candle(180000)];
    const out = buildPeakWallSegments(peaks, segments, candles, axis, '20260613', '#000', 1, false);
    expect(out[0].label).toBe('100, 0.9k');
  });

  it('peak이 마지막 캔들 버킷보다 뒤면(라이브 엣지) 마지막 캔들에 스냅', () => {
    // 오늘 라이브: peak이 현재 형성 중 버킷(마지막 캔들 이후 시각)이면 마지막 캔들에 스냅.
    const peaks: AskPeak[] = [peak({ date: '20260613', price: 100, qty: 50, t_ms: 185000 })];
    const segments = [seg('20260613', 60000, 240000)];
    const candles = [candle(60000), candle(120000), candle(180000)];
    const out = buildPeakWallSegments(peaks, segments, candles, axis, '20260613', '#000', 1, false);
    expect(out[0].peakTime).toBe(180); // 마지막 캔들 180000/1000
  });

  it('peak이 첫 캔들보다 앞서면(미로드 구간) 원시 t_ms 폴백', () => {
    const peaks: AskPeak[] = [peak({ date: '20260613', price: 100, qty: 50, t_ms: 30000 })];
    const segments = [seg('20260613', 60000, 240000)];
    const candles = [candle(60000), candle(120000)];
    const out = buildPeakWallSegments(peaks, segments, candles, axis, '20260613', '#000', 1, false);
    expect(out[0].peakTime).toBe(30); // 스냅 대상 없음 → 원시 30000/1000 (primitive 보간 폴백이 처리)
  });

  it('segment 없는 날은 건너뜀', () => {
    const out = buildPeakWallSegments(
      [peak({ date: '20260601', price: 1, qty: 1, t_ms: 1 })], [], [], axis, '20260613', '#000', 1, false,
    );
    expect(out).toEqual([]);
  });

  it('오늘이지만 캔들 없으면 session_close로 폴백', () => {
    const out = buildPeakWallSegments(
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

    const off = buildPeakWallSegments(peaks, segments, candles, axis, '20260613', '#000', 1, false);
    expect(off[0].label).toBe('25,100, 0.3k');
    expect(off[0].peakTime).toBe(60);

    const on = buildPeakWallSegments(peaks, segments, candles, axis, '20260613', '#000', 1, true);
    expect(on[0].price).toBe(25200);
    expect(on[0].label).toBe('25,200, 0.9k');  // 가격도 max 축을 따른다
    expect(on[0].peakTime).toBe(120);
    expect(on[0].time0).toBe(off[0].time0);
    expect(on[0].time1).toBe(off[0].time1);
  });
});

/**
 * 개수는 **필터 경계에서** 재야 한다.
 *
 * 밖에서 `candidateCount − segments.length` 로 빼면 틀린다 — 필터 뒤의 세그먼트
 * 매핑에서 더 빠지는 것이 있기 때문이다(그 date 의 `RangeSegment` 가 없거나 값이
 * 비유한). 그 손실이 "필터로 숨김" 에 섞이면 사용자는 끄지도 않은 필터를 탓한다.
 *
 * 그래서 이 픽스처는 **세 층을 일부러 갈라 놓는다**: 후보 3 → 필터가 1 제거 →
 * 매핑에서 1 탈락 → 그려진 것 1. 즉 `shown + hiddenByFilter ≠ candidateCount` 가
 * 정상이고, 이 단언이 그걸 못 박는다.
 */
describe('buildPeakWallOverlayResult — 개수는 필터 경계에서 잰다', () => {
  it('매핑 탈락은 hiddenByFilter 에 섞이지 않는다', () => {
    const day = '20260613';
    const orphan = '20260610'; // segments 에 없는 날 → 매핑에서 탈락한다
    // period 1 → 각 캔들의 SMA = 그 캔들의 종가. side 'ask' 는 `price > ma` 만 남긴다.
    // 마지막 캔들 종가를 100_250 으로 올려 그 시각의 후보(100_200)만 걸리게 한다.
    const closeAt = (ts_ms: number, close: number): Candle =>
      ({ ts_ms, open: close, high: close, low: close, close, vol_a: 1, vol_b: 0 }) as Candle;
    const out = buildPeakWallOverlayResult({
      maFilter: { period: 1, side: 'ask' },
      dailyMaFilter: null,
      peaks: [
        {
          date: day,
          price: 100400, qty: 22_300, t_ms: 60_000,
          max_price: 100400, max_qty: 22_300, max_t_ms: 60_000,
          traded_peaks: [
            { price: 100400, qty: 22_800, t_ms: 120_000 },
            { price: 100200, qty: 20_000, t_ms: 240_000 },
          ],
          traded_max_peaks: [
            { price: 100400, qty: 22_800, t_ms: 120_000 },
            { price: 100200, qty: 20_000, t_ms: 240_000 },
          ],
        },
        peak({ date: orphan, price: 100_300, qty: 21_000, t_ms: 1 }),
      ],
      segments: [seg(day, 0, 360_000)],
      candles: [
        closeAt(60_000, 1), closeAt(120_000, 1), closeAt(180_000, 1),
        closeAt(240_000, 100_250),
      ],
      axis,
      todayKst: day,
      baselineStyle: { color: '#1D4ED8', lineWidth: 2 },
      intraMax: false,
      allPriceRankLimit: 3,
    });

    expect(out.candidateCount).toBe(3);
    // 필터가 자른 것은 하나(100200) — 고아 후보는 아직 살아 있다.
    expect(out.candidateCount - out.filteredCount).toBe(1);
    // 그러나 그려진 것은 하나뿐이다: 고아가 매핑에서 또 빠진다.
    expect(out.segments).toHaveLength(1);
    // **합이 총수가 아니다** — 이게 이 테스트의 요점이다.
    expect(out.segments.length + (out.candidateCount - out.filteredCount))
      .not.toBe(out.candidateCount);
  });

  it('세그먼트만 쓰는 위임은 같은 결과를 준다 — 기존 호출부 무변경', () => {
    const day = '20260613';
    const args = {
      maFilter: null,
      dailyMaFilter: null,
      peaks: [peak({ date: day, price: 100, qty: 10, t_ms: 1 })],
      segments: [seg(day, 0, 1000)],
      candles: [candle(500)],
      axis,
      todayKst: day,
      baselineStyle: { color: '#1D4ED8', lineWidth: 2 as const },
      intraMax: false,
    };
    expect(buildPeakWallOverlaySegments(args)).toEqual(buildPeakWallOverlayResult(args).segments);
  });
});

describe('buildPeakWallOverlaySegments', () => {













  it('체결가격 기준 top-N은 같은 가격 후보를 하나의 벽으로만 취급한다', () => {
    const day = '20260613';
    const out = buildPeakWallOverlaySegments({
      maFilter: null,
      dailyMaFilter: null,
      peaks: [{
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

    const out = buildPeakWallOverlaySegments({
      maFilter: null,
      dailyMaFilter: null,
      peaks: [past],
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

    const out = buildPeakWallOverlaySegments({
      maFilter: null,
      dailyMaFilter: null,
      peaks: [past, ...today],
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
    const out = buildPeakWallOverlaySegments({
      maFilter: null,
      dailyMaFilter: null,
      peaks: [{
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



});

describe('live peak-wall inline label suppression', () => {
  // 2026-08-23: 종전엔 이 자리에서 「보이는 영역 최대벽」 강조 색이 입혀졌는지도 함께
  // 봤는데, 그 강조가 제거되면서 여기서 재는 것은 **인라인 라벨 억제 하나**로 좁아졌다
  // (도킹 라벨이 라벨을 그리므로 선 위 인라인 라벨은 비워야 한다). 색·두께는 기본
  // 스타일이 그대로 통과하는지만 확인한다.
  it('suppresses ask inline labels and keeps the baseline style', () => {
    const raw = buildPeakWallOverlaySegments({
      maFilter: null,
      dailyMaFilter: null,
      peaks: [
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

    const inline = preparePeakWallSegmentsForRender(raw);
    expect(inline[0].live).toBe(false);
    expect(inline[0].label).toBe('');
    expect(inline[1].live).toBe(true);
    expect(inline[1]).toMatchObject({
      price: 110,
      label: '',
      color: '#1D4ED8',
      lineWidth: 2,
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
    const raw = buildPeakWallOverlaySegments({
      maFilter: null,
      dailyMaFilter: null,
      peaks: [pastBid, todayBid],
      segments: [seg('20260612', 60000, 240000), seg('20260613', 60000, 240000)],
      candles: [candle(60000), candle(120000), candle(180000)],
      axis,
      todayKst: '20260613',
      baselineStyle: { color: '#2563EB', lineWidth: 2 },
      intraMax: false,
    });

    const inline = preparePeakWallSegmentsForRender(raw);

    expect(inline[0].live).toBe(false);
    expect(inline[0].label).toBe('');
    expect(inline[1].live).toBe(true);
    expect(inline[1]).toMatchObject({ price: 90, label: '', color: '#2563EB', lineWidth: 2 });
  });
});

describe('buildPeakWallOverlaySegments — 매수 케이스', () => {



  it('treats same-price bid candidates as one wall for top-N ranks', () => {
    const day = '20260613';
    const open = Date.UTC(2026, 5, 13, 0, 0);
    const peak = {
      date: day,
      price: 100400,
      qty: 22_300,
      t_ms: open + 60_000,
      max_price: 100400,
      max_qty: 22_300,
      max_t_ms: open + 60_000,
      traded_peaks: [
        { price: 100400, qty: 22_300, t_ms: open + 60_000 },
        { price: 100400, qty: 22_800, t_ms: open + 120_000 },
        { price: 100300, qty: 21_000, t_ms: open + 180_000 },
        { price: 100200, qty: 20_000, t_ms: open + 240_000 },
      ],
      traded_max_peaks: [
        { price: 100400, qty: 22_300, t_ms: open + 60_000 },
        { price: 100400, qty: 22_800, t_ms: open + 120_000 },
        { price: 100300, qty: 21_000, t_ms: open + 180_000 },
        { price: 100200, qty: 20_000, t_ms: open + 240_000 },
      ],
    };

    const segments = buildPeakWallOverlaySegments({
      maFilter: null,
      dailyMaFilter: null,
      peaks: [peak],
      segments: [{ date: day, session_open_ms: open, session_close_ms: open + 3600_000 }],
      candles: [
        { ts_ms: open + 60_000, open: 2, high: 2, low: 1, close: 1, vol_a: 1, vol_b: 0 },
        { ts_ms: open + 120_000, open: 2, high: 2, low: 1, close: 1, vol_a: 1, vol_b: 0 },
        { ts_ms: open + 180_000, open: 2, high: 2, low: 1, close: 1, vol_a: 1, vol_b: 0 },
        { ts_ms: open + 240_000, open: 2, high: 2, low: 1, close: 1, vol_a: 1, vol_b: 0 },
      ],
      axis: createVirtualAxis([{ date: day, sessionOpenMs: open, sessionCloseMs: open + 3600_000 }], open),
      todayKst: day,
      baselineStyle: { color: '#fff', lineWidth: 1 },
      intraMax: false,
      allPriceRankLimit: 3,
    });

    expect(segments.map((segment) => [segment.price, segment.qty])).toEqual([
      [100400, 22_800],
      [100300, 21_000],
      [100200, 20_000],
    ]);
  });

});

describe('toAllWallPeakInputs', () => {
  it('과거일(스칼라만)은 all_* 를 carrier 로 옮기고 traded_peaks 는 undefined 로 남긴다', () => {
    const out = toAllWallPeakInputs([peak({
      date: '20260611',
      price: 100, qty: 10, t_ms: 1, max_price: 101, max_qty: 11, max_t_ms: 2,
      all_price: 200, all_qty: 900, all_t_ms: 5,
      all_max_price: 201, all_max_qty: 950, all_max_t_ms: 6,
      all_peaks: [], all_max_peaks: [],
    })]);

    expect(out).toEqual([{
      date: '20260611',
      price: 200, qty: 900, t_ms: 5,
      max_price: 201, max_qty: 950, max_t_ms: 6,
      traded_peaks: undefined,
      traded_max_peaks: undefined,
    }]);
  });

  it('오늘(배열)은 rank-1 이 carrier, 배열은 traded 슬롯으로 옮긴다', () => {
    const allPeaks = [
      { price: 300, qty: 5000, t_ms: 10 },
      { price: 310, qty: 4000, t_ms: 11 },
    ];
    const out = toAllWallPeakInputs([peak({
      date: '20260613',
      price: null, qty: null, t_ms: null,
      all_peaks: allPeaks,
      all_max_peaks: allPeaks,
    })]);

    expect(out[0]).toMatchObject({
      date: '20260613',
      price: 300, qty: 5000, t_ms: 10,
      max_price: 300, max_qty: 5000, max_t_ms: 10,
    });
    expect(out[0].traded_peaks).toBe(allPeaks);
    expect(out[0].traded_max_peaks).toBe(allPeaks);
  });

  it('all_* 가 전혀 없는 날(legacy payload)은 건너뛴다', () => {
    const out = toAllWallPeakInputs([
      peak({ date: '20260610', price: 100, qty: 10, t_ms: 1 }),
      peak({ date: '20260611', all_price: 200, all_qty: 900, all_t_ms: 5 }),
    ]);
    expect(out.map((p) => p.date)).toEqual(['20260611']);
  });

});

describe('toUnreachedWallPeakInputs', () => {
  it('배열이 있으면 rank-1 이 양 carrier(close=max — cont 단일 계열), 배열은 traded 슬롯으로', () => {
    const arr = [
      { price: 300, qty: 5000, t_ms: 10 },
      { price: 310, qty: 4000, t_ms: 11 },
    ];
    const out = toUnreachedWallPeakInputs([peak({ date: '20260613', unreached_peaks: arr })]);
    expect(out[0]).toMatchObject({
      price: 300, qty: 5000, t_ms: 10,
      max_price: 300, max_qty: 5000, max_t_ms: 10,
    });
    expect(out[0].traded_peaks).toBe(arr);
    expect(out[0].traded_max_peaks).toBe(arr);
  });

  it('배열이 없으면 스칼라 폴백 — traded_peaks 는 undefined(컷오프 스칼라 폴백 계약)', () => {
    const out = toUnreachedWallPeakInputs([peak({
      date: '20260611',
      unreached_price: 200, unreached_qty: 900, unreached_t_ms: 5,
      unreached_peaks: [],
    })]);
    expect(out).toEqual([{
      date: '20260611',
      price: 200, qty: 900, t_ms: 5,
      max_price: 200, max_qty: 900, max_t_ms: 5,
      traded_peaks: undefined,
      traded_max_peaks: undefined,
    }]);
  });

  it('unreached 가 전혀 없는 날(구 캐시·legacy)은 건너뛴다', () => {
    const out = toUnreachedWallPeakInputs([
      peak({ date: '20260610', price: 100, qty: 10, t_ms: 1 }),
      peak({ date: '20260611', unreached_price: 200, unreached_qty: 900, unreached_t_ms: 5 }),
    ]);
    expect(out.map((p) => p.date)).toEqual(['20260611']);
  });
});

/**
 * 강도 pane 계단 전용 후보 풀 — **화면의 미도달 선과 갈라진다**는 것이 이 describe 의 축.
 *
 * 막는 방향 둘:
 * ① 계단 후보를 `unreached_peaks` top-3 으로 되돌리는 것. 그러면 「미도달 벽 없음」(0)
 *    이 top-3 절단 탓인지 진짜인지 구별되지 않아, 빌더의 0-fill 이 종전 docstring 이
 *    기각한 「거짓 0」이 된다.
 * ② 이 확장이 **화면의 벽 개수**로 새는 것. 캔들 표면의 미도달 선은 그대로 top-3 이고,
 *    그 입력은 `toUnreachedWallPeakInputs` 다(위 describe).
 *
 * 못 보는 것: wire 가 안 나르는 top-3 밖 벽. 빌더 쪽 축은 `chart/peakWallSteps.test.ts`.
 */
describe('toUnreachedStepPeakInputs', () => {
  it('그날 알려진 벽을 전부 record 슬롯에 모은다 — 화면 top-3 보다 넓다', () => {
    const out = toUnreachedStepPeakInputs([peak({
      date: '20260613',
      unreached_peaks: [{ price: 300, qty: 5_000, t_ms: 10 }],
      traded_peaks: [{ price: 250, qty: 7_000, t_ms: 20 }],
      traded_record_peaks: [{ price: 240, qty: 1_000, t_ms: 5 }],
      all_peaks: [{ price: 260, qty: 2_000, t_ms: 30 }],
    })]);
    // record 슬롯 = 네 계열의 합집합. 화면 선(traded_peaks 슬롯)은 미도달 top-3 그대로.
    expect(out[0].traded_record_peaks).toEqual([
      { price: 300, qty: 5_000, t_ms: 10 },
      { price: 250, qty: 7_000, t_ms: 20 },
      { price: 240, qty: 1_000, t_ms: 5 },
      { price: 260, qty: 2_000, t_ms: 30 },
    ]);
    expect(out[0].traded_peaks).toEqual([{ price: 300, qty: 5_000, t_ms: 10 }]);
    // cont 단일 계열 규약 — 양 축에 같은 풀(intraMax 토글 무효).
    expect(out[0].traded_record_max_peaks).toEqual(out[0].traded_record_peaks);
  });

  it('같은 벽이 여러 필드로 와도 (가격,잔량,시각) 키로 한 번만 담는다', () => {
    const wall = { price: 300, qty: 5_000, t_ms: 10 };
    const out = toUnreachedStepPeakInputs([peak({
      date: '20260613',
      unreached_peaks: [wall],
      traded_peaks: [wall],
      traded_record_peaks: [wall],
      all_max_peaks: [wall],
    })]);
    expect(out[0].traded_record_peaks).toEqual([wall]);
  });

  it('미도달 벽이 하나도 없는 날도 행을 낸다 — 그날 0 을 그릴 근거가 되는 벽이 있으므로', () => {
    const out = toUnreachedStepPeakInputs([peak({
      date: '20260824',
      traded_record_peaks: [{ price: 240, qty: 1_000, t_ms: 5 }],
    })]);
    expect(out).toHaveLength(1);
    // carrier 는 풀의 첫 후보로 채워진다(계단 계산이 읽지 않는 형식 자리).
    expect(out[0]).toMatchObject({ date: '20260824', price: 240, qty: 1_000, t_ms: 5 });
    expect(out[0].traded_peaks).toBeUndefined();
  });

  it('벽 후보가 전혀 없는 날은 건너뛴다 — 빌더가 0 을 주장하지 않게', () => {
    const out = toUnreachedStepPeakInputs([
      peak({ date: '20260610' }),
      peak({ date: '20260611', unreached_price: 200, unreached_qty: 900, unreached_t_ms: 5 }),
    ]);
    expect(out.map((row) => row.date)).toEqual(['20260611']);
  });

  it('스칼라만 오는 과거일도 풀에 들어간다(배열이 벗겨진 payload)', () => {
    const out = toUnreachedStepPeakInputs([peak({
      date: '20260611',
      price: 100, qty: 10, t_ms: 1,
      all_price: 120, all_qty: 30, all_t_ms: 3,
      unreached_price: 200, unreached_qty: 900, unreached_t_ms: 5,
    })]);
    expect(out[0].traded_record_peaks).toEqual([
      { price: 200, qty: 900, t_ms: 5 },
      { price: 100, qty: 10, t_ms: 1 },
      { price: 120, qty: 30, t_ms: 3 },
    ]);
  });
});
