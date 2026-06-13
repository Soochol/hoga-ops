import { describe, it, expect } from 'vitest';
import { buildAskPeakSegments } from './LiveAskPeakSegments';
import type { AskPeak, RangeSegment, Candle } from '../api/types';
import type { VirtualAxis } from '../util/virtualAxis';

// 항등 축: toVirtual(ms)=ms → time = ms/1000.
const axis = { toVirtual: (ms: number) => ms } as unknown as VirtualAxis;
const seg = (date: string, o: number, c: number): RangeSegment =>
  ({ date, session_open_ms: o, session_close_ms: c }) as RangeSegment;
const candle = (ts_ms: number): Candle =>
  ({ ts_ms, open: 0, close: 0, high: 0, low: 0, vol_a: 0, vol_b: 0 });

describe('buildAskPeakSegments', () => {
  it('과거일=open→close, 오늘=open→마지막 캔들(라이브 엣지) + live 플래그', () => {
    const peaks: AskPeak[] = [
      { date: '20260611', price: 297000, qty: 123456, t_ms: 1 },
      { date: '20260613', price: 323000, qty: 153125, t_ms: 2 },
    ];
    const segments = [seg('20260611', 1000, 5000), seg('20260613', 10000, 99999)];
    const candles = [candle(10500), candle(12000)]; // 마지막 12000
    const out = buildAskPeakSegments(peaks, segments, candles, axis, '20260613', '#1D4ED8', 2);

    const past = out.find((s) => s.price === 297000)!;
    expect(past.time0).toBe(1); // 1000/1000
    expect(past.time1).toBe(5); // close 5000/1000 (라이브 엣지 아님)
    expect(past.live).toBe(false);

    const today = out.find((s) => s.price === 323000)!;
    expect(today.time0).toBe(10); // 10000/1000
    expect(today.time1).toBe(12); // 마지막 캔들 12000/1000 (session_close 99999 아님)
    expect(today.live).toBe(true);
    expect(today.label).toBe('153.1k'); // formatQtyCompact(153125)
    expect(today.peakTime).toBe(2 / 1000); // axis.toVirtual(t_ms=2)/1000 — peak 발생 시점
    expect(today.color).toBe('#1D4ED8');
    expect(today.lineWidth).toBe(2);
  });

  it('peak 점은 그 시각이 속한 캔들(버킷 시작)에 스냅 — 1캔들 밀림 방지', () => {
    // 캔들 = 버킷 시작(60s 간격): 60000, 120000, 180000. peak t_ms=175000은 [120000,180000) 버킷.
    // 스냅 없으면 toVirtual(175000)=175 → lwc가 다음 캔들(180) 쪽으로 보간 → 1캔들 밀림.
    // 스냅하면 120000(그 버킷 캔들)로 → peakTime=120.
    const peaks: AskPeak[] = [{ date: '20260613', price: 100, qty: 50, t_ms: 175000 }];
    const segments = [seg('20260613', 60000, 240000)];
    const candles = [candle(60000), candle(120000), candle(180000)];
    const out = buildAskPeakSegments(peaks, segments, candles, axis, '20260613', '#000', 1);
    expect(out[0].peakTime).toBe(120); // 175000이 아니라 버킷 시작 120000/1000
  });

  it('peak이 마지막 캔들 버킷보다 뒤면(라이브 엣지) 마지막 캔들에 스냅', () => {
    // 오늘 라이브: peak이 현재 형성 중 버킷(마지막 캔들 이후 시각)이면 마지막 캔들에 스냅.
    const peaks: AskPeak[] = [{ date: '20260613', price: 100, qty: 50, t_ms: 185000 }];
    const segments = [seg('20260613', 60000, 240000)];
    const candles = [candle(60000), candle(120000), candle(180000)];
    const out = buildAskPeakSegments(peaks, segments, candles, axis, '20260613', '#000', 1);
    expect(out[0].peakTime).toBe(180); // 마지막 캔들 180000/1000
  });

  it('peak이 첫 캔들보다 앞서면(미로드 구간) 원시 t_ms 폴백', () => {
    const peaks: AskPeak[] = [{ date: '20260613', price: 100, qty: 50, t_ms: 30000 }];
    const segments = [seg('20260613', 60000, 240000)];
    const candles = [candle(60000), candle(120000)];
    const out = buildAskPeakSegments(peaks, segments, candles, axis, '20260613', '#000', 1);
    expect(out[0].peakTime).toBe(30); // 스냅 대상 없음 → 원시 30000/1000 (primitive 보간 폴백이 처리)
  });

  it('segment 없는 날은 건너뜀', () => {
    const out = buildAskPeakSegments(
      [{ date: '20260601', price: 1, qty: 1, t_ms: 1 }], [], [], axis, '20260613', '#000', 1,
    );
    expect(out).toEqual([]);
  });

  it('오늘이지만 캔들 없으면 session_close로 폴백', () => {
    const out = buildAskPeakSegments(
      [{ date: '20260613', price: 100, qty: 50, t_ms: 1 }],
      [seg('20260613', 2000, 8000)], [], axis, '20260613', '#000', 1,
    );
    expect(out[0].time1).toBe(8); // 캔들 없음 → close 8000/1000
  });
});
