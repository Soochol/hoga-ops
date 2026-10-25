import { describe, expect, it } from 'vitest';
import { tradeSpotScope } from './tradeSpotScope';
import { useLiveCursorStore, type SidebarCursorOrigin } from './useLiveCursorStore';

const T = Date.parse('2026-09-29T09:31:20+09:00');
const origin: SidebarCursorOrigin = { windowId: 'chart', group: 1, code: '005930', timeframe: '10s', venue: 'KRX' };
describe('trade spot scope', () => {
  it.each(['1s', '5s', '10s', '30s', '1m', '3m', '5m', '10m', '15m', '30m', '60m', '120m', '240m'] as const)('uses the candle anchor and duration for %s', timeframe => {
    const scope = tradeSpotScope(T, { ...origin, timeframe, barStartMs: T }, '005930', 1, 'UN')!;
    expect(scope.venue).toBe('KRX');
    expect(scope.date).toBe('20260929');
    expect(scope.fromMs).toBe(T);
    expect(scope.toMs - scope.fromMs).toBe(Number(timeframe.slice(0, -1)) * (timeframe.endsWith('s') ? 1000 : 60_000));
  });
  it('gates group, pinned subject, calendar bars and absent hover', () => {
    expect(tradeSpotScope(T, origin, '000660', 1, 'KRX')).toBeNull();
    expect(tradeSpotScope(T, origin, '005930', 2, 'KRX')).toBeNull();
    expect(tradeSpotScope(null, origin, '005930', 1, 'KRX')).toBeNull();
    expect(tradeSpotScope(T, { ...origin, timeframe: 'D' }, '005930', 1, 'KRX')).toBeNull();
  });
  it('clips a regular-session candle at the closing execution second', () => {
    const start = Date.parse('2026-09-29T15:00:00+09:00');
    const scope = tradeSpotScope(start, { ...origin, timeframe: '60m', regularSessionOnly: true }, '005930', 1, 'UN')!;
    expect(scope.toMs).toBe(Date.parse('2026-09-29T15:30:01+09:00'));
  });
  it('publishes a changed market and candle duration even at the same cursor time', () => {
    const store = useLiveCursorStore.getState();
    store.resetCursor();
    store.setSidebarCursor(T, origin);
    store.setSidebarCursor(T, { ...origin, venue: 'UN', timeframe: '1m' });
    expect(useLiveCursorStore.getState().sidebarCursorOrigin).toEqual({ ...origin, venue: 'UN', timeframe: '1m' });
    store.resetCursor();
  });
});
