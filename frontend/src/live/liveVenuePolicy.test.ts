import { describe, expect, it, vi } from 'vitest';
import {
  initialVisibleMinuteBarsFor,
  isLiveVenueSessionNow,
  liveHogaVenueNow,
  liveSubscriptionVenueForMs,
  liveVenueAcceptsFrame,
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

  it('mirrors the backend 08:50–15:31 subscription venue boundary (not the 09:00 badge boundary)', () => {
    const MIN = 60 * 1000;
    // 장전 08:40 = NXT
    expect(liveSubscriptionVenueForMs(MON_OPEN_MS - 20 * MIN)).toBe('NXT');
    // 08:50 KRX 워밍업 경계(포함) — 09:00 배지 경계와 달리 여기서부터 KRX여야
    // 08:50~09:00 개장동시호가 프레임이 NXT로 오분류되지 않는다.
    expect(liveSubscriptionVenueForMs(MON_OPEN_MS - 10 * MIN)).toBe('KRX');
    expect(liveSubscriptionVenueForMs(MON_OPEN_MS - 5 * MIN)).toBe('KRX'); // 08:55 개장동시호가
    expect(liveSubscriptionVenueForMs(MON_OPEN_MS + HOUR)).toBe('KRX');    // 10:00 정규장
    expect(liveSubscriptionVenueForMs(MON_OPEN_MS + 6.5 * HOUR + MIN)).toBe('NXT'); // 15:31 drain 경계(제외)
    expect(liveSubscriptionVenueForMs(MON_OPEN_MS + 7 * HOUR)).toBe('NXT'); // 16:00 장후 NXT
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
    expect(liveVenueAcceptsFrame('KRX', 'KRX', MON_OPEN_MS + HOUR)).toBe(true);
    expect(liveVenueAcceptsFrame('KRX', undefined, MON_OPEN_MS + HOUR)).toBe(true); // 태그부재=KRX
    expect(liveVenueAcceptsFrame('KRX', 'NXT', MON_OPEN_MS + HOUR)).toBe(false);
  });

  it('UN venue accepts a tag only when it matches the frame-time subscription venue (엄격 통일 규칙)', () => {
    // 정상 데이터: 정규장엔 KRX, NXT 시간대엔 NXT 태그가 도착 — 각자 자기 시장에 속함
    expect(liveVenueAcceptsFrame('UN', 'KRX', MON_OPEN_MS + HOUR)).toBe(true);   // 10:00 KRX
    expect(liveVenueAcceptsFrame('UN', 'NXT', MON_OPEN_MS + 7 * HOUR)).toBe(true); // 16:00 NXT
    // 교차 클라이언트가 주입한 off-venue 프레임은 배제 — 이전 느슨 규칙(둘 다 수용)과 갈리는 지점
    expect(liveVenueAcceptsFrame('UN', 'NXT', MON_OPEN_MS + HOUR)).toBe(false);   // 10:00 NXT 태그 ✗
    expect(liveVenueAcceptsFrame('UN', 'KRX', MON_OPEN_MS + 7 * HOUR)).toBe(false); // 16:00 KRX 태그 ✗
  });

  it('UN venue with untagged trades falls back to the 08:50–15:31 subscription window (구백엔드)', () => {
    // 무태그는 KRX로 승격 → 구독창(08:50~15:31) 안에서만 수용. 09:00 시간게이트보다
    // 넓어져 개장동시호가(08:55)·마감 drain(15:30)을 포함한다(통일로 인한 의도된 확장).
    expect(liveVenueAcceptsFrame('UN', undefined, MON_OPEN_MS)).toBe(true);                    // 09:00
    expect(liveVenueAcceptsFrame('UN', undefined, MON_OPEN_MS - 5 * 60 * 1000)).toBe(true);    // 08:55 개장동시호가(구독창 포함)
    expect(liveVenueAcceptsFrame('UN', undefined, MON_OPEN_MS + 6.5 * HOUR)).toBe(true);       // 15:30
    expect(liveVenueAcceptsFrame('UN', undefined, MON_OPEN_MS - 30 * 60 * 1000)).toBe(false);  // 08:30 (08:50 이전) ✗
    expect(liveVenueAcceptsFrame('UN', undefined, MON_OPEN_MS + 6.5 * HOUR + 2 * 60 * 1000)).toBe(false); // 15:32 (15:31 이후) ✗
  });

  it('liveHogaVenueNow reflects the time-multiplexed hoga market for UN venue', () => {
    expect(liveHogaVenueNow('KRX', MON_OPEN_MS + HOUR)).toBe('KRX');       // KRX venue = 항상 KRX
    expect(liveHogaVenueNow('UN', MON_OPEN_MS + HOUR)).toBe('KRX');        // 10:00 정규장
    expect(liveHogaVenueNow('UN', MON_OPEN_MS - 30 * 60 * 1000)).toBe('NXT'); // 08:30 장전
    expect(liveHogaVenueNow('UN', MON_OPEN_MS + 7 * HOUR)).toBe('NXT');    // 16:00 장후
  });
});
