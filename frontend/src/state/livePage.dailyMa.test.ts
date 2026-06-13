import { describe, it, expect, beforeEach } from 'vitest';
import { useLivePageStore, DEFAULT_DAILY_MAS } from './livePage';

describe('daily MA store setters', () => {
  beforeEach(() => {
    useLivePageStore.setState({
      dailyMovingAverages: DEFAULT_DAILY_MAS.map((m) => ({ ...m })),
      dailyMovingAverageEnabled: false,
      dailyMovingAverageHidden: false,
    });
  });

  it('setDailyMovingAverage patches a slot (period clamped to int)', () => {
    const id = useLivePageStore.getState().dailyMovingAverages[0].id;
    useLivePageStore.getState().setDailyMovingAverage(id, { period: 60 });
    expect(useLivePageStore.getState().dailyMovingAverages[0].period).toBe(60);
  });

  it('addDailyMovingAverage appends a slot', () => {
    useLivePageStore.getState().addDailyMovingAverage();
    expect(useLivePageStore.getState().dailyMovingAverages.length).toBe(2);
    expect(useLivePageStore.getState().dailyMovingAverages[1].id).toMatch(/^dma-/);
  });

  it('removeDailyMovingAverage removes by id (keeps ≥1)', () => {
    useLivePageStore.getState().addDailyMovingAverage();
    const id = useLivePageStore.getState().dailyMovingAverages[1].id;
    useLivePageStore.getState().removeDailyMovingAverage(id);
    expect(useLivePageStore.getState().dailyMovingAverages.length).toBe(1);
  });

  it('enabled/hidden setters flip flags', () => {
    useLivePageStore.getState().setDailyMovingAverageEnabled(true);
    useLivePageStore.getState().setDailyMovingAverageHidden(true);
    expect(useLivePageStore.getState().dailyMovingAverageEnabled).toBe(true);
    expect(useLivePageStore.getState().dailyMovingAverageHidden).toBe(true);
  });

  it('daily setter does NOT clobber current-bar movingAverages (single source)', () => {
    const before = useLivePageStore.getState().movingAverages;
    useLivePageStore.getState().setDailyMovingAverageEnabled(true);
    expect(useLivePageStore.getState().movingAverages).toBe(before);
  });
});
