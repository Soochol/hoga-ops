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

  it('exposes the requested UI labels', () => {
    expect(LIVE_VENUE_OPTIONS.map((v) => LIVE_VENUE_LABELS[v])).toEqual(['KRX', 'NXT', '통합']);
  });
});
