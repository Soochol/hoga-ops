import { beforeEach, describe, expect, it } from 'vitest';
import { useStudyViewOpenPrefsStore } from './studyViewOpenPrefs';

describe('study view open preferences', () => {
  beforeEach(() => {
    localStorage.clear();
    useStudyViewOpenPrefsStore.setState({ defaultTimeframe: '3m' });
  });

  it('defaults saved-view side-panel opens to 3m', () => {
    expect(useStudyViewOpenPrefsStore.getState().defaultTimeframe).toBe('3m');
  });

  it('persists the selected default minute timeframe', () => {
    useStudyViewOpenPrefsStore.getState().setDefaultTimeframe('5m');

    expect(useStudyViewOpenPrefsStore.getState().defaultTimeframe).toBe('5m');
    expect(localStorage.getItem('studyView.openPrefs.v1')).toContain('5m');
  });

  it('persists the saved-timeframe option', () => {
    useStudyViewOpenPrefsStore.getState().setDefaultTimeframe('saved');

    expect(useStudyViewOpenPrefsStore.getState().defaultTimeframe).toBe('saved');
    expect(localStorage.getItem('studyView.openPrefs.v1')).toContain('saved');
  });

  it('hydrates only valid saved-view open timeframes', () => {
    localStorage.setItem('studyView.openPrefs.v1', JSON.stringify({ defaultTimeframe: 'NOPE' }));
    useStudyViewOpenPrefsStore.setState({ defaultTimeframe: '5m' });

    useStudyViewOpenPrefsStore.getState().hydrateFromStorage();

    expect(useStudyViewOpenPrefsStore.getState().defaultTimeframe).toBe('5m');
  });
});
