import { describe, expect, it, vi } from 'vitest';
import {
  effectiveLiveVenue,
  initialVisibleMinuteBarsFor,
  isLiveVenueSessionNow,
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

  it('owns the user-facing venue labels used by chart chrome', () => {
    expect(liveVenueDisplayLabel('KRX')).toBe('KRX');
    expect(liveVenueDisplayLabel('NXT')).toBe('NXT');
    expect(liveVenueDisplayLabel('UN')).toBe('통합');
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

  it('accepts a frame only when its tag equals the selected venue (태그 직결)', () => {
    // ADR-0140 §5: 시분할이 사라져 **같은 시각에 세 시장 프레임이 정상적으로** 온다.
    // 시각 판정을 남겼다면 정상 데이터의 2/3 을 오염으로 오인해 버렸다.
    for (const at of [MON_OPEN_MS + HOUR, MON_OPEN_MS + 7 * HOUR]) {
      void at; // 시각은 더 이상 판정에 안 쓰인다 — 두 시각 모두 같은 결과여야 한다
      expect(liveVenueAcceptsFrame('KRX', 'KRX')).toBe(true);
      expect(liveVenueAcceptsFrame('KRX', 'NXT')).toBe(false);
      expect(liveVenueAcceptsFrame('KRX', 'UN')).toBe(false);
      expect(liveVenueAcceptsFrame('NXT', 'NXT')).toBe(true);
      expect(liveVenueAcceptsFrame('NXT', 'KRX')).toBe(false);
      expect(liveVenueAcceptsFrame('UN', 'UN')).toBe(true);
    }
  });

  it('does NOT treat UN as the union of KRX and NXT', () => {
    // `_AL` 은 거래소가 병합해 내보내는 **별도 스트림**이라 자기 태그를 달고 온다.
    // 합집합으로 받으면 같은 체결이 세 벌로 세어져 거래량이 부풀고, 호가는 두 시장
    // 잔량이 `_AL` 과 겹쳐 이중 계상된다.
    expect(liveVenueAcceptsFrame('UN', 'KRX')).toBe(false);
    expect(liveVenueAcceptsFrame('UN', 'NXT')).toBe(false);
  });

  it('promotes an untagged frame to KRX (구백엔드 하위호환)', () => {
    expect(liveVenueAcceptsFrame('KRX', undefined)).toBe(true);
    expect(liveVenueAcceptsFrame('NXT', undefined)).toBe(false);
    expect(liveVenueAcceptsFrame('UN', undefined)).toBe(false);
  });

  describe('effectiveLiveVenue', () => {
    it('NXT 미상장 종목의 통합(UN)만 KRX 로 되돌린다', () => {
      // 합칠 상대 시장이 없으므로 통합 = KRX 다. 백엔드가 그 종목에 `_AL` 을
      // 구독하지 않아 UN 태그 프레임이 0건이고, 게이트가 KRX 프레임을 전부 버려
      // 10호가·체결·틱 등락률이 통째로 비던 것을 여기서 끊는다.
      expect(effectiveLiveVenue('UN', false)).toBe('KRX');
    });

    it('모름(null·undefined)은 강등하지 않는다', () => {
      // 백엔드가 모름을 fail-open 으로 세 venue 전부 구독하므로(coverage.py) UN
      // 프레임이 실제로 존재한다. 프론트만 강등하면 있는 데이터를 버린다.
      // 심볼 마스터 도착 전 창이 이 경우라, 여기서 강등하면 첫 렌더가 회귀한다.
      expect(effectiveLiveVenue('UN', null)).toBe('UN');
      expect(effectiveLiveVenue('UN', undefined)).toBe('UN');
    });

    it('NXT 상장 종목의 통합은 그대로 통합이다', () => {
      expect(effectiveLiveVenue('UN', true)).toBe('UN');
    });

    it('UN 이 아닌 선택은 nxt_enabled 와 무관하게 항등이다', () => {
      // NXT 선택 + 미상장의 빈 화면은 명시적 선택의 정직한 결과다(#1132) —
      // 해석의 여지가 있는 건 "합친 결과를 달라"는 UN 뿐이다.
      for (const nxt of [true, false, null, undefined] as const) {
        expect(effectiveLiveVenue('KRX', nxt)).toBe('KRX');
        expect(effectiveLiveVenue('NXT', nxt)).toBe('NXT');
      }
    });
  });

});
