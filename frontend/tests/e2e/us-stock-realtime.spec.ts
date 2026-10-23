import { expect, test, type Page, type WebSocketRoute } from '@playwright/test';
import type { IChartApi, ISeriesApi } from 'lightweight-charts';
import { installLiveMocks } from './helpers/liveMocks';

const start = Date.UTC(2026, 9, 23, 15, 25, 30);
const stamp = Date.UTC(2026, 9, 23, 15, 25);
type Charts = Window & { __liveCharts?: Map<string, IChartApi> };
async function rows(page: Page, id: string) {
  return page.evaluate(key => {
    const chart = (window as Charts).__liveCharts?.get(key);
    const series = chart?.panes().flatMap(p => p.getSeries()).find(s => s.seriesType() === 'Candlestick') as ISeriesApi<'Candlestick'> | undefined;
    return series?.data().filter(r => 'close' in r) ?? [];
  }, id);
}

test('shared US feed updates daily and minute candles, retains extremes and restores after REST race', async ({ page }) => {
  await page.clock.install({ time: new Date(start) });
  await installLiveMocks(page);
  await page.addInitScript(() => sessionStorage.setItem('live.workspace.v1', JSON.stringify({ schema_version: 2,
    windows: [
      { id: 'us-minute', kind: 'chart', group: 1, rect: { x: 0, y: 0, w: 0.49, h: 0.95 }, chart: { timeframe: '1m' } },
      { id: 'us-daily', kind: 'chart', group: 1, rect: { x: 0.5, y: 0, w: 0.49, h: 0.95 }, chart: { timeframe: 'D' } },
    ], zOrder: ['us-minute', 'us-daily'], groupSymbols: {} })));
  let socket: WebSocketRoute | undefined;
  const sent: Array<{ action?: string; exchange?: string; symbol?: string; code?: string }> = [];
  await page.routeWebSocket('**/api/ws', ws => {
    socket = ws;
    ws.onMessage(raw => sent.push(JSON.parse(String(raw))));
  });
  let calls = 0;
  let release: (() => void) | undefined;
  await page.route(/\/api\/live\/us-stock-minute-candles\?/, async route => {
    calls++;
    if (calls === 2) await new Promise<void>(resolve => { release = resolve; });
    await route.fulfill({ json: { instrument_key: 'us-stock:NASDAQ:AAPL', exchange: 'NASDAQ', symbol: 'AAPL',
      from: '20261023', to: '20261023', timeframe: '1m', candles: [{ trading_date: '20261023', t_ms: stamp - 60_000,
        open: 99, high: 105, low: 95, close: 100, volume: 500 }], minute_metadata: {
        source: 'kiwoom', refresh_status: 'normal', more_available: false, next_cursor: null,
      } } });
  });
  await page.route(/\/api\/live\/us-stock-daily-candles\?/, route => {
    const q = new URL(route.request().url()).searchParams;
    return route.fulfill({ json: { instrument_key: 'us-stock:NASDAQ:AAPL', exchange: 'NASDAQ', symbol: 'AAPL',
      from: q.get('from'), to: q.get('to'), timeframe: 'D', candles: [{ trading_date: '20261022', t_ms: Date.UTC(2026, 9, 22),
        open: 98, high: 105, low: 95, close: 100, volume: 500 }], daily_metadata: { source: 'kiwoom', refresh_status: 'normal' } } });
  });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/live?market=US&exchange=NASDAQ&symbol=AAPL');
  await expect.poll(() => sent.filter(m => m.action === 'subscribe_us_stock')).toHaveLength(1);
  await expect.poll(async () => (await rows(page, 'us-minute')).length).toBe(1);
  await expect.poll(async () => (await rows(page, 'us-daily')).length).toBe(1);
  const push = async (sequence: number, close: number, minuteStamp = stamp, status = 'streaming') => {
    const now = await page.evaluate(() => Date.now());
    socket!.send(JSON.stringify({ ch: 'event', data: { type: 'us_stock_candles', instrument_key: 'us-stock:NASDAQ:AAPL',
      generation: 'fixture', sequence, status, checked_at_ms: now,
      minutes: [{ trading_date: '20261023', t_ms: minuteStamp, open: 103, high: 112, low: 101, close,
        volume: 0, observed_at_ms: now }],
      daily: { trading_date: '20261023', t_ms: Date.UTC(2026, 9, 23), open: 100, high: 120, low: 90, close, volume: 0 } } }));
  };
  await push(1, 108);
  for (const id of ['us-minute', 'us-daily']) await expect.poll(async () => (await rows(page, id)).at(-1)?.close).toBe(108);
  await push(2, 110);
  await expect.poll(async () => (await rows(page, 'us-minute')).at(-1)?.close).toBe(110);
  expect((await rows(page, 'us-minute')).at(-1)).toMatchObject({ high: 112, low: 101 });
  await push(1, 104);
  await page.clock.runFor(100);
  expect((await rows(page, 'us-minute')).at(-1)?.close).toBe(110);
  for (let step = 0; step < 3; step++) {
    await page.clock.fastForward(20_000);
    socket!.send(JSON.stringify({ ch: 'heartbeat' }));
    await page.clock.runFor(1);
  }
  await page.clock.fastForward(1_000);
  await expect.poll(() => calls).toBe(2);
  await push(3, 111, stamp + 60_000);
  await expect.poll(async () => (await rows(page, 'us-minute')).at(-1)?.close).toBe(111);
  release!();
  await expect.poll(async () => (await rows(page, 'us-minute')).length).toBe(3);
  expect((await rows(page, 'us-minute')).at(-1)?.close).toBe(111);
  await push(4, 111, stamp + 60_000, 'error');
  await expect(page.getByText('실시간 시세 연결 복구 중 · REST 조회 유지')).toHaveCount(2);
  expect(sent.filter(m => m.action === 'subscribe' && m.code?.includes('AAPL'))).toHaveLength(0);
  expect(errors).toEqual([]);
});
