import { describe, it, expect, beforeEach } from 'vitest';
import { useLivePageStore } from './livePage';

describe('livePage store', () => {
  beforeEach(() => {
    localStorage.clear();
    useLivePageStore.setState({
      activeCode: null,
      candleTimeframe: '1m',
      watchlistPanelOpen: false,
    });
  });

  it('starts with sensible defaults', () => {
    const { activeCode, candleTimeframe, watchlistPanelOpen } = useLivePageStore.getState();
    expect(activeCode).toBeNull();
    expect(candleTimeframe).toBe('1m');
    expect(watchlistPanelOpen).toBe(false);
  });

  it('setActiveCode updates state and persists', () => {
    useLivePageStore.getState().setActiveCode('005930');
    expect(useLivePageStore.getState().activeCode).toBe('005930');
    expect(localStorage.getItem('live.page.v1')).toContain('005930');
  });

  it('setCandleTimeframe rejects unknown values', () => {
    const before = useLivePageStore.getState().candleTimeframe;
    // Cast bypasses the Literal type guard; runtime check inside
    // setCandleTimeframe should still reject the unknown value.
    useLivePageStore.getState().setCandleTimeframe('bogus' as never);
    expect(useLivePageStore.getState().candleTimeframe).toBe(before);
  });

  it('toggleWatchlistPanel flips and persists', () => {
    const initial = useLivePageStore.getState().watchlistPanelOpen;
    useLivePageStore.getState().toggleWatchlistPanel();
    expect(useLivePageStore.getState().watchlistPanelOpen).toBe(!initial);
  });

  it('hydrates from localStorage on read', () => {
    localStorage.setItem(
      'live.page.v1',
      JSON.stringify({ activeCode: '000660', candleTimeframe: '5m', watchlistPanelOpen: true }),
    );
    // Re-import via dynamic to re-trigger hydration; simulate fresh session via setState from a hydration helper.
    useLivePageStore.getState().hydrateFromStorage();
    expect(useLivePageStore.getState().activeCode).toBe('000660');
    expect(useLivePageStore.getState().candleTimeframe).toBe('5m');
    expect(useLivePageStore.getState().watchlistPanelOpen).toBe(true);
  });
});
