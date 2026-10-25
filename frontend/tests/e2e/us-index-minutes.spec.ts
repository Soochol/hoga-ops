import { readFileSync, writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import type { IChartApi, ISeriesApi } from 'lightweight-charts';
import type { LiveIndexCandlesResponse } from '../../src/api/liveIndices';
import type { IndexHeaderQuoteResponse } from '../../src/api/indexHeaderQuote';
import { installLiveMocks } from './helpers/liveMocks';

const evidence = JSON.parse(readFileSync(new URL('../../../docs/research/2026-10-19-us-index-minute-app-live-probe.json', import.meta.url), 'utf8')) as { responses: LiveIndexCandlesResponse[] };
const vixEvidence = JSON.parse(readFileSync(new URL('../../../docs/diagnostics/2026-10-25-vix/chart-replay.json', import.meta.url), 'utf8')) as { responses: LiveIndexCandlesResponse[]; header: IndexHeaderQuoteResponse };
evidence.responses.push(...vixEvidence.responses);
type ChartsWindow = Window & { __liveCharts?: Map<string, IChartApi> };
const windowId = 'us-minute-test';

async function measurements(page: Page) {
  return page.evaluate(id => {
    const chart = (window as ChartsWindow).__liveCharts?.get(id);
    const series = chart?.panes().flatMap(p => p.getSeries()).find(s => s.seriesType() === 'Candlestick') as ISeriesApi<'Candlestick'> | undefined;
    const rows = series?.data().filter(r => 'close' in r) ?? [];
    const last = rows.at(-1);
    return { axisPrice: series?.priceFormatter().format(1234567.8912), count: rows.length, last, range: chart?.timeScale().getVisibleLogicalRange(), width: chart?.timeScale().width(), latestX: last ? chart?.timeScale().timeToCoordinate(last.time) : null };
  }, windowId);
}

async function setup(page: Page, options: { stale?: () => boolean; crossMidnight?: boolean; liveClose?: () => number } = {}) {
  await installLiveMocks(page);
  await page.addInitScript(id => {
    if (!sessionStorage.getItem('live.workspace.v1')) sessionStorage.setItem('live.workspace.v1', JSON.stringify({ schema_version: 2,
      windows: [{ id, kind: 'chart', group: 1, rect: { x: 0, y: 0, w: 0.95, h: 0.95 }, chart: { timeframe: '1m' } }], zOrder: [id], groupSymbols: {} }));
  }, windowId);
  await page.route(/\/api\/live\/index-candles\?/, route => {
    const params = new URL(route.request().url()).searchParams;
    const found = evidence.responses.find(r => r.index_id === params.get('index_id') && r.timeframe === params.get('timeframe'));
    if (found) {
      const payload = structuredClone(found);
      if (options.crossMidnight) {
        // NY 10:30–12:11; KST 23:30–01:11 across midnight, one NY trading date.
        payload.candles = payload.candles.map((row, i) => ({ ...row, t_ms: Date.UTC(2026, 9, 16, 14, 30 + i) }));
        payload.minute_metadata!.available_from_ms = payload.candles[0].t_ms;
        payload.minute_metadata!.available_to_ms = payload.candles.at(-1)!.t_ms;
      }
      if (options.stale?.()) payload.minute_metadata!.refresh_status = 'stale';
      if (options.liveClose) {
        const close = options.liveClose();
        const last = payload.candles.at(-1)!;
        payload.candles[payload.candles.length - 1] = { ...last, close, high: Math.max(last.high, close), low: Math.min(last.low, close) };
        payload.minute_metadata!.refresh_interval_ms = 2000;
      }
      return route.fulfill({ json: payload });
    }
    // A calendar transition stays on the independent daily path.
    const close = options.liveClose?.() ?? 121.2345;
    return route.fulfill({ json: { index_id: params.get('index_id'), timeframe: params.get('timeframe'), from: params.get('from'), to: params.get('to'), candles: [{ trading_date: '20261016', t_ms: Date.UTC(2026, 9, 16), open: 120, high: Math.max(125, close), low: Math.min(119, close), close, volume: 0 }], data_warnings: [], daily_metadata: { refresh_status: 'normal', latest_bar_date: '20261016' },
      ...(options.liveClose ? { minute_metadata: { ...evidence.responses[0].minute_metadata, refresh_interval_ms: 2000 } } : {}) } });
  });
}

test('US index updates minute, D/W/M and header every two seconds without resetting the viewport', async ({ page }) => {
  const original = evidence.responses.find(r => r.index_id === 'SOX' && r.timeframe === '1m')!.candles.at(-1)!;
  let close = original.close;
  await page.clock.install({ time: new Date('2026-10-22T15:00:00Z') });
  await setup(page, { liveClose: () => close });
  await page.route(/\/api\/live\/index-header-quote\?/, route => route.fulfill({ json: {
    index_id: 'SOX', value: close, change: close - 100, change_rate: close - 100,
    previous_close: 100, trading_date: '20261022', observed_at_ms: Date.parse('2026-10-22T15:00:00Z'),
    checked_at_ms: Date.parse('2026-10-22T15:00:00Z'), market_timezone: 'America/New_York',
    session_status: 'open', refresh_status: 'normal', source: 'kis_minute', delay_unverified: true,
    refresh_interval_ms: 2000,
  } }));
  await page.goto('/live?index=SOX');
  await expect.poll(async () => (await measurements(page)).count).toBe(102);
  await page.clock.runFor(1_000);
  const before = await measurements(page);
  close += 10;
  await page.clock.runFor(2500);
  await expect.poll(async () => (await measurements(page)).last).toMatchObject({ close });
  const after = await measurements(page);
  expect(after.count).toBe(before.count);
  expect(after.range!.from).toBeCloseTo(before.range!.from, 1);
  expect(after.range!.to).toBeCloseTo(before.range!.to, 1);
  const price = page.getByTestId('titlebar-current-price');
  await expect(price).toHaveText(close.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  for (const label of ['일', '주', '월']) {
    await page.getByRole('group', { name: 'LiveTimeframe' }).getByRole('button', { name: label, exact: true }).click();
    await expect.poll(async () => (await measurements(page)).count).toBe(1);
    close += 10;
    await page.clock.runFor(2500);
    await expect.poll(async () => (await measurements(page)).last).toMatchObject({ close });
    await expect(price).toHaveText(close.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  }
  await expect(page.locator('.live-window-chart').getByRole('status')).toHaveCount(0);
});

for (const id of ['NASDAQ_COMPOSITE', 'SP500', 'SOX', 'VIX']) {
  test(`${id}: renders actual-provider minute fixture, period changes, restore and bounded polling`, async ({ page }, testInfo) => {
    let stale = false;
    await page.clock.install();
    await setup(page, { stale: () => stale });
    if (id === 'VIX') await page.route(/\/api\/live\/index-header-quote\?index_id=VIX(?:&|$)/,
      route => route.fulfill({ json: vixEvidence.header }));
    const requests: string[] = [], errors: string[] = [], wsMessages: string[] = [];
    page.on('request', request => requests.push(request.url()));
    page.on('pageerror', error => errors.push(error.message));
    page.on('websocket', ws => ws.on('framesent', event => wsMessages.push(String(event.payload))));
    await page.goto(id === 'VIX' ? '/live' : `/live?index=${id}`);
    if (id === 'VIX') {
      // Discover VIX through the real credential-free catalog route as users do.
      await page.keyboard.press('/');
      await page.getByRole('combobox').fill('VIX');
      await page.getByRole('option', { name: /VIX 지수/ }).click();
    }
    const frame = page.locator('.live-window-chart');
    await expect.poll(async () => (await measurements(page)).count).toBe(102);
    // Search selection leaves the pointer over a historical candle. Read the
    // latest legend only after leaving the plot and advancing its paint timers.
    await page.mouse.move(0, 0);
    await page.clock.runFor(1_000);
    await expect(frame.getByRole('status')).toHaveCount(0);
    const expected = evidence.responses.find(r => r.index_id === id && r.timeframe === '1m')!.candles.at(-1)!;
    await expect(frame.getByText(`${expected.close.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} pt`, { exact: false }).first()).toBeVisible();
    if (id === 'VIX') await expect(frame.getByTestId('titlebar-current-price')).toHaveText('19.45');
    await expect(frame.getByTestId('chart-reveal-cover')).toHaveCSS('opacity', '0');
    const initial = await measurements(page);
    expect(initial.axisPrice).toBe('1,234,567.89');
    expect(initial.last).toMatchObject({ time: expected.t_ms / 1000, close: expected.close });
    expect(initial.latestX).toBeGreaterThan(0);
    expect(initial.latestX!).toBeLessThan(initial.width!);
    writeFileSync(testInfo.outputPath('initial-viewport.json'), JSON.stringify(initial, null, 2));
    await testInfo.attach('initial-viewport.json', { path: testInfo.outputPath('initial-viewport.json'), contentType: 'application/json' });
    await frame.screenshot({ path: testInfo.outputPath(`${id}-1m.png`) });

    // Panning outside a latest-only snapshot must never launch historical requests.
    const beforePan = requests.filter(url => url.includes('/index-candles?')).length;
    await page.evaluate(id => (window as ChartsWindow).__liveCharts?.get(id)?.timeScale().setVisibleLogicalRange({ from: -300, to: -200 }), windowId);
    await page.clock.fastForward(1_000);
    expect(requests.filter(url => url.includes('/index-candles?'))).toHaveLength(beforePan);
    stale = true;
    await page.clock.fastForward(61_000);
    await expect(frame.getByRole('status')).toContainText('조회 실패 · 이전 데이터 유지');
    await expect.poll(async () => (await measurements(page)).count).toBe(102);
    stale = false;

    await frame.getByRole('button', { name: '분봉 선택 열기: 1분', exact: true }).click();
    const menu = page.getByRole('menu', { name: '분봉 목록' });
    await expect(menu.getByRole('menuitemradio')).toHaveCount(7);
    await expect(menu.getByRole('menuitemradio', { name: '120분', exact: true })).toHaveCount(0);
    await menu.getByRole('menuitemradio', { name: '5분', exact: true }).click();
    await expect(frame.getByRole('status')).toHaveCount(0);
    await expect.poll(async () => (await measurements(page)).count).toBe(evidence.responses.find(r => r.index_id === id && r.timeframe === '5m')!.candles.length);
    await page.reload();
    await expect(frame.getByRole('status')).toHaveCount(0);
    await expect(frame.getByRole('button', { name: '분봉 선택 열기: 5분', exact: true })).toBeVisible();
    for (const label of ['일', '주', '월']) {
      await frame.getByRole('group', { name: 'LiveTimeframe' }).getByRole('button', { name: label, exact: true }).click();
      await expect(frame.getByText(id === 'VIX' ? '19.45 pt' : '121.23 pt', { exact: false }).first()).toBeVisible();
      await expect(frame.getByRole('status')).toHaveCount(0);
    }
    expect(requests.filter(url => /\/(past-candles|past-daily-candles|screener-daily-candles|index-investor-net|quotes|series)\?/.test(url) && new RegExp(id).test(url))).toEqual([]);
    expect(wsMessages.filter(message => /NASDAQ_COMPOSITE|SP500|SOX|VIX/.test(message))).toEqual([]);
    expect(errors).toEqual([]);
  });
}

test('US minute candles cross KST midnight without losing the next-date candles', async ({ page }, testInfo) => {
  await setup(page, { crossMidnight: true });
  await page.goto('/live?index=NASDAQ_COMPOSITE');
  await expect.poll(async () => (await measurements(page)).count).toBe(102);
  expect((await measurements(page)).last).toMatchObject({ time: Date.UTC(2026, 9, 16, 16, 11) / 1000 });
  await expect(page.locator('.live-window-chart').getByRole('status')).toHaveCount(0);
  await expect(page.getByTestId('chart-reveal-cover')).toHaveCSS('opacity', '0');
  await page.locator('.live-window-chart').screenshot({ path: testInfo.outputPath('midnight-painted.png') });
});

test('SP500 60m explains incomplete contiguous data instead of fabricating candles', async ({ page }) => {
  await setup(page);
  await page.goto('/live?index=SP500');
  const frame = page.locator('.live-window-chart');
  await expect.poll(async () => (await measurements(page)).count).toBe(102);
  await frame.getByRole('button', { name: '분봉 선택 열기: 1분', exact: true }).click();
  await page.getByRole('menuitemradio', { name: '60분', exact: true }).click();
  await expect(frame.getByRole('status')).toContainText('연속 데이터 부족');
  await expect.poll(async () => (await measurements(page)).count).toBe(0);
});
