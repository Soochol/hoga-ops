import { describe, it, expect } from 'vitest';
import { prevCloseBeforeDate, type ScreenerDailyCandle } from './screenerDailyCandles';
import { realMsToYyyymmdd } from '../live/liveDateTime';

// YYYYMMDD → 그 날짜 KST 09:00 근처의 real ms (realMsToYyyymmdd 역산에 안전한 정오 사용).
function dayMs(yyyymmdd: string): number {
  const y = +yyyymmdd.slice(0, 4), m = +yyyymmdd.slice(4, 6), d = +yyyymmdd.slice(6, 8);
  // KST(UTC+9) 정오 = UTC 03:00 → 어느 타임존 변환에도 같은 날짜로 남는다.
  return Date.UTC(y, m - 1, d, 3, 0, 0);
}
const candle = (yyyymmdd: string, close: number): ScreenerDailyCandle => ({
  t_ms: dayMs(yyyymmdd), open: close, high: close, low: close, close, volume: 0,
});

describe('prevCloseBeforeDate', () => {
  it('date 직전 거래일의 close 반환 (연속일)', () => {
    const candles = [candle('20260706', 100), candle('20260707', 110), candle('20260708', 120)];
    // 20260708 기준 전일 종가 = 20260707 close = 110
    expect(prevCloseBeforeDate(candles, '20260708')).toBe(110);
  });

  it('주말/공휴일 갭이 있어도 date 미만 최댓날짜의 close (정렬 순서 무관)', () => {
    // 금(0703)·월(0706)만 존재, 화(0707) 기준 전일 = 월(0706). 입력 순서 섞어도 동일.
    const candles = [candle('20260706', 200), candle('20260703', 150)];
    expect(prevCloseBeforeDate(candles, '20260707')).toBe(200);
  });

  it('date 자신 캔들은 제외 (strictly <)', () => {
    const candles = [candle('20260707', 110), candle('20260708', 120)];
    expect(prevCloseBeforeDate(candles, '20260708')).toBe(110);
    // 대상일이 최초일이면 이전 거래일 없음 → null
    expect(prevCloseBeforeDate(candles, '20260707')).toBeNull();
  });

  it('빈 배열/이전 거래일 없음 → null', () => {
    expect(prevCloseBeforeDate([], '20260708')).toBeNull();
    expect(prevCloseBeforeDate([candle('20260710', 300)], '20260708')).toBeNull();
  });

  // realMsToYyyymmdd 로 t_ms→날짜 변환이 dayMs 헬퍼와 왕복 일치하는지(테스트 전제 검증)
  it('sanity: dayMs ↔ realMsToYyyymmdd 왕복', () => {
    expect(realMsToYyyymmdd(dayMs('20260708'))).toBe('20260708');
  });
});
