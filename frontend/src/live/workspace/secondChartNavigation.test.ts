import { beforeEach, expect, it } from 'vitest';
import { useWorkspaceStore, windowSymbolOf, type WorkspaceWindow } from '../../state/workspace';
import { openSecondChartRange, secondRangeQuery } from './secondChartNavigation';
import { secondChartBundle } from './secondChartBundle';
import { registerSecondTimeframeViewport } from './secondTimeframeViewport';
const symbol = { code: '005930', name: '삼성전자', kind: 'stock' as const };
const window = (id: string, timeframe: '1m' | '5s' = '1m'): WorkspaceWindow => ({ id, kind: 'chart', group: 1, chart: { timeframe }, rect: { x: 0, y: 0, w: .5, h: .5 } });
const from = Date.parse('2026-09-28T10:00:00+09:00'), to = from + 60000;
beforeEach(() => useWorkspaceStore.setState({ windows: [window('source')], zOrder: ['source'], groupSymbols: { 1: symbol }, chartRuntime: {}, maximizedId: null }));
it('creates a seconds target, reuses it, and keeps its range through seconds interval changes', () => {
  const id = openSecondChartRange('source', to, from)!;
  const ws = useWorkspaceStore.getState();
  expect(ws.windows.find(w => w.id === id)?.chart?.timeframe).toBe('5s');
  expect(ws.chartRuntime[id]?.secondRange).toMatchObject({ fromMs: from, toMs: to });
  expect(ws.chartRuntime.source).toBeUndefined();
  expect(openSecondChartRange('source', from, to)).toBe(id);
  expect(useWorkspaceStore.getState().windows).toHaveLength(2);
  ws.setChartTimeframe(id, '10s');
  expect(useWorkspaceStore.getState().chartRuntime[id]?.secondRange?.seq).toBe(2);
  ws.setWindowSymbol(id, { code: '000660', name: 'SK하이닉스' });
  expect(useWorkspaceStore.getState().chartRuntime[id]?.secondRange).toBeUndefined();
});
it('preserves other pinned subjects and a pinned source does not replace the group symbol', () => {
  useWorkspaceStore.setState({ windows: [{ ...window('source'), pinned: symbol }, { ...window('other', '5s'), pinned: { code: '000660', name: 'SK하이닉스' } }], zOrder: ['other', 'source'], groupSymbols: { 1: { code: '000660', name: 'SK하이닉스' } } });
  const id = openSecondChartRange('source', from, to)!;
  const ws = useWorkspaceStore.getState();
  expect(id).not.toBe('other');
  expect(ws.groupSymbols[1]?.code).toBe('000660');
  expect(windowSymbolOf(ws, ws.windows.find(w => w.id === id))?.code).toBe('005930');
  expect(windowSymbolOf(ws, ws.windows.find(w => w.id === 'other'))?.code).toBe('000660');
});
it('aligns inclusive anchors to an exclusive API range without crossing midnight', () => {
  const end = Date.parse('2026-09-28T23:59:59+09:00');
  expect(secondRangeQuery({ fromMs: from + 1234, toMs: end }, 5)).toEqual({ date: '20260928', fromMs: from, endMs: end + 1000 });
});
it('hands the viewport to a seconds transition once and clears it on subject or resolution-family changes', () => {
  const ws = useWorkspaceStore.getState();
  ws.setChartTimeframe('source', '5s');
  const remove = registerSecondTimeframeViewport('source', () => ({ code: symbol.code, timeframe: '5s', venue: 'KRX', followLatest: false,
    viewport: { leftEdgeMs: from, rightEdgeMs: to, barSpan: 12, atLiveEdge: false } }));
  try {
    ws.setChartTimeframe('source', '10s');
    const snapshot = useWorkspaceStore.getState().chartRuntime.source.secondViewport!;
    expect(snapshot).toMatchObject({ target: '10s', timeframe: '5s', viewport: { rightEdgeMs: to } });
    ws.consumeSecondViewport('source', { ...snapshot });
    expect(useWorkspaceStore.getState().chartRuntime.source.secondViewport).toBe(snapshot);
    ws.consumeSecondViewport('source', snapshot);
    expect(useWorkspaceStore.getState().chartRuntime.source.secondViewport).toBeUndefined();
    ws.setChartTimeframe('source', '30s');
    ws.setWindowSymbol('source', { code: '000660', name: 'SK하이닉스' });
    expect(useWorkspaceStore.getState().chartRuntime.source?.secondViewport).toBeUndefined();
    // Navigation may change subject and resolution before React unmounts the old chart.
    ws.setChartTimeframe('source', '10s');
    expect(useWorkspaceStore.getState().chartRuntime.source.secondViewport).toBeUndefined();
    ws.setChartTimeframe('source', '1m');
    expect(useWorkspaceStore.getState().chartRuntime.source.secondViewport).toBeUndefined();
  } finally { remove(); }
});
it('builds observed directional quantities at display resolution without counting unknown sides', () => {
  const bars = [{ t_ms: from, open: 10, close: 11, high: 12, low: 9, volume: 100, count: 5, trade_value: 1000 }];
  const bundle = secondChartBundle(symbol.code, '20260928', 5, bars, [
    { t_ms: from, price: 10, side: 1, qty: 4, count: 1 }, { t_ms: from + 1000, price: 11, side: 1, qty: 6, count: 1 },
    { t_ms: from + 2000, price: 11, side: -1, qty: 3, count: 1 }, { t_ms: from + 3000, price: 11, side: 0, qty: 90, count: 1 },
  ]);
  expect(bundle.fill_strength.points).toEqual([{ t: from, buy_qty: 10, sell_qty: 3 }]);
  expect(bundle.candles[0].vol_a).toBe(100);
});
