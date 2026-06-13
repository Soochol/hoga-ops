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
    expect(today.label).toContain('만'); // formatQtyKo(153125) → "15.3만"
    expect(today.color).toBe('#1D4ED8');
    expect(today.lineWidth).toBe(2);
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
