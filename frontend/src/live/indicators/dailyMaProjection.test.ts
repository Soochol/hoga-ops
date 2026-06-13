import { describe, it, expect } from 'vitest';
import {
  DAILY_MA_TRADING_TO_CALENDAR,
  dailyMaLookbackDays,
  maxEnabledPeriod,
  dailyMaFetchWindow,
  pickTodayLiveClose,
} from './dailyMaProjection';
import { PAST_CANDLES_MAX_DAYS, subtractDaysKst } from '../liveDateTime';
import type { LiveMAConfig } from '../../state/livePage';
import type { Candle } from '../../api/types';

const slot = (over: Partial<LiveMAConfig>): LiveMAConfig => ({
  id: 'x', enabled: true, period: 20, color: '#ffffff', lineWidth: 1, source: 'close', ...over,
});

describe('dailyMaLookbackDays', () => {
  it('uses the conservative 1.5 factor (named constant, not liveDateTime 1.4)', () => {
    expect(DAILY_MA_TRADING_TO_CALENDAR).toBe(1.5);
    expect(dailyMaLookbackDays(20)).toBe(PAST_CANDLES_MAX_DAYS + Math.ceil(20 * 1.5) + 15);
  });

  it('covers the realistic KRX calendar span even at MA_PERIOD_MAX=400 (regression: period>190 under-coverage)', () => {
    // Realistic KRX density ≈ 1.48 calendar days per trading day. The lookback
    // window must cover at least that many calendar days beyond the minute pan
    // clamp, or the leftmost daily-MA points go null. A 1.4 factor failed here.
    const realisticCalendarFor400 = Math.ceil(400 * 1.48);
    expect(dailyMaLookbackDays(400)).toBeGreaterThanOrEqual(PAST_CANDLES_MAX_DAYS + realisticCalendarFor400);
  });
});

describe('maxEnabledPeriod', () => {
  it('returns the max enabled period, ignoring disabled slots', () => {
    expect(maxEnabledPeriod([
      slot({ period: 20 }),
      slot({ period: 120, enabled: false }),
      slot({ period: 60 }),
    ])).toBe(60);
  });

  it('defaults to 20 for empty / all-disabled', () => {
    expect(maxEnabledPeriod([])).toBe(20);
    expect(maxEnabledPeriod([slot({ period: 200, enabled: false })])).toBe(20);
  });
});

describe('dailyMaFetchWindow', () => {
  it('to = todayKst, from = today − lookback(maxEnabledPeriod)', () => {
    const todayKst = '20260612';
    const w = dailyMaFetchWindow(todayKst, [slot({ period: 20 }), slot({ period: 60 })]);
    expect(w.to).toBe(todayKst);
    expect(w.from).toBe(subtractDaysKst(todayKst, dailyMaLookbackDays(60)));
  });
});

describe('pickTodayLiveClose', () => {
  const D_0612 = 1781222400000; // 2026-06-12 09:00 KST
  const candle = (over: Partial<Candle>): Candle => ({
    ts_ms: D_0612, open: 1, close: 1, high: 1, low: 1, vol_a: 0, vol_b: 0, ...over,
  });

  it('returns last candle close when its trading-day === todayKst', () => {
    expect(pickTodayLiveClose([candle({ close: 1 }), candle({ ts_ms: D_0612 + 60_000, close: 200 })], '20260612')).toBe(200);
  });

  it('returns null when last candle is not today (weekend / pre-open)', () => {
    expect(pickTodayLiveClose([candle({ close: 200 })], '20260613')).toBeNull();
  });

  it('returns null for empty candles', () => {
    expect(pickTodayLiveClose([], '20260612')).toBeNull();
  });
});
