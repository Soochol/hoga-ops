import { beforeEach, describe, expect, it } from 'vitest';
import { useStudyLastMinuteTimeframeStore } from './studyLastMinuteTimeframe';

describe('study last minute timeframe', () => {
  beforeEach(() => {
    localStorage.clear();
    useStudyLastMinuteTimeframeStore.setState({ lastMinuteTimeframe: '3m' });
  });

  it('defaults to 3m so "current" open falls back to a valid minute timeframe', () => {
    expect(useStudyLastMinuteTimeframeStore.getState().lastMinuteTimeframe).toBe('3m');
  });

  it('persists the last minute timeframe', () => {
    useStudyLastMinuteTimeframeStore.getState().setLastMinuteTimeframe('15m');

    expect(useStudyLastMinuteTimeframeStore.getState().lastMinuteTimeframe).toBe('15m');
    expect(localStorage.getItem('study.lastMinuteTimeframe.v1')).toContain('15m');
  });

  it('ignores non-minute timeframes', () => {
    useStudyLastMinuteTimeframeStore.getState().setLastMinuteTimeframe('D' as never);

    expect(useStudyLastMinuteTimeframeStore.getState().lastMinuteTimeframe).toBe('3m');
  });

  it('hydrates only a valid stored minute timeframe', () => {
    localStorage.setItem('study.lastMinuteTimeframe.v1', JSON.stringify({ lastMinuteTimeframe: 'NOPE' }));
    useStudyLastMinuteTimeframeStore.setState({ lastMinuteTimeframe: '5m' });

    useStudyLastMinuteTimeframeStore.getState().hydrateFromStorage();

    expect(useStudyLastMinuteTimeframeStore.getState().lastMinuteTimeframe).toBe('5m');
  });
});
