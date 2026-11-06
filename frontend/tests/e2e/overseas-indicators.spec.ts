import { expect, test, type Page } from '@playwright/test';
import type { IChartApi } from 'lightweight-charts';
import { installLiveMocks } from './helpers/liveMocks';

const id = 'overseas-indicators';
const daily = Array.from({ length: 160 }, (_, i) => {
  const t_ms = Date.UTC(2026, 3, 1 + i);
  return { trading_date: new Date(t_ms).toISOString().slice(0, 10).replaceAll('-', ''), t_ms,
    open: 100 + i / 10, high: 103 + i / 10, low: 98 + i / 10, close: 101.25 + i / 10,
    volume: i === 0 ? 0 : 1000 + i, volume_available: true };
});
const metadata = { market: 'US', market_timezone: 'America/New_York', source: 'kiwoom', price_basis: 'adjusted',
  adjusted_as_of: '20260907', currency: 'USD', session_scope: 'vendor_daily_unverified', history_start: null,
  latest_bar_date: daily.at(-1)!.trading_date, last_successful_check_at_ms: 1_792_100_000_000,
  completed: [], missing: [], truncated: false, refresh_status: 'normal', messages: [] };
async function setup(page: Page, missing: boolean | 'tail' = false) {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.clock.setFixedTime(new Date('2026-09-07T20:00:00Z'));
  await installLiveMocks(page);
  await page.addInitScript(id => {
    if (!sessionStorage.getItem('live.workspace.v1')) sessionStorage.setItem('live.workspace.v1', JSON.stringify({ schema_version: 2,
      windows: [{ id, kind: 'chart', group: 1, rect: { x: 0, y: 0, w: 0.95, h: 0.9 }, chart: { timeframe: 'D' } }],
      zOrder: [id], groupSymbols: {} }));
  }, id);
  await page.route(/\/api\/live\/(us-stock-daily-candles|index-candles)\?/, route => {
    const p = new URL(route.request().url()).searchParams;
    const tf = p.get('timeframe') ?? 'D';
    const rows = tf === 'D' ? daily : daily.filter((_, i) => i % (tf === 'W' ? 7 : 30) === 0);
    return route.fulfill({ json: { instrument_key: 'us-stock:NASDAQ:NVDA', exchange: 'NASDAQ', symbol: 'NVDA',
      index_id: p.get('index_id'), from: p.get('from'), to: p.get('to'), timeframe: tf,
      candles: rows.map(r => (missing === true || (missing === 'tail' && r === rows.at(-1))) ? { ...r, volume: 0, volume_available: false } : r), daily_metadata: metadata, data_warnings: [] } });
  });
  await page.route(/\/api\/live\/(us-stock-minute-candles|index-candles)\?[^#]*timeframe=1m/, route => {
    const rows = Array.from({ length: 130 }, (_, i) => ({ ...daily.at(-1)!, t_ms: Date.UTC(2026, 8, 7, 13, 30 + i), trading_date: '20260907', volume: 250 + i }));
    return route.fulfill({ json: { instrument_key: 'us-stock:NASDAQ:NVDA', exchange: 'NASDAQ', symbol: 'NVDA',
      index_id: new URL(route.request().url()).searchParams.get('index_id'), timeframe: '1m', from: '20260907', to: '20260907', candles: rows, data_warnings: [],
      minute_metadata: { market_timezone: 'America/New_York', source: 'kiwoom', history_scope: 'bounded', delay_status: 'unknown', session_scope: 'vendor', refresh_status: 'normal', messages: [], refresh_interval_ms: 60000,
        available_from_ms: rows[0].t_ms, available_to_ms: rows.at(-1)!.t_ms, price_basis: 'adjusted', adjusted_as_of: '20260907', currency: 'USD', bar_limit: 900, pages_fetched: 1, more_available: false, next_cursor: null } } });
  });
}
async function series(page: Page) {
  return page.evaluate(id => {
    const chart = (window as Window & { __liveCharts?: Map<string, IChartApi> }).__liveCharts?.get(id);
    return chart?.panes().map(p => p.getSeries().map(s => ({ type: s.seriesType(), data: s.data(), formatted: s.priceFormatter().format(123.456) }))) ?? [];
  }, id);
}
async function add(page: Page, name: string) {
  const editor = page.getByTestId('indicator-panel-shell');
  await editor.getByRole('button', { name: '지표 추가', exact: true }).click();
  await editor.getByRole('button', { name, exact: true }).click();
  await editor.getByRole('button', { name: '설정대로 추가', exact: true }).click();
}
for (const subject of ['stock', 'index']) {
  test(`${subject}: shared catalog, real volume, settings and restoration`, async ({ page }, info) => {
    await setup(page);
    const requests: string[] = [], errors: string[] = [];
    page.on('request', r => requests.push(r.url()));
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(subject === 'stock' ? '/live?market=US&exchange=NASDAQ&symbol=NVDA' : '/live?index=SP500');
    await expect.poll(async () => (await series(page)).flat().some(s => s.type === 'Candlestick' && s.data.length === 160)).toBe(true);
    await page.getByTestId('live-indicators-button').click();
    await add(page, '거래량');
    await expect.poll(async () => (await series(page)).flat().filter(s => s.type === 'Histogram').map(s => s.data.length)).toEqual([160, 160]);
    const histogram = (await series(page)).flat().find(s => s.type === 'Histogram')!;
    expect(histogram.data[0]).toMatchObject({ value: 0 });
    expect(histogram.data.at(-1)).toMatchObject({ value: 1159 });
    const editor = page.getByTestId('indicator-panel-shell');
    await editor.getByRole('radio', { name: '이전 거래량과 비교', exact: true }).check();
    await add(page, '볼린저 밴드');
    await editor.getByRole('spinbutton', { name: '볼린저 기간' }).fill('10');
    await editor.getByRole('spinbutton', { name: '볼린저 기간' }).press('Enter');
    await page.keyboard.press('Escape');
    await expect.poll(async () => (await series(page)).flat().some(s => s.type === 'Line' && s.data.length > 100 && s.formatted === '123.46')).toBe(true);
    await page.screenshot({ path: info.outputPath(`${subject}-volume-bollinger.png`) });
    await page.reload();
    await expect.poll(async () => (await series(page)).flat().filter(s => s.type === 'Histogram').map(s => s.data.length)).toEqual([160, 160]);
    await page.getByTestId('live-indicators-button').click();
    await editor.getByRole('button', { name: '내 지표', exact: true }).click();
    await editor.getByRole('button', { name: '거래량 2 설정', exact: true }).click();
    await expect(editor.getByRole('radio', { name: '이전 거래량과 비교' })).toBeChecked();
    await editor.getByRole('button', { name: /거래량 [12] 삭제/, exact: false }).first().click();
    await editor.getByRole('button', { name: '거래량 삭제', exact: true }).first().click();
    await page.keyboard.press('Escape');
    await expect.poll(async () => (await series(page)).flat().filter(s => s.type === 'Histogram').length).toBe(0);
    expect(requests.filter(url => /\/(investor-net|past-daily-candles|series)\?/.test(url) && /NVDA|SP500/.test(url))).toEqual([]);
    expect(errors).toEqual([]);
  });
}
test('missing index volume remains absent, with a visible explanation', async ({ page }, info) => {
  await setup(page, true);
  await page.goto('/live?index=SP500');
  await page.getByTestId('live-indicators-button').click();
  await add(page, '거래량');
  await page.keyboard.press('Escape');
  await expect(page.getByText('거래량 미제공 구간은 표시하지 않습니다.')).toBeVisible();
  await expect.poll(async () => (await series(page)).flat().filter(s => s.type === 'Histogram').map(s => s.data.length)).toEqual([0, 0]);
  await page.screenshot({ path: info.outputPath('index-no-volume.png') });
});

