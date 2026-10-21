import { beforeEach, describe, expect, it } from 'vitest';
import { usStockInstrument, usStockFromKey, usStockKey, instrumentToActiveCode, instrumentToSubjectKey, indexInstrument } from './liveInstrument';
import { liveDeepLinkPath, toGroupSymbol, activateLiveInstrument } from './liveNavigate';
import { useWorkspaceStore } from '../state/workspace';
import { capabilitiesForInstrument } from './liveInstrumentCapabilities';
import { buildPriceBundle } from './buildIndexBundle';
import { buildLiveSearchCatalog, searchLiveCatalog } from './liveSymbolSearchModel';
import { formatInstrumentPrice, instrumentPriceUnit } from './instrumentPriceFormat';
import { parseItemSortableId, entrySortableId } from '../watchlist/dragHandlers';
import { indicatorInstanceApplicable } from './indicators/indicatorInstancePanes';

describe('US daily chart identity and capability boundaries', () => {
  beforeEach(() => {
    useWorkspaceStore.setState({ windows: [{ id: 'us-test', kind: 'chart', group: 1, rect: { x: 0, y: 0, w: 1, h: 1 }, chart: { timeframe: '1m' } }], zOrder: ['us-test'], groupSymbols: {} });
  });
  it('preserves exchange and dotted tickers across subject, URL, group and drag identity', () => {
    const stock = usStockInstrument('NYSE', 'BRK.B', '버크셔');
    const key = usStockKey('NYSE', 'BRK.B');
    expect(instrumentToActiveCode(stock)).toBeNull();
    expect(instrumentToSubjectKey(stock)).toBe(key);
    expect(usStockFromKey(key, '버크셔')).toEqual(stock);
    expect(usStockFromKey(`${key}:unexpected`)).toBeNull();
    expect(toGroupSymbol(stock)).toEqual({ kind: 'us_stock', code: key, name: '버크셔' });
    expect(liveDeepLinkPath(stock)).toBe('/live?market=US&exchange=NYSE&symbol=BRK.B');
    expect(parseItemSortableId(entrySortableId('f_12345678', key))).toEqual({ folderId: 'f_12345678', kind: 'code', code: key });
  });
  it('preserves broker-specific case and preferred-share underscore symbols', () => {
    for (const symbol of ['BRKb', 'AHT_pd']) {
      const key = usStockKey('NYSE', symbol);
      expect(usStockFromKey(key)).toEqual(usStockInstrument('NYSE', symbol));
      expect(liveDeepLinkPath(usStockInstrument('NYSE', symbol))).toContain(`symbol=${symbol}`);
    }
  });
  it('retains minute and W/M selections on US stock search, drops and pins', () => {
    activateLiveInstrument(usStockInstrument('NASDAQ', 'AAPL'));
    expect(useWorkspaceStore.getState().windows[0].chart?.timeframe).toBe('1m');
    useWorkspaceStore.getState().setChartTimeframe('us-test', '5m');
    expect(useWorkspaceStore.getState().windows[0].chart?.timeframe).toBe('5m');
    useWorkspaceStore.getState().setWindowSymbol('us-test', { code: 'us-stock:NYSE:BRK.B', name: '버크셔' });
    expect(useWorkspaceStore.getState().groupSymbols[1]?.kind).toBe('us_stock');
    for (const tf of ['W', 'M'] as const) {
      useWorkspaceStore.getState().setChartTimeframe('us-test', tf);
      expect(useWorkspaceStore.getState().windows[0].chart?.timeframe).toBe(tf);
      activateLiveInstrument(indexInstrument('SOX'));
      expect(useWorkspaceStore.getState().windows[0].chart?.timeframe).toBe(tf);
      useWorkspaceStore.getState().setWindowSymbol('us-test', { code: 'us-stock:NYSE:BRKb', name: '버크셔' });
      expect(useWorkspaceStore.getState().windows[0].chart?.timeframe).toBe(tf);
      useWorkspaceStore.getState().toggleWindowPin('us-test');
      expect(useWorkspaceStore.getState().windows[0].chart?.timeframe).toBe(tf);
      useWorkspaceStore.getState().toggleWindowPin('us-test');
    }
  });
  it('keeps pinned domestic windows unchanged when an overseas search replaces its group', () => {
    useWorkspaceStore.setState({ windows: [
      { id: 'us-test', kind: 'chart', group: 1, rect: { x: 0, y: 0, w: 0.5, h: 1 }, chart: { timeframe: '1m' } },
      { id: 'pinned', kind: 'chart', group: 1, pinned: { code: '005930', name: '삼성전자' }, rect: { x: 0.5, y: 0, w: 0.5, h: 1 }, chart: { timeframe: '3m' } },
    ], zOrder: ['us-test', 'pinned'] });
    activateLiveInstrument(indexInstrument('SOX'));
    const windows = useWorkspaceStore.getState().windows;
    expect(windows[0].chart?.timeframe).toBe('1m');
    expect(windows[1].pinned?.code).toBe('005930');
    expect(windows[1].chart?.timeframe).toBe('3m');
  });
  it.each(['NASDAQ_COMPOSITE', 'SP500', 'SOX'] as const)('%s preserves supported minutes through group, pin and stock changes', id => {
    activateLiveInstrument(indexInstrument(id));
    for (const tf of ['1m', '3m', '5m', '10m', '15m', '30m', '60m'] as const) {
      useWorkspaceStore.getState().setChartTimeframe('us-test', tf);
      useWorkspaceStore.getState().toggleWindowPin('us-test');
      expect(useWorkspaceStore.getState().windows[0].chart?.timeframe).toBe(tf);
      useWorkspaceStore.getState().toggleWindowPin('us-test');
    }
    for (const tf of ['1s', '120m', '240m'] as const) {
      useWorkspaceStore.getState().setChartTimeframe('us-test', tf);
      expect(useWorkspaceStore.getState().windows[0].chart?.timeframe).toBe('D');
    }
    useWorkspaceStore.getState().setChartTimeframe('us-test', '5m');
    activateLiveInstrument(usStockInstrument('NASDAQ', 'AAPL'));
    expect(useWorkspaceStore.getState().windows[0].chart?.timeframe).toBe('5m');
  });
  it.each(['NASDAQ', 'NYSE', 'AMEX'] as const)('%s stocks preserve supported minutes through pins and group replacements', exchange => {
    activateLiveInstrument(usStockInstrument(exchange, 'Test_pd'));
    for (const tf of ['1m', '3m', '5m', '10m', '15m', '30m', '60m'] as const) {
      useWorkspaceStore.getState().setChartTimeframe('us-test', tf);
      useWorkspaceStore.getState().toggleWindowPin('us-test');
      expect(useWorkspaceStore.getState().windows[0].chart?.timeframe).toBe(tf);
      useWorkspaceStore.getState().toggleWindowPin('us-test');
      activateLiveInstrument(usStockInstrument(exchange, 'Other_b'));
      expect(useWorkspaceStore.getState().windows[0].chart?.timeframe).toBe(tf);
    }
    for (const tf of ['1s', '120m', '240m'] as const) {
      useWorkspaceStore.getState().setChartTimeframe('us-test', tf);
      expect(useWorkspaceStore.getState().windows[0].chart?.timeframe).toBe('D');
    }
  });
  it('disables domestic sidecars, collection, volume and turnover but allows price indicators', () => {
    for (const instrument of [usStockInstrument('NASDAQ', 'NVDA'), indexInstrument('NASDAQ_COMPOSITE'), indexInstrument('SP500'), indexInstrument('SOX')]) {
      expect(capabilitiesForInstrument(instrument)).toMatchObject({ hogaPanes: false, investorNet: 'none', studySave: false, tradeValue: false, volume: false });
    }
    expect(indicatorInstanceApplicable('moving-average', 'D', false, true)).toBe(true);
    expect(indicatorInstanceApplicable('volume', 'D', false, true)).toBe(false);
    expect(indicatorInstanceApplicable('foreign-net', 'D', false, true)).toBe(false);
  });
  it('finds the S&P 500 index when typed without its display space', () => {
    const catalog = buildLiveSearchCatalog([], [{ kind: 'index', id: 'SP500', label: 'S&P 500', investorScope: 'none' }]);
    expect(searchLiveCatalog(catalog, 'S&P500')[0]).toMatchObject({ kind: 'index', index: { id: 'SP500' } });
  });
  it('searches US symbols and Korean/English names with exchange identity', () => {
    const catalog = buildLiveSearchCatalog([], [], [{ exchange: 'NASDAQ', symbol: 'AAPL', label: '애플', english_name: 'APPLE INC', is_etf: false }]);
    for (const q of ['aapl', '애플', 'apple']) expect(searchLiveCatalog(catalog, q)[0]).toMatchObject({ kind: 'us_stock', stock: { exchange: 'NASDAQ', symbol: 'AAPL' } });
  });
  it('retains decimal prices, original trading dates and synthetic display anchors', () => {
    const bundle = buildPriceBundle({ code: 'us-stock:NASDAQ:NVDA', from: '20240607', to: '20240607', bucketMs: 86_400_000,
      candles: [{ trading_date: '20240607', t_ms: 1717718400000, open: 119.77, high: 121.6917, low: 118.022, close: 120.888, volume: 0 }] });
    expect(bundle.candles[0].close).toBe(120.888);
    expect(bundle.segments[0].date).toBe('20240607');
    expect(formatInstrumentPrice(121.6917, bundle.code)).toBe('121.69');
    expect(formatInstrumentPrice(120, bundle.code)).toBe('120.00');
    expect(formatInstrumentPrice(1234567.8912, bundle.code)).toBe('1,234,567.89');
    for (const code of ['index:NASDAQ_COMPOSITE', 'index:SP500', 'index:SOX']) {
      expect(formatInstrumentPrice(121.6917, code)).toBe('121.69');
      expect(formatInstrumentPrice(120, code)).toBe('120.00');
      expect(formatInstrumentPrice(1234567.8912, code)).toBe('1,234,567.89');
    }
    expect(instrumentPriceUnit(bundle.code)).toBe(' USD');
    expect(instrumentPriceUnit('index:SP500')).toBe(' pt');
  });
});
