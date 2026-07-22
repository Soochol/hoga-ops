import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useStudyViewOpenPrefsStore } from './studyViewOpenPrefs';

describe('study view open preferences', () => {
  beforeEach(() => {
    localStorage.clear();
    useStudyViewOpenPrefsStore.setState({ defaultTimeframe: '3m' });
  });

  it('defaults saved-view side-panel opens to the current study timeframe', async () => {
    // 초기값은 모듈 로드 시점에 결정되므로, 빈 스토리지에서 새로 로드해 검증한다.
    localStorage.clear();
    vi.resetModules();
    const fresh = await import('./studyViewOpenPrefs');
    expect(fresh.useStudyViewOpenPrefsStore.getState().defaultTimeframe).toBe('current');
  });

  it('persists the selected default minute timeframe', () => {
    useStudyViewOpenPrefsStore.getState().setDefaultTimeframe('5m');

    expect(useStudyViewOpenPrefsStore.getState().defaultTimeframe).toBe('5m');
    expect(localStorage.getItem('studyView.openPrefs.v1')).toContain('5m');
  });

  it('persists the current-timeframe option', () => {
    useStudyViewOpenPrefsStore.getState().setDefaultTimeframe('current');

    expect(useStudyViewOpenPrefsStore.getState().defaultTimeframe).toBe('current');
    expect(localStorage.getItem('studyView.openPrefs.v1')).toContain('current');
  });

  it('hydrates only valid saved-view open timeframes', () => {
    localStorage.setItem('studyView.openPrefs.v1', JSON.stringify({ defaultTimeframe: 'NOPE' }));
    useStudyViewOpenPrefsStore.setState({ defaultTimeframe: '5m' });

    useStudyViewOpenPrefsStore.getState().hydrateFromStorage();

    expect(useStudyViewOpenPrefsStore.getState().defaultTimeframe).toBe('5m');
  });

  it('migrates the legacy "saved" sentinel to "current" on hydrate', () => {
    localStorage.setItem('studyView.openPrefs.v1', JSON.stringify({ defaultTimeframe: 'saved' }));
    useStudyViewOpenPrefsStore.setState({ defaultTimeframe: '5m' });

    useStudyViewOpenPrefsStore.getState().hydrateFromStorage();

    expect(useStudyViewOpenPrefsStore.getState().defaultTimeframe).toBe('current');
  });
});
