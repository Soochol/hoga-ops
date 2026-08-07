import { describe, it, expect, beforeEach } from 'vitest';
import {
  LIVE_VENUE_LABELS,
  LIVE_VENUE_OPTIONS,
  subscribeToLiveVenueStorage,
  useLiveVenueStore,
  type LiveVenueOption,
} from './liveVenue';

describe('useLiveVenueStore', () => {
  beforeEach(() => {
    localStorage.clear();
    useLiveVenueStore.setState({ venue: 'KRX' });
  });

  it('defaults to KRX', () => {
    expect(useLiveVenueStore.getState().venue).toBe('KRX');
  });

  it('setVenue updates and persists to localStorage', () => {
    useLiveVenueStore.getState().setVenue('UN');
    expect(useLiveVenueStore.getState().venue).toBe('UN');
    expect(localStorage.getItem('live.venue.v1')).toContain('UN');
  });

  it('keeps a persisted NXT venue as NXT (ADR-0140 §5 — 이행 규칙 제거)', () => {
    // ⚠ 회귀 가드. #523 이 NXT 를 옵션에서 빼면서 넣은 `'NXT' → 'UN'` 이행 규칙이
    // 남아 있으면, 사용자가 NXT 를 골라도 다음 로드에 조용히 UN 으로 되돌아간다.
    // 되돌아간 화면은 데이터가 나오므로(통합은 NXT 를 포함한다) **고장으로 보이지도
    // 않는다** — 사용자는 자기가 잘못 눌렀다고 생각한다.
    localStorage.setItem('live.venue.v1', JSON.stringify({ venue: 'NXT' }));
    useLiveVenueStore.getState().hydrateFromStorage();
    expect(useLiveVenueStore.getState().venue).toBe('NXT');
  });

  it('accepts NXT at runtime via setVenue (부활한 옵션)', () => {
    useLiveVenueStore.getState().setVenue('NXT');
    expect(useLiveVenueStore.getState().venue).toBe('NXT');
    expect(localStorage.getItem('live.venue.v1')).toContain('NXT');
  });

  it('rejects unknown values at runtime', () => {
    useLiveVenueStore.getState().setVenue('bogus' as LiveVenueOption);
    expect(useLiveVenueStore.getState().venue).toBe('KRX');
  });

  it('hydrates from localStorage', () => {
    localStorage.setItem('live.venue.v1', JSON.stringify({ venue: 'UN' }));
    useLiveVenueStore.getState().hydrateFromStorage();
    expect(useLiveVenueStore.getState().venue).toBe('UN');
  });

  it('ignores persisted AUTO venue during hydration', () => {
    localStorage.setItem('live.venue.v1', JSON.stringify({ venue: 'AUTO' }));
    useLiveVenueStore.getState().hydrateFromStorage();
    expect(useLiveVenueStore.getState().venue).toBe('KRX');
  });

  it('ignores corrupt stored JSON during hydration', () => {
    localStorage.setItem('live.venue.v1', '{');
    useLiveVenueStore.getState().hydrateFromStorage();
    expect(useLiveVenueStore.getState().venue).toBe('KRX');
  });

  it('ignores persisted unknown venue values during hydration', () => {
    localStorage.setItem('live.venue.v1', JSON.stringify({ venue: 'BAD' }));
    useLiveVenueStore.getState().hydrateFromStorage();
    expect(useLiveVenueStore.getState().venue).toBe('KRX');
  });

  it('exposes the three venue options in order (KRX/NXT/통합)', () => {
    expect(LIVE_VENUE_OPTIONS.map((v) => LIVE_VENUE_LABELS[v])).toEqual(['KRX', 'NXT', '통합']);
  });

  /** 거래소는 탭 전역이다(2026-08-07 사용자 결정) — 탭별 비교는 포기하고
   *  한 탭에서 바꾸면 열려 있는 다른 탭도 리로드 없이 따라오게 한다. */
  describe('subscribeToLiveVenueStorage', () => {
    it('다른 탭의 선택을 반영하고, 해제하면 더 이상 반영하지 않는다', () => {
      const unsubscribe = subscribeToLiveVenueStorage();

      // 저장 → 이벤트 순서. 구독은 event.newValue 가 아니라 저장소를 다시 읽으므로
      // 이벤트만 쏘면 아무 일도 일어나지 않는다.
      localStorage.setItem('live.venue.v1', JSON.stringify({ venue: 'NXT' }));
      window.dispatchEvent(new StorageEvent('storage', { key: 'live.venue.v1' }));
      expect(useLiveVenueStore.getState().venue).toBe('NXT');

      unsubscribe();
      localStorage.setItem('live.venue.v1', JSON.stringify({ venue: 'UN' }));
      window.dispatchEvent(new StorageEvent('storage', { key: 'live.venue.v1' }));
      expect(useLiveVenueStore.getState().venue).toBe('NXT'); // 그대로
    });

    it('다른 키의 storage 이벤트는 무시한다', () => {
      const unsubscribe = subscribeToLiveVenueStorage();

      localStorage.setItem('live.venue.v1', JSON.stringify({ venue: 'UN' }));
      window.dispatchEvent(new StorageEvent('storage', { key: 'ui.themePreference.v1' }));

      expect(useLiveVenueStore.getState().venue).toBe('KRX'); // beforeEach 값
      unsubscribe();
    });

    it('다른 탭이 쓴 미지 값은 통과시키지 않는다', () => {
      // 저장소를 다시 읽는 설계의 이득: 초기화와 같은 검증(migrateStoredVenue)을
      // 그대로 탄다. newValue 를 믿었다면 손으로 편집된 값이 store 에 들어온다.
      const unsubscribe = subscribeToLiveVenueStorage();

      localStorage.setItem('live.venue.v1', JSON.stringify({ venue: 'BAD' }));
      window.dispatchEvent(new StorageEvent('storage', { key: 'live.venue.v1' }));

      expect(useLiveVenueStore.getState().venue).toBe('KRX');
      unsubscribe();
    });
  });
});