for (const subject of ['stock', 'index']) {
  test(`${subject}: period profiles, daily MA on NY minutes and domestic-only catalog gates`, async ({ page }, info) => {
    await setup(page);
    await page.goto(subject === 'stock' ? '/live?market=US&exchange=NASDAQ&symbol=NVDA' : '/live?index=SP500');
    const frame = page.locator('.live-window-chart');
    const editor = page.getByTestId('indicator-panel-shell');
    for (const [label, count] of [['주', 23], ['월', 6], ['일', 160]] as const) {
      await frame.getByRole('group', { name: 'LiveTimeframe' }).getByRole('button', { name: label, exact: true }).click();
      await expect.poll(async () => (await series(page)).flat().some(s => s.type === 'Candlestick' && s.data.length === count)).toBe(true);
    }
    await frame.getByRole('button', { name: /분봉으로 전환/ }).click();
    await expect.poll(async () => (await series(page)).flat().filter(s => s.type === 'Candlestick').map(s => s.data.length)).toEqual([130]);
    await frame.getByTestId('live-indicators-button').click();
    await add(page, '일봉 이동평균선');
    await expect(editor.getByRole('button', { name: '외국인 순매수량', exact: true })).toHaveCount(0);
    await expect(editor.getByRole('button', { name: '기관 순매수량', exact: true })).toHaveCount(0);
    await expect(editor.getByRole('button', { name: '총잔량', exact: true })).toHaveCount(0);
    await expect(editor.getByRole('button', { name: '신규 거래원 등장', exact: true })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect.poll(async () => (await series(page)).flat().some(s => s.type === 'Line' && s.data.some(r => 'value' in r && Math.abs(r.value - 116.2) < 0.00001))).toBe(true);
    await page.screenshot({ path: info.outputPath(`${subject}-daily-ma-minute.png`) });
    await page.reload();
    await expect.poll(async () => (await series(page)).flat().some(s => s.type === 'Line' && s.data.some(r => 'value' in r && Math.abs(r.value - 116.2) < 0.00001))).toBe(true);
  });
}

test('a missing volume tail has no borrowed legend value and its tooltip says unavailable', async ({ page }, info) => {
  await setup(page, 'tail');
  await page.goto('/live?market=US&exchange=NASDAQ&symbol=NVDA');
  await expect.poll(async () => (await series(page)).flat().filter(s => s.type === 'Histogram').map(s => s.data.length)).toEqual([159]);
  const legend = page.getByTestId('pane-legend-rows-volume');
  await expect(legend).toContainText('거래량');
  await expect(legend).not.toContainText('1,158');
  await page.getByRole('button', { name: '차트 설정', exact: true }).click();
  await page.getByRole('switch', { name: '캔들 정보 툴팁', exact: true }).check();
  await page.keyboard.press('Escape');
  const point = await page.evaluate(id => {
    const chart = (window as Window & { __liveCharts?: Map<string, IChartApi> }).__liveCharts?.get(id);
    const candle = chart?.panes()[0].getSeries().find(s => s.seriesType() === 'Candlestick');
    const tail = candle?.data().at(-1);
    if (!chart || !candle || !tail || !('close' in tail)) return null;
    const x = chart.timeScale().timeToCoordinate(tail.time), y = candle.priceToCoordinate(tail.close);
    const bounds = chart.chartElement().getBoundingClientRect();
    return x === null || y === null ? null : { x: bounds.x + x, y: bounds.y + y };
  }, id);
  expect(point).not.toBeNull();
  await page.mouse.move(point!.x, point!.y);
  await expect(page.getByTestId('candle-tooltip')).toContainText('미제공');
  await expect(legend).not.toContainText('1,158');
  await page.screenshot({ path: info.outputPath('missing-tail-tooltip.png') });
});

test.afterEach(async ({ page }, info) => {
  if (info.status === info.expectedStatus) return;
  await info.attach('chart-state', { contentType: 'application/json', body: JSON.stringify(await page.evaluate(() => ({
    charts: [...((window as Window & { __liveCharts?: Map<string, IChartApi> }).__liveCharts ?? [])].map(([id, c]) => ({ id, panes: c.panes().map(p => p.getSeries().map(s => ({ type: s.seriesType(), count: s.data().length }))) })),
    roots: [...document.querySelectorAll('[data-testid="live-chart-root"]')].map(e => ({ rect: e.getBoundingClientRect().toJSON(), html: e.innerHTML.slice(0, 1000) })),
    workspace: sessionStorage.getItem('live.workspace.v1'),
  })), null, 2) });
});
