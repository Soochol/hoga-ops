import { act, renderHook } from '@testing-library/react';
import { beforeEach, expect, it } from 'vitest';
import type { ReactNode } from 'react';
import { useCursorSyncResolution } from './useCursorSyncResolution';
import { useLiveCursorStore } from './useLiveCursorStore';
import { WindowViewContext } from './workspace/windowView';
import { useChartPrefsStore } from '../state/chartPrefs';

const day = Date.UTC(2026, 8, 18);
const candles = [{ ts_ms: day, close: 100 }, { ts_ms: day + 86400000, close: 110 }];
const origin = { windowId: 'source', group: 1, code: '005930', timeframe: '1m' as const };
const wrapper = ({ children }: { children: ReactNode }) =>
  <WindowViewContext.Provider value={{ windowId: 'target', group: 1, code: '005930', timeframe: 'D', historicalFromDate: null }}>
    {children}
  </WindowViewContext.Provider>;
beforeEach(() => {
  useLiveCursorStore.getState().resetCursor();
  useChartPrefsStore.getState().resetToDefaults();
});
it('ignores gated publications and same-day minute movement, but follows data and date changes', () => {
  let renders = 0;
  const { result, rerender } = renderHook(({ data }) => {
    renders++;
    return useCursorSyncResolution({ candles: data, timeframe: 'D', code: '005930' });
  }, { wrapper, initialProps: { data: candles } });
  const initial = renders;
  for (const gate of [{ ...origin, group: 2 }, { ...origin, windowId: 'target' }]) {
    act(() => useLiveCursorStore.getState().setSyncCursor(day, gate));
  }
  expect(renders).toBe(initial);
  act(() => useLiveCursorStore.getState().setSyncCursor(day, origin));
  const hitRenders = renders;
  for (let i = 1; i <= 60; i++) act(() => useLiveCursorStore.getState().setSyncCursor(day + i * 60000, origin));
  expect(renders).toBe(hitRenders);
  expect(result.current).toEqual({ kind: 'hit', candle: candles[0] });
  const updated = [{ ...candles[0], close: 105 }, candles[1]];
  rerender({ data: updated });
  expect(result.current).toEqual({ kind: 'hit', candle: updated[0] });
  act(() => useLiveCursorStore.getState().setSyncCursor(day + 86400000, origin));
  expect(result.current).toEqual({ kind: 'hit', candle: candles[1] });
  act(() => useLiveCursorStore.getState().clearSyncCursorFrom('source'));
  expect(result.current.kind).toBe('none');
});
it('disabled consumers do not render for cursor events and resolve when enabled', () => {
  let renders = 0;
  const { result, rerender } = renderHook(({ enabled }) => {
    renders++;
    return useCursorSyncResolution({ candles, timeframe: 'D', code: '005930', enabled });
  }, { wrapper, initialProps: { enabled: false } });
  const initial = renders;
  act(() => useLiveCursorStore.getState().setSyncCursor(day, origin));
  expect(renders).toBe(initial);
  rerender({ enabled: true });
  expect(result.current.kind).toBe('hit');
});

for (const timeframe of ['W', 'M'] as const) {
  it(`${timeframe} resolves remote legend candles even with target tooltip ON and coalesces in-period movement`, () => {
    let renders = 0;
    const { result } = renderHook(() => {
      renders++;
      return useCursorSyncResolution({ candles: [candles[0]], timeframe, code: '005930' });
    }, { wrapper });
    act(() => useLiveCursorStore.getState().setSyncCursor(day, origin));
    expect(result.current).toEqual({ kind: 'hit', candle: candles[0] });
    const hitRenders = renders;
    act(() => useChartPrefsStore.getState().setToggle('candleTooltipEnabled', true));
    act(() => useLiveCursorStore.getState().setSyncCursor(day + 3600000, origin));
    expect(renders).toBe(hitRenders);
    expect(result.current).toEqual({ kind: 'hit', candle: candles[0] });
  });
}

it('does not resolve a remote cursor for a seconds receiver', () => {
  const { result } = renderHook(() => useCursorSyncResolution({ candles, timeframe: '1s', code: '005930' }), { wrapper });
  act(() => useLiveCursorStore.getState().setSyncCursor(day, origin));
  expect(result.current).toEqual({ kind: 'none' });
});


for (const timeframe of ['W', 'M'] as const) {
  it(`${timeframe} keeps the source point while target refresh reveals or replaces the exact last loaded minute`, () => {
    const point = Date.UTC(2026, 10, 2);
    const owner = { ...origin, timeframe };
    const first = { ts_ms: point + 60000, close: 100 };
    const last = { ts_ms: point + 120000, close: 200 };
    const { result, rerender } = renderHook(({ data }) =>
      useCursorSyncResolution({ candles: data, timeframe: '1m', code: '005930' }),
    { wrapper, initialProps: { data: candles.slice(0, 0) } });
    act(() => useLiveCursorStore.getState().setSyncCursor(point, owner));
    expect(result.current).toEqual({ kind: 'none' });
    rerender({ data: [first] });
    expect(result.current).toEqual({ kind: 'hit', candle: first });
    rerender({ data: [first, last] });
    expect(result.current).toEqual({ kind: 'hit', candle: last });
    rerender({ data: [first, { ...last, close: 250 }] });
    expect(result.current).toEqual({ kind: 'hit', candle: { ...last, close: 250 } });
    expect(useLiveCursorStore.getState()).toMatchObject({ syncCursorMs: point, syncCursorOrigin: owner });
  });
}
