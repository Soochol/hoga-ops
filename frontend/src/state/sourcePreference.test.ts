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
    useSourcePreferenceStore.getState().setSourcePreference('kis_ws_first');
    expect(useSourcePreferenceStore.getState().sourcePreference).toBe('kis_ws_first');
    expect(localStorage.getItem('chart.sourcePreference.v1')).toContain('kis_ws_first');
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

  it('demotes the removed kis_api_first stored value to the default (2026-07-17)', () => {
    // 트리비얼 통과 방지: 기본값이 아닌 상태에서 시작해 강등이 실제로 일어남을 확인.
    useSourcePreferenceStore.setState({ sourcePreference: 'kis_ws_first' });
    localStorage.setItem('chart.sourcePreference.v1', JSON.stringify({ sourcePreference: 'kis_api_first' }));
    useSourcePreferenceStore.getState().hydrateFromStorage();
    expect(useSourcePreferenceStore.getState().sourcePreference).toBe('hogaplay_first');
  });

  it('SOURCE_OPTIONS exposes the display priority policies', () => {
    expect(SOURCE_OPTIONS).toEqual(['hogaplay_first', 'kis_ws_first', 'completeness_first']);
  });
});
