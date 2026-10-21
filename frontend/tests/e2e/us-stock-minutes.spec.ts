import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { expect, test, type Page } from '@playwright/test';
import type { IChartApi, ISeriesApi } from 'lightweight-charts';
import type { UsStockMinuteResponse } from '../../src/api/usDailyCandles';
import { installLiveMocks } from './helpers/liveMocks';

// Public price responses captured through the new production adapter, with
// cached-token live reads kept separate from these deterministic browser tests.
const evidence = JSON.parse(gunzipSync(readFileSync(new URL('../../../docs/research/2026-10-19-us-stock-minute-app-live.json.gz', import.meta.url))).toString('utf8')) as { responses: UsStockMinuteResponse[] };
type ChartsWindow = Window & { __liveCharts?: Map<string, IChartApi> };
const windowId = 'us-stock-minute-test';
async function measure(page: Page) {
  return page.evaluate(id => {
    const chart = (window as ChartsWindow).__liveCharts?.get(id);
    const series = chart?.panes().flatMap(p => p.getSeries()).find(s => s.seriesType() === 'Candlestick') as ISeriesApi<'Candlestick'> | undefined;
    const rows = series?.data().filter(r => 'close' in r) ?? [];
    const last = rows.at(-1);
    return { axisPrice: series?.priceFormatter().format(1234567.8912), count: rows.length, last, range: chart?.timeScale().getVisibleLogicalRange(), width: chart?.timeScale().width(), latestX: last ? chart?.timeScale().timeToCoordinate(last.time) : null };
  }, windowId);
}
async function setup(page: Page, options: { stale?: () => boolean; midnight?: boolean } = {}) {
  await installLiveMocks(page);
  await page.addInitScript(id => {
    if (!sessionStorage.getItem('live.workspace.v1')) sessionStorage.setItem('live.workspace.v1', JSON.stringify({ schema_version: 2,
      windows: [{ id, kind: 'chart', group: 1, rect: { x: 0, y: 0, w: 0.95, h: 0.95 }, chart: { timeframe: '1m' } }], zOrder: [id], groupSymbols: {} }));
  }, windowId);
  await page.route(/\/api\/live\/us-stock-minute-candles\?/, route => {
    const params = new URL(route.request().url()).searchParams;
    const item = evidence.responses.find(r => r.exchange === params.get('exchange') && r.symbol === params.get('symbol') && r.timeframe === params.get('timeframe'));
    if (!item) return route.fulfill({ status: 422, json: { detail: 'unexpected stock minute fixture request' } });
    const payload = structuredClone(item);
    if (options.stale?.()) payload.minute_metadata.refresh_status = 'stale';
    if (options.midnight) {
      payload.candles = payload.candles.slice(-102).map((c, i) => ({ ...c, trading_date: '20261016', t_ms: Date.UTC(2026, 9, 16, 14, 30 + i) }));
      payload.minute_metadata.available_from_ms = payload.candles[0].t_ms;
      payload.minute_metadata.available_to_ms = payload.candles.at(-1)!.t_ms;
    }
    return route.fulfill({ json: payload });
  });
  await page.route(/\/api\/live\/us-stock-daily-candles\?/, route => {
    const params = new URL(route.request().url()).searchParams;
    return route.fulfill({ json: { instrument_key: `us-stock:${params.get('exchange')}:${params.get('symbol')}`, exchange: params.get('exchange'), symbol: params.get('symbol'), timeframe: params.get('timeframe'), from: params.get('from'), to: params.get('to'), candles: [{ trading_date: '20261016', t_ms: Date.UTC(2026, 9, 16), open: 120, high: 125, low: 119, close: 121.2345, volume: 1 }], daily_metadata: { source: 'kiwoom', price_basis: 'raw', currency: 'USD', refresh_status: 'normal', latest_bar_date: '20261016' } } });
  });
}
for (const [exchange, symbol] of [['NASDAQ', 'NVDA'], ['NASDAQ', 'AAPL'], ['NYSE', 'KO'], ['NYSE', 'BRKb'], ['NYSE', 'AHT_pd'], ['AMEX', 'AAAA']]) {
  test(`${exchange} ${symbol}: native minutes paint, poll and restore without domestic API or WS requests`, async ({ page }, testInfo) => {
    let stale = false;
    await page.clock.install();
    await setup(page, { stale: () => stale });
    const requests: string[] = [], errors: string[] = [], wsFrames: string[] = [];
    page.on('request', req => requests.push(req.url()));
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.text().includes('[virtualAxis]')) errors.push(message.text()); });
    page.on('websocket', ws => ws.on('framesent', event => wsFrames.push(String(event.payload))));
    await page.goto(`/live?market=US&exchange=${exchange}&symbol=${symbol}`);
    const frame = page.locator('.live-window-chart');
    await expect.poll(async () => (await measure(page)).count).toBe(800);
    await expect(frame.getByRole('status')).toHaveCount(0);
    await page.clock.runFor(500);
    await expect(frame.getByTestId('chart-reveal-cover')).toHaveCSS('opacity', '0');
    const expected = evidence.responses.find(r => r.exchange === exchange && r.symbol === symbol && r.timeframe === '1m')!.candles.at(-1)!;
    await expect(frame.getByText(`${expected.close.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USD`, { exact: false }).first()).toBeVisible();
    const initial = await measure(page);
    expect(initial.axisPrice).toBe('1,234,567.89');
    // Multi-day axes compress non-trading gaps; compare price and counts here,
    // and use the NY/KST fixture test below for the real epoch assertion.
    expect(initial.last).toMatchObject({ close: expected.close });
    expect(initial.latestX).toBeGreaterThan(0);
    expect(initial.latestX!).toBeLessThan(initial.width!);
    writeFileSync(testInfo.outputPath('viewport.json'), JSON.stringify(initial, null, 2));
    await frame.screenshot({ path: testInfo.outputPath(`${symbol}-1m.png`) });
    const before = requests.filter(url => url.includes('/us-stock-minute-candles?')).length;
    await page.evaluate(id => (window as ChartsWindow).__liveCharts?.get(id)?.timeScale().setVisibleLogicalRange({ from: -300, to: -100 }), windowId);
    await page.clock.fastForward(1_000);
    expect(requests.filter(url => url.includes('/us-stock-minute-candles?'))).toHaveLength(before);
    stale = true;
    await page.clock.fastForward(61_000);
    await expect(frame.getByRole('status')).toContainText('조회 실패 · 이전 데이터 유지');
    await expect.poll(async () => (await measure(page)).count).toBe(800);
    stale = false;
    await page.reload();
    await expect.poll(async () => (await measure(page)).count).toBe(800);
    if (symbol === 'NVDA') {
      for (const period of ['3', '5', '10', '15', '30', '60']) {
        await frame.getByRole('button', { name: /분봉 선택 열기:/ }).click();
        await expect(page.getByRole('menu', { name: '분봉 목록' }).getByRole('menuitemradio')).toHaveCount(7);
        await page.getByRole('menuitemradio', { name: `${period}분`, exact: true }).click();
        await expect(frame.getByRole('status')).toHaveCount(0);
        await expect.poll(async () => (await measure(page)).count).toBe(800);
        await page.clock.runFor(300);
        await expect(frame.getByTestId('chart-reveal-cover')).toHaveCSS('opacity', '0');
      }
      await frame.screenshot({ path: testInfo.outputPath('NVDA-60m.png') });
      await page.reload();
      await expect(frame.getByRole('button', { name: '분봉 선택 열기: 60분' })).toBeVisible();
      await expect(frame.getByRole('status')).toHaveCount(0);
      for (const label of ['일', '주', '월']) {
        await frame.getByRole('group', { name: 'LiveTimeframe' }).getByRole('button', { name: label, exact: true }).click();
        await expect(frame.getByRole('status')).toHaveCount(0);
        await expect(frame.getByText('121.23 USD', { exact: false }).first()).toBeVisible();
      }
    }
    expect(requests.filter(url => /\/(past-candles|past-daily-candles|screener-daily-candles|quotes|series|stock-limits|investor-net)\?/.test(url) && url.includes(symbol))).toEqual([]);
    expect(requests.filter(url => url.includes('/index-candles?'))).toEqual([]);
    expect(wsFrames.filter(message => message.includes(symbol))).toEqual([]);
    expect(errors).toEqual([]);
  });
}

test('US stock minute window crosses KST midnight on a single NY business date', async ({ page }, testInfo) => {
  await setup(page, { midnight: true });
  await page.goto('/live?market=US&exchange=NASDAQ&symbol=NVDA');
  await expect.poll(async () => (await measure(page)).count).toBe(102);
  await expect(page.getByTestId('chart-reveal-cover')).toHaveCSS('opacity', '0');
  expect((await measure(page)).last).toMatchObject({ time: Date.UTC(2026, 9, 16, 16, 11) / 1000 });
  await page.locator('.live-window-chart').screenshot({ path: testInfo.outputPath('KST-midnight.png') });
});
