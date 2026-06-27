import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useLivePageStore } from './livePage';
import {
  DEFAULT_LIVE_MAS,
  MA_PERIOD_MIN,
  MA_PERIOD_MAX,
  MA_SLOT_LIMIT,
  type LiveMAConfig,
} from './livePage';

describe('livePage store', () => {
  beforeEach(() => {
    localStorage.clear();
    useLivePageStore.setState({
      activeCode: null,
      candleTimeframe: '1m',
      lastMinuteTimeframe: '1m',
      historicalFromDate: null,
    });
  });

  it('starts with sensible defaults', () => {
    const { activeCode, candleTimeframe } = useLivePageStore.getState();
    expect(activeCode).toBeNull();
    expect(candleTimeframe).toBe('1m');
  });

  it('setActiveCode updates state and persists', () => {
    useLivePageStore.getState().setActiveCode('005930');
    expect(useLivePageStore.getState().activeCode).toBe('005930');
    expect(localStorage.getItem('live.page.v1')).toContain('005930');
  });

  it('projectActiveView sets code + timeframe + historicalFromDate atomically and persists', () => {
    useLivePageStore.getState().projectActiveView({
      code: '005930', timeframe: '5m', historicalFromDate: '20260601',
    });
    const s = useLivePageStore.getState();
    expect(s.activeCode).toBe('005930');
    expect(s.candleTimeframe).toBe('5m');
    expect(s.historicalFromDate).toBe('20260601');
    const raw = JSON.parse(localStorage.getItem('live.page.v1') ?? '{}');
    expect(raw.activeCode).toBe('005930');
    expect(raw.candleTimeframe).toBe('5m');
    expect(raw.historicalFromDate).toBe('20260601');
  });

  it('projectActiveView with a null pan clears historicalFromDate (no leftover from a prior code)', () => {
    useLivePageStore.getState().projectActiveView({ code: 'A', timeframe: '1m', historicalFromDate: '20260101' });
    useLivePageStore.getState().projectActiveView({ code: 'B', timeframe: '1m', historicalFromDate: null });
    expect(useLivePageStore.getState().historicalFromDate).toBeNull();
  });

  it('projectActiveView falls back to the current timeframe when given an invalid one', () => {
    useLivePageStore.getState().setCandleTimeframe('5m');
    // @ts-expect-error — deliberately invalid timeframe to test the clamp
    useLivePageStore.getState().projectActiveView({ code: 'A', timeframe: 'NOPE', historicalFromDate: null });
    expect(useLivePageStore.getState().candleTimeframe).toBe('5m');
    expect(useLivePageStore.getState().activeCode).toBe('A');
  });

  it('setCandleTimeframe rejects unknown values', () => {
    const before = useLivePageStore.getState().candleTimeframe;
    // Cast bypasses the Literal type guard; runtime check inside
    // setCandleTimeframe should still reject the unknown value.
    useLivePageStore.getState().setCandleTimeframe('bogus' as never);
    expect(useLivePageStore.getState().candleTimeframe).toBe(before);
  });

  it('hydrates from localStorage on read', () => {
    localStorage.setItem(
      'live.page.v1',
      JSON.stringify({ activeCode: '000660', candleTimeframe: '5m' }),
    );
    // Re-import via dynamic to re-trigger hydration; simulate fresh session via setState from a hydration helper.
    useLivePageStore.getState().hydrateFromStorage();
    expect(useLivePageStore.getState().activeCode).toBe('000660');
    expect(useLivePageStore.getState().candleTimeframe).toBe('5m');
  });

  it('falls back to 1m on initial import when legacy storage omits lastMinuteTimeframe', async () => {
    localStorage.setItem(
      'live.page.v1',
      JSON.stringify({
        activeCode: '000660',
        candleTimeframe: 'D',
        historicalFromDate: null,
      }),
    );

    vi.resetModules();
    const { useLivePageStore: freshStore } = await import('./livePage');
    const state = freshStore.getState();

    expect(state.activeCode).toBe('000660');
    expect(state.candleTimeframe).toBe('D');
    expect(state.lastMinuteTimeframe).toBe('1m');
  });

  it('tracks the last selected minute timeframe', () => {
    useLivePageStore.getState().setCandleTimeframe('10m');
    expect(useLivePageStore.getState().candleTimeframe).toBe('10m');
    expect(useLivePageStore.getState().lastMinuteTimeframe).toBe('10m');

    useLivePageStore.getState().setCandleTimeframe('D');
    expect(useLivePageStore.getState().candleTimeframe).toBe('D');
    expect(useLivePageStore.getState().lastMinuteTimeframe).toBe('10m');
  });

  it('persists and hydrates lastMinuteTimeframe', () => {
    useLivePageStore.getState().setCandleTimeframe('15m');
    useLivePageStore.getState().setCandleTimeframe('W');

    const raw = JSON.parse(localStorage.getItem('live.page.v1') ?? '{}');
    expect(raw.candleTimeframe).toBe('W');
    expect(raw.lastMinuteTimeframe).toBe('15m');

    useLivePageStore.setState({
      activeCode: null,
      candleTimeframe: '1m',
      lastMinuteTimeframe: '1m',
      historicalFromDate: null,
    });
    useLivePageStore.getState().hydrateFromStorage();
    expect(useLivePageStore.getState().candleTimeframe).toBe('W');
    expect(useLivePageStore.getState().lastMinuteTimeframe).toBe('15m');
  });

  it('derives missing lastMinuteTimeframe from stored minute candleTimeframe', () => {
    localStorage.setItem(
      'live.page.v1',
      JSON.stringify({ activeCode: '000660', candleTimeframe: '5m', historicalFromDate: null }),
    );

    useLivePageStore.getState().hydrateFromStorage();

    expect(useLivePageStore.getState().candleTimeframe).toBe('5m');
    expect(useLivePageStore.getState().lastMinuteTimeframe).toBe('5m');
  });

  it('falls back to 1m when stored lastMinuteTimeframe is invalid or missing on calendar timeframe', () => {
    localStorage.setItem(
      'live.page.v1',
      JSON.stringify({
        activeCode: '000660',
        candleTimeframe: 'D',
        historicalFromDate: null,
        lastMinuteTimeframe: 'bogus',
      }),
    );

    useLivePageStore.getState().hydrateFromStorage();

    expect(useLivePageStore.getState().candleTimeframe).toBe('D');
    expect(useLivePageStore.getState().lastMinuteTimeframe).toBe('1m');
  });

  it('projectActiveView updates lastMinuteTimeframe only for minute projections', () => {
    useLivePageStore.getState().projectActiveView({
      code: '005930',
      timeframe: '10m',
      historicalFromDate: null,
    });
    expect(useLivePageStore.getState().lastMinuteTimeframe).toBe('10m');

    useLivePageStore.getState().projectActiveView({
      code: '005930',
      timeframe: 'M',
      historicalFromDate: null,
    });
    expect(useLivePageStore.getState().candleTimeframe).toBe('M');
    expect(useLivePageStore.getState().lastMinuteTimeframe).toBe('10m');
  });
});

