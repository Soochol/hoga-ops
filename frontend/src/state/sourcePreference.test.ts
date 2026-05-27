import { describe, it, expect, beforeEach } from 'vitest';
import { useSourcePreferenceStore, SOURCE_OPTIONS, type SourcePreference } from './sourcePreference';

describe('useSourcePreferenceStore', () => {
  beforeEach(() => {
    localStorage.clear();
    useSourcePreferenceStore.setState({ sourcePreference: 'hogaplay' });
  });

  it('defaults to hogaplay (ADR-0039)', () => {
    expect(useSourcePreferenceStore.getState().sourcePreference).toBe('hogaplay');
  });

  it('setSourcePreference updates and persists to localStorage', () => {
    useSourcePreferenceStore.getState().setSourcePreference('kis_live');
    expect(useSourcePreferenceStore.getState().sourcePreference).toBe('kis_live');
    expect(localStorage.getItem('chart.sourcePreference.v1')).toContain('kis_live');
  });

  it('rejects unknown values at runtime', () => {
    const before = useSourcePreferenceStore.getState().sourcePreference;
    useSourcePreferenceStore.getState().setSourcePreference('bogus' as SourcePreference);
    expect(useSourcePreferenceStore.getState().sourcePreference).toBe(before);
  });

  it('hydrates from localStorage on read', () => {
    localStorage.setItem('chart.sourcePreference.v1', JSON.stringify({ sourcePreference: 'kis_live' }));
    useSourcePreferenceStore.getState().hydrateFromStorage();
    expect(useSourcePreferenceStore.getState().sourcePreference).toBe('kis_live');
  });

  it('SOURCE_OPTIONS exposes the two valid values', () => {
    expect(SOURCE_OPTIONS).toEqual(['hogaplay', 'kis_live']);
  });
});
