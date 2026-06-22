import { describe, it, expect, beforeEach } from 'vitest';
import { useSourcePreferenceStore, SOURCE_OPTIONS, type SourcePreference } from './sourcePreference';

describe('useSourcePreferenceStore', () => {
  beforeEach(() => {
    localStorage.clear();
    useSourcePreferenceStore.setState({ sourcePreference: 'hogaplay_first' });
  });

  it('defaults to hogaplay priority (ADR-0039)', () => {
    expect(useSourcePreferenceStore.getState().sourcePreference).toBe('hogaplay_first');
  });

  it('setSourcePreference updates and persists to localStorage', () => {
    useSourcePreferenceStore.getState().setSourcePreference('kis_api_first');
    expect(useSourcePreferenceStore.getState().sourcePreference).toBe('kis_api_first');
    expect(localStorage.getItem('chart.sourcePreference.v1')).toContain('kis_api_first');
  });

  it('rejects unknown values at runtime', () => {
    const before = useSourcePreferenceStore.getState().sourcePreference;
    useSourcePreferenceStore.getState().setSourcePreference('bogus' as SourcePreference);
    expect(useSourcePreferenceStore.getState().sourcePreference).toBe(before);
  });

  it('hydrates from localStorage on read', () => {
    localStorage.setItem('chart.sourcePreference.v1', JSON.stringify({ sourcePreference: 'kis_ws_first' }));
    useSourcePreferenceStore.getState().hydrateFromStorage();
    expect(useSourcePreferenceStore.getState().sourcePreference).toBe('kis_ws_first');
  });

  it('migrates legacy localStorage values', () => {
    localStorage.setItem('chart.sourcePreference.v1', JSON.stringify({ sourcePreference: 'hogaplay' }));
    useSourcePreferenceStore.getState().hydrateFromStorage();
    expect(useSourcePreferenceStore.getState().sourcePreference).toBe('hogaplay_first');

    localStorage.setItem('chart.sourcePreference.v1', JSON.stringify({ sourcePreference: 'kis_live' }));
    useSourcePreferenceStore.getState().hydrateFromStorage();
    expect(useSourcePreferenceStore.getState().sourcePreference).toBe('kis_ws_first');
  });

  it('SOURCE_OPTIONS exposes the three display priority policies', () => {
    expect(SOURCE_OPTIONS).toEqual(['hogaplay_first', 'kis_ws_first', 'kis_api_first']);
  });
});