describe('useLivePageStore.movingAverages', () => {
  beforeEach(() => {
    localStorage.removeItem('live.indicators.v1');
    // Force re-hydrate by resetting state to DEFAULT_LIVE_MAS clone.
    useLivePageStore.setState({
      movingAverages: DEFAULT_LIVE_MAS.map((m) => ({ ...m })),
    });
  });

  it('starts with DEFAULT_LIVE_MAS clone (4 entries)', () => {
    expect(useLivePageStore.getState().movingAverages).toHaveLength(4);
    expect(useLivePageStore.getState().movingAverages[0].period).toBe(5);
  });

  it('setMovingAverage patches one slot, preserves others by reference', () => {
    const before = useLivePageStore.getState().movingAverages;
    useLivePageStore.getState().setMovingAverage(before[1].id, { period: 25 });
    const after = useLivePageStore.getState().movingAverages;
    expect(after[1].period).toBe(25);
    expect(after[1].enabled).toBe(before[1].enabled);
    // Untouched slots are referentially equal (immutable patch).
    expect(after[0]).toBe(before[0]);
    expect(after[2]).toBe(before[2]);
  });

  it('setMovingAverage clamps period to [MA_PERIOD_MIN, MA_PERIOD_MAX]', () => {
    const id = useLivePageStore.getState().movingAverages[0].id;
    useLivePageStore.getState().setMovingAverage(id, { period: 1 });
    expect(useLivePageStore.getState().movingAverages[0].period).toBe(2);
    useLivePageStore.getState().setMovingAverage(id, { period: 1000 });
    expect(useLivePageStore.getState().movingAverages[0].period).toBe(400);
  });

  it('setMovingAverage floors non-integer period', () => {
    const id = useLivePageStore.getState().movingAverages[0].id;
    useLivePageStore.getState().setMovingAverage(id, { period: 3.7 });
    expect(useLivePageStore.getState().movingAverages[0].period).toBe(3);
  });

  it('setMovingAverage is no-op for unknown id', () => {
    const before = useLivePageStore.getState().movingAverages;
    useLivePageStore.getState().setMovingAverage('nope', { period: 99 });
    expect(useLivePageStore.getState().movingAverages).toBe(before);
  });

  it('addMovingAverage appends with new id, period = prev * 2 capped', () => {
    const before = useLivePageStore.getState().movingAverages;
    useLivePageStore.getState().addMovingAverage();
    const after = useLivePageStore.getState().movingAverages;
    expect(after).toHaveLength(before.length + 1);
    expect(after[after.length - 1].period).toBe(Math.min(120 * 2, 400));
    // id is unique
    expect(new Set(after.map((m) => m.id)).size).toBe(after.length);
  });

  it('addMovingAverage is no-op when MA_SLOT_LIMIT reached', () => {
    // Fill to limit.
    while (useLivePageStore.getState().movingAverages.length < MA_SLOT_LIMIT) {
      useLivePageStore.getState().addMovingAverage();
    }
    const at_limit = useLivePageStore.getState().movingAverages;
    useLivePageStore.getState().addMovingAverage();
    expect(useLivePageStore.getState().movingAverages).toBe(at_limit);
  });

  it('removeMovingAverage drops the entry', () => {
    const before = useLivePageStore.getState().movingAverages;
    const targetId = before[1].id;
    useLivePageStore.getState().removeMovingAverage(targetId);
    const after = useLivePageStore.getState().movingAverages;
    expect(after).toHaveLength(before.length - 1);
    expect(after.find((m) => m.id === targetId)).toBeUndefined();
  });

  it('removeMovingAverage refuses to drop the last slot', () => {
    // Reduce to 1.
    const ids = useLivePageStore.getState().movingAverages.map((m) => m.id);
    for (const id of ids.slice(1)) {
      useLivePageStore.getState().removeMovingAverage(id);
    }
    expect(useLivePageStore.getState().movingAverages).toHaveLength(1);
    const single = useLivePageStore.getState().movingAverages;
    useLivePageStore.getState().removeMovingAverage(single[0].id);
    expect(useLivePageStore.getState().movingAverages).toBe(single);
  });

  it('removeMovingAverage is no-op for unknown id', () => {
    const before = useLivePageStore.getState().movingAverages;
    useLivePageStore.getState().removeMovingAverage('nope');
    expect(useLivePageStore.getState().movingAverages).toBe(before);
  });

  it('mutations persist to localStorage("live.indicators.v1")', () => {
    const id = useLivePageStore.getState().movingAverages[0].id;
    useLivePageStore.getState().setMovingAverage(id, { period: 7 });
    const raw = localStorage.getItem('live.indicators.v1');
    expect(raw).toContain('"period":7');

    useLivePageStore.getState().setVolumeDistributionHoverCutoffEnabled(true);
    const persisted = JSON.parse(localStorage.getItem('live.indicators.v1')!);
    expect(persisted.volumeDistributionHoverCutoffEnabled).toBe(true);
  });
});

