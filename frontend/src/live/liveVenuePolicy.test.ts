import { describe, expect, it, vi } from 'vitest';
import {
  initialVisibleMinuteBarsFor,
  isLiveVenueSessionNow,
  liveVenueAllowsKrxTradeOverlay,
  liveVenueDisplayLabel,
  liveVenueKeepsHogaKrx,
  liveVenueRefetchInterval,
  liveVenueSessionBoundsMs,
} from './liveVenuePolicy';

const MON_OPEN_MS = Date.UTC(2026, 4, 18, 0, 0, 0);
const HOUR = 3600 * 1000;

describe('liveVenuePolicy', () => {
  it('keeps KRX on the regular session display window', () => {
    expect(liveVenueSessionBoundsMs('20260518', 'KRX')).toEqual({
      open_ms: MON_OPEN_MS,
      close_ms: MON_OPEN_MS + 6.5 * HOUR,
    });
    expect(initialVisibleMinuteBarsFor('1m', 'KRX')).toBe(300);
  });

  it('uses the extended minute window for NXT and integrated', () => {
    for (const venue of ['NXT', 'UN'] as const) {
      expect(liveVenueSessionBoundsMs('20260518', venue)).toEqual({
        open_ms: MON_OPEN_MS - HOUR,
        close_ms: MON_OPEN_MS + 11 * HOUR,
      });
      expect(initialVisibleMinuteBarsFor('1m', venue)).toBe(300);
      expect(liveVenueKeepsHogaKrx(venue)).toBe(true);
    }
  });

  it('owns the user-facing venue labels used by chart chrome', () => {
    expect(liveVenueDisplayLabel('KRX')).toBe('KRX');
    expect(liveVenueDisplayLabel('NXT')).toBe('NXT');
    expect(liveVenueDisplayLabel('UN')).toBe('통합');
  });

  it('uses venue-specific session windows for live refetch freshness', () => {
    expect(isLiveVenueSessionNow('KRX', MON_OPEN_MS - HOUR)).toBe(false);
    expect(isLiveVenueSessionNow('NXT', MON_OPEN_MS - HOUR)).toBe(true);
    expect(isLiveVenueSessionNow('UN', MON_OPEN_MS + 9 * HOUR)).toBe(true);
    expect(isLiveVenueSessionNow('NXT', MON_OPEN_MS + 12 * HOUR)).toBe(false);
  });

  it('returns a refetch interval during the selected venue session', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(MON_OPEN_MS - HOUR);
    expect(liveVenueRefetchInterval('KRX')).toBe(false);
    expect(liveVenueRefetchInterval('NXT')).toBe(60_000);
    now.mockRestore();
  });

  it('allows KRX live trade overlay only where the selected candle venue owns it', () => {
    expect(liveVenueAllowsKrxTradeOverlay('KRX', MON_OPEN_MS + HOUR)).toBe(true);
    expect(liveVenueAllowsKrxTradeOverlay('NXT', MON_OPEN_MS + HOUR)).toBe(false);
  });

  it('UN hybrid (ADR-0096): KRX trades overlay only during the KRX regular session', () => {
    // 정규장 내부·경계(개장 09:00, 마감 15:30 포함) → 허용
    expect(liveVenueAllowsKrxTradeOverlay('UN', MON_OPEN_MS)).toBe(true);
    expect(liveVenueAllowsKrxTradeOverlay('UN', MON_OPEN_MS + HOUR)).toBe(true);
    expect(liveVenueAllowsKrxTradeOverlay('UN', MON_OPEN_MS + 6.5 * HOUR)).toBe(true);
    // NXT 전용 시간대(장전 08시대, 장후 15:30 초과) → 차단 (통합 REST가 정본)
    expect(liveVenueAllowsKrxTradeOverlay('UN', MON_OPEN_MS - 30 * 60 * 1000)).toBe(false);
    expect(liveVenueAllowsKrxTradeOverlay('UN', MON_OPEN_MS + 6.5 * HOUR + 1)).toBe(false);
    expect(liveVenueAllowsKrxTradeOverlay('UN', MON_OPEN_MS + 10 * HOUR)).toBe(false);
  });
});
