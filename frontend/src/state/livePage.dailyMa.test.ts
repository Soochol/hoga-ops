import { describe, it, expect, beforeEach } from 'vitest';
import { useLivePageStore, DEFAULT_DAILY_MAS } from './livePage';

describe('daily MA store setters', () => {
  beforeEach(() => {
    useLivePageStore.setState({
      dailyMovingAverages: DEFAULT_DAILY_MAS.map((m) => ({ ...m })),
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

  it('removeDailyMovingAverage removes by id', () => {
    useLivePageStore.getState().addDailyMovingAverage();
    const id = useLivePageStore.getState().dailyMovingAverages[1].id;
    useLivePageStore.getState().removeDailyMovingAverage(id);
    expect(useLivePageStore.getState().dailyMovingAverages.length).toBe(1);
  });

  // 마스터 토글이 슬롯의 `enabled` 로 접힌 뒤(레전드 칩 = 인스턴스), 마지막 슬롯도
  // 지울 수 있어야 한다 — 칩 ✕ 로 하나씩 지우면 0개에 도달하는 것이 정상 경로다.
  it('removeDailyMovingAverage can empty the list (0 slots is a valid state)', () => {
    const id = useLivePageStore.getState().dailyMovingAverages[0].id;
    useLivePageStore.getState().removeDailyMovingAverage(id);
    expect(useLivePageStore.getState().dailyMovingAverages).toEqual([]);
  });

  it('setAllDailyMovingAveragesEnabled flips every slot together', () => {
    useLivePageStore.getState().setAllDailyMovingAveragesEnabled(true);
    expect(useLivePageStore.getState().dailyMovingAverages.every((m) => m.enabled)).toBe(true);

    useLivePageStore.getState().setAllDailyMovingAveragesEnabled(false);
    expect(useLivePageStore.getState().dailyMovingAverages.some((m) => m.enabled)).toBe(false);
  });

  it('daily setter does NOT clobber current-bar movingAverages (single source)', () => {
    const before = useLivePageStore.getState().movingAverages;
    useLivePageStore.getState().setAllDailyMovingAveragesEnabled(true);
    expect(useLivePageStore.getState().movingAverages).toBe(before);
  });
});