describe('useLivePageStore.askPeakAllPriceStyle', () => {
  beforeEach(() => {
    localStorage.removeItem('live.indicators.v1');
    useLivePageStore.setState({
      askPeakAllPriceColor: '#F97316',
      askPeakAllPriceLineWidth: 1,
    });
  });

  it('setAskPeakAllPriceStyle updates color and width independently', () => {
    useLivePageStore.getState().setAskPeakAllPriceStyle({ color: '#22C55E' });
    expect(useLivePageStore.getState().askPeakAllPriceColor).toBe('#22C55E');
    expect(useLivePageStore.getState().askPeakAllPriceLineWidth).toBe(1);

    useLivePageStore.getState().setAskPeakAllPriceStyle({ lineWidth: 4 });
    expect(useLivePageStore.getState().askPeakAllPriceColor).toBe('#22C55E');
    expect(useLivePageStore.getState().askPeakAllPriceLineWidth).toBe(4);
  });

  it('persists all-price style fields in the indicator snapshot', () => {
    useLivePageStore.getState().setAskPeakAllPriceStyle({ color: '#22C55E', lineWidth: 3 });
    const raw = JSON.parse(localStorage.getItem('live.indicators.v1') ?? '{}');
    expect(raw.askPeakAllPriceColor).toBe('#22C55E');
    expect(raw.askPeakAllPriceLineWidth).toBe(3);
  });
});

