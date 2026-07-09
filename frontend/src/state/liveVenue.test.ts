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

  it('migrates a persisted NXT venue to 통합(UN) on hydration (#523)', () => {
    localStorage.setItem('live.venue.v1', JSON.stringify({ venue: 'NXT' }));
    useLiveVenueStore.getState().hydrateFromStorage();
    expect(useLiveVenueStore.getState().venue).toBe('UN');
  });

  it('rejects NXT at runtime via setVenue (제거된 옵션)', () => {
    useLiveVenueStore.getState().setVenue('NXT' as LiveVenueOption);
    expect(useLiveVenueStore.getState().venue).toBe('KRX');
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

  it('exposes the requested UI labels (NXT 제거 후 KRX/통합)', () => {
    expect(LIVE_VENUE_OPTIONS.map((v) => LIVE_VENUE_LABELS[v])).toEqual(['KRX', '통합']);
  });
});
