import { describe, expect, it, vi } from 'vitest';
import {
  initialVisibleMinuteBarsFor,
  isLiveVenueSessionNow,
  liveHogaVenueNow,
  liveVenueAllowsTradeOverlay,
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

  it('uses the extended minute window for the integrated venue', () => {
    expect(liveVenueSessionBoundsMs('20260518', 'UN')).toEqual({
      open_ms: MON_OPEN_MS - HOUR,
      close_ms: MON_OPEN_MS + 11 * HOUR,
    });
    expect(initialVisibleMinuteBarsFor('1m', 'UN')).toBe(300);
    expect(liveVenueKeepsHogaKrx('UN')).toBe(true);
    expect(liveVenueKeepsHogaKrx('KRX')).toBe(false);
  });

  it('owns the user-facing venue labels used by chart chrome', () => {
    expect(liveVenueDisplayLabel('KRX')).toBe('KRX');
    expect(liveVenueDisplayLabel('UN')).toBe('시간대 자동');
  });

  it('uses venue-specific session windows for live refetch freshness', () => {
    expect(isLiveVenueSessionNow('KRX', MON_OPEN_MS - HOUR)).toBe(false);
    expect(isLiveVenueSessionNow('UN', MON_OPEN_MS - HOUR)).toBe(true);   // 장전 NXT 시간대
    expect(isLiveVenueSessionNow('UN', MON_OPEN_MS + 9 * HOUR)).toBe(true);
    expect(isLiveVenueSessionNow('UN', MON_OPEN_MS + 12 * HOUR)).toBe(false);
  });

  it('returns a refetch interval during the selected venue session', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(MON_OPEN_MS - HOUR);
    expect(liveVenueRefetchInterval('KRX')).toBe(false);
    expect(liveVenueRefetchInterval('UN')).toBe(60_000);   // 장전 NXT 시간대 = UN 세션
    now.mockRestore();
  });

  it('KRX venue accepts only KRX-tagged trades (NXT tag never overlays KRX candles)', () => {
    expect(liveVenueAllowsTradeOverlay('KRX', 'KRX', MON_OPEN_MS + HOUR)).toBe(true);
    expect(liveVenueAllowsTradeOverlay('KRX', undefined, MON_OPEN_MS + HOUR)).toBe(true); // 태그부재=KRX
    expect(liveVenueAllowsTradeOverlay('KRX', 'NXT', MON_OPEN_MS + HOUR)).toBe(false);
  });

  it('UN venue accepts both KRX and NXT tags (backend time-multiplexes)', () => {
    // 정규장엔 KRX 태그, NXT 시간대엔 NXT 태그가 도착 — 둘 다 통합에 속함
    expect(liveVenueAllowsTradeOverlay('UN', 'KRX', MON_OPEN_MS + HOUR)).toBe(true);
    expect(liveVenueAllowsTradeOverlay('UN', 'NXT', MON_OPEN_MS + 7 * HOUR)).toBe(true); // 16:00 NXT
  });

  it('UN venue with untagged trades falls back to the ADR-0096 time gate (구백엔드)', () => {
    // 태그 없으면 정규장 KRX만(개장·마감 경계 포함), 그 밖은 차단
    expect(liveVenueAllowsTradeOverlay('UN', undefined, MON_OPEN_MS)).toBe(true);
    expect(liveVenueAllowsTradeOverlay('UN', undefined, MON_OPEN_MS + 6.5 * HOUR)).toBe(true);
    expect(liveVenueAllowsTradeOverlay('UN', undefined, MON_OPEN_MS - 30 * 60 * 1000)).toBe(false);
    expect(liveVenueAllowsTradeOverlay('UN', undefined, MON_OPEN_MS + 6.5 * HOUR + 1)).toBe(false);
  });

  it('liveHogaVenueNow reflects the time-multiplexed hoga market for UN venue', () => {
    expect(liveHogaVenueNow('KRX', MON_OPEN_MS + HOUR)).toBe('KRX');       // KRX venue = 항상 KRX
    expect(liveHogaVenueNow('UN', MON_OPEN_MS + HOUR)).toBe('KRX');        // 10:00 정규장
    expect(liveHogaVenueNow('UN', MON_OPEN_MS - 30 * 60 * 1000)).toBe('NXT'); // 08:30 장전
    expect(liveHogaVenueNow('UN', MON_OPEN_MS + 7 * HOUR)).toBe('NXT');    // 16:00 장후
  });
});
