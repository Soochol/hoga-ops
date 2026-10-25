import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { useTradeBrowseStore as browse } from './tradeBrowse';
import { useLiveCursorStore } from './useLiveCursorStore';
import { useWorkspaceStore } from '../state/workspace';
import { useLiveVenueStore } from '../state/liveVenue';
import { earlierTradeScope, tradeSpotScope } from './tradeSpotScope';
import { nextTradePage } from '../api/tradeBrowse';
import type { TradeSpotResponse } from '../api/tradeSpot';

const T = Date.parse('2026-09-29T09:31:00+09:00');
const origin = { windowId: 'chart', group: 1, code: '005930', timeframe: '1m' as const, venue: 'KRX' as const, barStartMs: T };
const scope = tradeSpotScope(T, origin, '005930', 1, 'KRX')!;
const begin = () => browse.getState().begin('tape', '005930', 1, 'KRX', 'hogaplay', 0);
function hover() { useLiveCursorStore.getState().setSidebarCursor(T, { ...origin }); }
beforeEach(() => {
  browse.getState().end();
  useLiveCursorStore.getState().resetCursor();
  useLiveVenueStore.setState({ venue: 'KRX' });
  useWorkspaceStore.setState({ windows: [
    { id: 'chart', kind: 'chart', group: 1, rect: { x: 0, y: 0, w: 500, h: 400 }, chart: { timeframe: '1m', hoverLinked: true } },
    { id: 'tape', kind: 'trade', group: 1, rect: { x: 500, y: 0, w: 300, h: 400 } },
  ], groupSymbols: { 1: { code: '005930', name: '삼성전자' } } });
});
afterEach(() => { browse.getState().end(); vi.useRealTimers(); });

describe('trade browsing ownership', () => {
  it('hands off the last real hover after chart leave, and latches only after scrolling', () => {
    hover();
    useLiveCursorStore.getState().clearSidebarCursorFrom('chart');
    begin();
    expect(browse.getState().session?.browsing).toBe(false);
    browse.getState().leave('tape');
    expect(browse.getState().session).toBeNull();
    begin();
    browse.getState().move('tape', earlierTradeScope(scope, T - 1)!);
    browse.getState().leave('tape');
    expect(browse.getState().session?.cursorMs).toBe(T - 60000);
    expect(browse.getState().session?.browsing).toBe(true);
    expect(useLiveCursorStore.getState().sidebarCursorMs).toBeNull();
    hover();
    expect(browse.getState().session).toBeNull();
  });
  it('ignores another tape and an expired or reconfigured chart candidate', () => {
    hover(); begin();
    browse.getState().move('other-tape', earlierTradeScope(scope, T - 1)!);
    browse.getState().end('other-tape');
    expect(browse.getState().session?.cursorMs).toBe(T);
    browse.getState().end(); hover();
    vi.useFakeTimers(); vi.setSystemTime(Date.now() + 2001);
    begin(); expect(browse.getState().session).toBeNull();
    vi.useRealTimers(); hover();
    useWorkspaceStore.setState(s => ({ windows: s.windows.map(w => w.kind === 'chart' ? { ...w, chart: { timeframe: '5m' } } : w) }));
    begin(); expect(browse.getState().session).toBeNull();
  });
  it.each(['link', 'timeframe', 'code', 'group', 'session', 'close', 'venue'] as const)('exits when %s changes', change => {
    hover(); begin(); browse.getState().move('tape', scope);
    if (change === 'venue') useLiveVenueStore.setState({ venue: 'NXT' });
    else if (change === 'code') useWorkspaceStore.setState({ groupSymbols: { 1: { code: '000660', name: 'SK하이닉스' } } });
    else useWorkspaceStore.setState(s => ({ windows: s.windows.flatMap(w => {
      if (w.id !== 'chart') return [w];
      if (change === 'close') return [];
      if (change === 'group') return [{ ...w, group: 2 }];
      return [{ ...w, chart: { ...w.chart!, ...(change === 'link' ? { hoverLinked: false }
        : change === 'timeframe' ? { timeframe: '5m' as const } : { regularSessionOnly: true }) } }];
    }) }));
    expect(browse.getState().session).toBeNull();
  });
});

describe('observed-bar pagination', () => {
  it('finishes the current candle before visiting the previous observed candle', () => {
    const data = { has_more: true, next_cursor: 'tail', previous_observed_ms: T - 60001 } as TradeSpotResponse;
    expect(nextTradePage({ scope, data })).toEqual({ scope, cursor: 'tail' });
    const next = nextTradePage({ scope, data: { ...data, has_more: false, next_cursor: null } })!;
    expect(next.scope.fromMs).toBe(T - 120000);
    expect(next.cursor).toBeNull();
  });
  it.each(['1s', '5s', '10s', '30s', '1m', '5m', '60m', '120m'] as const)('uses the real %s candle anchor', timeframe => {
    const seed = tradeSpotScope(T, { ...origin, timeframe }, '005930', 1, 'KRX')!;
    const next = earlierTradeScope(seed, T - 1)!;
    const step = Number(timeframe.slice(0, -1)) * (timeframe.endsWith('s') ? 1000 : 60000);
    expect(next.fromMs).toBeLessThan(seed.fromMs);
    expect(next.fromMs).toBeLessThanOrEqual(T - 1);
    expect(next.toMs).toBeGreaterThan(T - 1);
    expect(next.toMs - next.fromMs).toBe(step);
  });
  it('stops at the trading date, regular-session boundary, or nondecreasing pointer', () => {
    expect(earlierTradeScope(scope, T)).toBeNull();
    expect(earlierTradeScope(scope, T - 86400000)).toBeNull();
    expect(earlierTradeScope(scope, null)).toBeNull();
    const regular = { ...scope, regularSessionOnly: true };
    expect(earlierTradeScope(regular, Date.parse('2026-09-29T08:59:59+09:00'))).toBeNull();
  });
});