describe('useLivePageStore.askPeakVisibleMaxStyle', () => {
  beforeEach(() => {
    localStorage.removeItem('live.indicators.v1');
    useLivePageStore.setState({
      askPeakVisibleMaxColor: '#EAB308',
      askPeakVisibleMaxLineWidth: 3,
    });
  });

  it('setAskPeakVisibleMaxStyle updates color and width independently', () => {
    useLivePageStore.getState().setAskPeakVisibleMaxStyle({ color: '#A855F7' });
    expect(useLivePageStore.getState().askPeakVisibleMaxColor).toBe('#A855F7');
    expect(useLivePageStore.getState().askPeakVisibleMaxLineWidth).toBe(3);

    useLivePageStore.getState().setAskPeakVisibleMaxStyle({ lineWidth: 4 });
    expect(useLivePageStore.getState().askPeakVisibleMaxColor).toBe('#A855F7');
    expect(useLivePageStore.getState().askPeakVisibleMaxLineWidth).toBe(4);
  });

  it('persists visible max style fields in the indicator snapshot', () => {
    useLivePageStore.getState().setAskPeakVisibleMaxStyle({ color: '#A855F7', lineWidth: 4 });
    const raw = JSON.parse(localStorage.getItem('live.indicators.v1') ?? '{}');
    expect(raw.askPeakVisibleMaxColor).toBe('#A855F7');
    expect(raw.askPeakVisibleMaxLineWidth).toBe(4);
  });
});

describe('useLivePageStore.viLimitPriceLineStyle', () => {
  beforeEach(() => {
    localStorage.removeItem('live.indicators.v1');
    useLivePageStore.setState({
      viLimitPriceLineColor: '#EAB308',
      viLimitPriceLineWidth: 3,
    });
  });

  it('setViLimitPriceLineStyle updates color and width independently', () => {
    useLivePageStore.getState().setViLimitPriceLineStyle({ color: '#A855F7' });
    expect(useLivePageStore.getState().viLimitPriceLineColor).toBe('#A855F7');
    expect(useLivePageStore.getState().viLimitPriceLineWidth).toBe(3);

    useLivePageStore.getState().setViLimitPriceLineStyle({ lineWidth: 4 });
    expect(useLivePageStore.getState().viLimitPriceLineColor).toBe('#A855F7');
    expect(useLivePageStore.getState().viLimitPriceLineWidth).toBe(4);
  });

  it('persists VI/상하한가 line style fields in the indicator snapshot', () => {
    useLivePageStore.getState().setViLimitPriceLineStyle({ color: '#A855F7', lineWidth: 4 });
    const raw = JSON.parse(localStorage.getItem('live.indicators.v1') ?? '{}');
    expect(raw.viLimitPriceLineColor).toBe('#A855F7');
    expect(raw.viLimitPriceLineWidth).toBe(4);
  });
});

describe('LiveMAConfig constants', () => {
  it('exposes period bounds and slot limit', () => {
    expect(MA_PERIOD_MIN).toBe(2);
    expect(MA_PERIOD_MAX).toBe(400);
    expect(MA_SLOT_LIMIT).toBe(8);
  });

  it('DEFAULT_LIVE_MAS has 4 entries (5/20/60/120, all enabled, close, 1px)', () => {
    expect(DEFAULT_LIVE_MAS).toHaveLength(4);
    expect(DEFAULT_LIVE_MAS.map((m: LiveMAConfig) => m.period)).toEqual([5, 20, 60, 120]);
    expect(DEFAULT_LIVE_MAS.every((m: LiveMAConfig) => m.enabled)).toBe(true);
    expect(DEFAULT_LIVE_MAS.every((m: LiveMAConfig) => m.source === 'close')).toBe(true);
    expect(DEFAULT_LIVE_MAS.every((m: LiveMAConfig) => m.lineWidth === 1)).toBe(true);
  });

  it('DEFAULT_LIVE_MAS ids are unique', () => {
    const ids = DEFAULT_LIVE_MAS.map((m: LiveMAConfig) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('DEFAULT_LIVE_MAS is frozen (Object.freeze)', () => {
    expect(Object.isFrozen(DEFAULT_LIVE_MAS)).toBe(true);
  });
});
