import { describe, it, expect, beforeEach } from 'vitest';
import { LIVE_VENUE_LABELS, LIVE_VENUE_OPTIONS, useLiveVenueStore, type LiveVenueOption } from './liveVenue';

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
});
