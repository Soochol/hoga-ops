import { expect, test, type Page } from '@playwright/test';
import { installLiveMocks } from './helpers/liveMocks';

const indexLabels = { NASDAQ_COMPOSITE: '나스닥 종합', SP500: 'S&P 500', SOX: '필라델피아 반도체지수' };
const candles = Array.from({ length: 120 }, (_, index) => {
  const date = new Date(Date.UTC(2026, 4, 1 + index));
  const day = date.toISOString().slice(0, 10).replaceAll('-', '');
  return { trading_date: day, t_ms: Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()), open: 120.1234, high: 125.5678, low: 119.001, close: 121.2345, volume: 0 };
});
const meta = { market: 'US', market_timezone: 'America/New_York', source: 'kis', price_basis: 'index_points', currency: 'index_points', session_scope: 'cash_index', latest_bar_date: candles.at(-1)!.trading_date, last_successful_check_at_ms: 1_792_100_000_000, completed: [], missing: [], truncated: false, refresh_status: 'normal', messages: [] };

async function setup(page: Page) {
  await installLiveMocks(page);
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('live.workspace.v1')) sessionStorage.setItem('live.workspace.v1', JSON.stringify({ schema_version: 2,
      windows: [{ id: 'us-daily-test', kind: 'chart', group: 1, rect: { x: 0, y: 0, w: 0.8, h: 0.8 }, chart: { timeframe: '1m' } }],
      zOrder: ['us-daily-test'], groupSymbols: {},
    }));
  });
  await page.route(/\/api\/live\/indices(?:\?|$)/, route => route.fulfill({ json: { indices: Object.entries(indexLabels).map(([id, label]) => ({ kind: 'index', id, label, investor_scope: 'none', market: 'US', market_timezone: 'America/New_York', supported_timeframes: ['D'] })) } }));
  await page.route(/\/api\/live\/index-candles\?/, route => {
    const params = new URL(route.request().url()).searchParams;
    return route.fulfill({ json: { index_id: params.get('index_id'), from: params.get('from'), to: params.get('to'), timeframe: 'D', candles, data_warnings: [], daily_metadata: meta } });
  });
  await page.route(/\/api\/live\/us-stocks(?:\?|$)/, route => route.fulfill({ json: { stocks: [{ exchange: 'NASDAQ', symbol: 'NVDA', label: '엔비디아', english_name: 'NVIDIA', is_etf: false }], status: 'normal', fetched_at_ms: 1_792_100_000_000 } }));
  await page.route(/\/api\/live\/us-stock-daily-candles\?/, route => {
    const params = new URL(route.request().url()).searchParams;
    return route.fulfill({ json: { instrument_key: `us-stock:${params.get('exchange')}:${params.get('symbol')}`, exchange: params.get('exchange'), symbol: params.get('symbol'), from: params.get('from'), to: params.get('to'), timeframe: 'D', candles, daily_metadata: { ...meta, source: 'kiwoom', price_basis: 'raw', currency: 'USD', session_scope: 'vendor_daily_unverified' } } });
  });
}

for (const id of Object.keys(indexLabels)) {
  test(`${id}: URL and restore use daily REST candles with decimal prices`, async ({ page }, testInfo) => {
    await setup(page);
    const requests: string[] = [];
    page.on('request', request => requests.push(request.url()));
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`/live?index=${id}`);
    const frame = page.locator('.live-window-chart');
    await expect(frame.getByRole('status')).toContainText('지수값');
    await expect(frame.getByText('121.2345 pt', { exact: false }).first()).toBeVisible();
    await expect(frame.getByRole('group', { name: 'LiveTimeframe' }).getByRole('button')).toHaveCount(1);
    await expect.poll(() => requests.some(url => url.includes(`index_id=${id}&timeframe=D`))).toBe(true);
    expect(requests.filter(url => /index_id=(NASDAQ_COMPOSITE|SP500|SOX)/.test(url) && /timeframe=(1m|W|M)/.test(url))).toEqual([]);
    await frame.screenshot({ path: testInfo.outputPath(`${id}-daily.png`) });
    expect(errors).toEqual([]);
  });
}

test('US stock search preserves exchange/ticker and never requests domestic stock data', async ({ page }, testInfo) => {
  await setup(page);
  const requests: string[] = [];
  page.on('request', request => requests.push(request.url()));
  const usWsFrames: string[] = [];
  page.on('websocket', ws => ws.on('framesent', frame => { if (String(frame.payload).includes('NVDA')) usWsFrames.push(String(frame.payload)); }));
  await page.goto('/live');
  await page.keyboard.press('/');
  await page.getByRole('combobox').fill('NVDA');
  await page.getByRole('option', { name: /엔비디아/ }).click();
  const frame = page.locator('.live-window-chart');
  await expect(frame.getByRole('status')).toContainText('USD · 수정 전 가격');
  await expect(frame.getByText('121.2345 USD', { exact: false }).first()).toBeVisible();
  await expect.poll(() => requests.some(url => url.includes('us-stock-daily-candles?exchange=NASDAQ&symbol=NVDA'))).toBe(true);
  expect(requests.filter(url => /\/(past-daily-candles|quotes|stock-limits|investor-net|series)\?/.test(url) && /NVDA/.test(url))).toEqual([]);
  await expect(frame.getByRole('group', { name: 'LiveTimeframe' }).getByRole('button')).toHaveCount(1);
  expect(usWsFrames).toEqual([]);
  await frame.screenshot({ path: testInfo.outputPath('NVDA-daily.png') });
  // Reload restores the selected US instrument from the existing workspace state.
  await page.reload();
  await expect(frame.getByRole('status')).toContainText('USD · 수정 전 가격');
  await expect(frame.getByText('121.2345 USD', { exact: false }).first()).toBeVisible();
});


test('preferred-share URL keeps broker case and underscore across restore', async ({ page }) => {
  await setup(page);
  const requests: string[] = [];
  page.on('request', request => requests.push(request.url()));
  await page.goto('/live?market=US&exchange=NYSE&symbol=AHT_pd');
  const frame = page.locator('.live-window-chart');
  await expect(frame.getByText('121.2345 USD', { exact: false }).first()).toBeVisible();
  await expect.poll(() => requests.some(url => url.includes('exchange=NYSE&symbol=AHT_pd'))).toBe(true);
  await page.reload();
  await expect(frame.getByText('121.2345 USD', { exact: false }).first()).toBeVisible();
  expect(requests.filter(url => url.includes('symbol=AHT_PD'))).toEqual([]);
});
