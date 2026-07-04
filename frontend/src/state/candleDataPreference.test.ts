import { beforeEach, describe, expect, it } from 'vitest';
import {
  CANDLE_DATA_PREFERENCE_OPTIONS,
  getCandleDataPreferenceLabel,
  useCandleDataPreferenceStore,
  type CandleDataPreference,
} from './candleDataPreference';

describe('candleDataPreference', () => {
  beforeEach(() => {
    localStorage.clear();
    useCandleDataPreferenceStore.setState({ candleDataPreference: 'auto' });
  });

  it('defaults to auto', () => {
    expect(useCandleDataPreferenceStore.getState().candleDataPreference).toBe('auto');
  });

  it('updates and persists valid values', () => {
    useCandleDataPreferenceStore.getState().setCandleDataPreference('hogaplay_first');
    expect(useCandleDataPreferenceStore.getState().candleDataPreference).toBe('hogaplay_first');
    expect(localStorage.getItem('chart.candleDataPreference.v1')).toContain('hogaplay_first');
  });

  it('ignores invalid values', () => {
    useCandleDataPreferenceStore.getState().setCandleDataPreference('bogus' as CandleDataPreference);
    expect(useCandleDataPreferenceStore.getState().candleDataPreference).toBe('auto');
  });

  it('hydrates from localStorage', () => {
    localStorage.setItem('chart.candleDataPreference.v1', JSON.stringify({ candleDataPreference: 'kis_api_first' }));
    useCandleDataPreferenceStore.getState().hydrateFromStorage();
    expect(useCandleDataPreferenceStore.getState().candleDataPreference).toBe('kis_api_first');
  });

  it('defines user-facing labels', () => {
    expect(CANDLE_DATA_PREFERENCE_OPTIONS).toEqual(['auto', 'hogaplay_first', 'kis_api_first', 'screener_daily_first']);
    expect(getCandleDataPreferenceLabel('auto')).toBe('자동');
    expect(getCandleDataPreferenceLabel('hogaplay_first')).toBe('hogaplay 우선');
    expect(getCandleDataPreferenceLabel('kis_api_first')).toBe('KIS API 우선');
    expect(getCandleDataPreferenceLabel('screener_daily_first')).toBe('스크리너 일봉 우선');
  });
});
