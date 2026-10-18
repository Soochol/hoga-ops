import { readFileSync, writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import type { IChartApi, ISeriesApi } from 'lightweight-charts';
import type { LiveIndexCandlesResponse } from '../../src/api/liveIndices';
import { installLiveMocks } from './helpers/liveMocks';

const evidence = JSON.parse(readFileSync(new URL('../../../docs/research/2026-10-19-us-index-minute-app-live-probe.json', import.meta.url), 'utf8')) as { responses: LiveIndexCandlesResponse[] };
type ChartsWindow = Window & { __liveCharts?: Map<string, IChartApi> };
const windowId = 'us-minute-test';

async function measurements(page: Page) {
  return page.evaluate(id => {
    const chart = (window as ChartsWindow).__liveCharts?.get(id);
    const series = chart?.panes().flatMap(p => p.getSeries()).find(s => s.seriesType() === 'Candlestick') as ISeriesApi<'Candlestick'> | undefined;
    const rows = series?.data().filter(r => 'close' in r) ?? [];
    const last = rows.at(-1);
    return { count: rows.length, last, range: chart?.timeScale().getVisibleLogicalRange(), width: chart?.timeScale().width(), latestX: last ? chart?.timeScale().timeToCoordinate(last.time) : null };
  }, windowId);
}

async function setup(page: Page, options: { stale?: () => boolean; crossMidnight?: boolean } = {}) {
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
      return route.fulfill({ json: payload });
    }
    // A calendar transition stays on the independent daily path.
    return route.fulfill({ json: { index_id: params.get('index_id'), timeframe: params.get('timeframe'), from: params.get('from'), to: params.get('to'), candles: [{ trading_date: '20261016', t_ms: Date.UTC(2026, 9, 16), open: 120, high: 125, low: 119, close: 121.2345, volume: 0 }], data_warnings: [], daily_metadata: { refresh_status: 'normal', latest_bar_date: '20261016' } } });
  });
}

for (const id of ['NASDAQ_COMPOSITE', 'SP500', 'SOX']) {
  test(`${id}: renders actual-provider minute fixture, period changes, restore and bounded polling`, async ({ page }, testInfo) => {
    let stale = false;
    await page.clock.install();
    await setup(page, { stale: () => stale });
    const requests: string[] = [], errors: string[] = [], wsMessages: string[] = [];
    page.on('request', request => requests.push(request.url()));
    page.on('pageerror', error => errors.push(error.message));
    page.on('websocket', ws => ws.on('framesent', event => wsMessages.push(String(event.payload))));
    await page.goto(`/live?index=${id}`);
    const frame = page.locator('.live-window-chart');
    await expect(frame.getByRole('status')).toContainText('미국 1분봉');
    await expect(frame.getByRole('status')).toContainText('지연 여부 미확인');
    await expect(frame.getByRole('status')).toContainText('과거 날짜 조회 불가');
    await expect.poll(async () => (await measurements(page)).count).toBe(102);
    const expected = evidence.responses.find(r => r.index_id === id && r.timeframe === '1m')!.candles.at(-1)!;
    await expect(frame.getByText(`${expected.close.toLocaleString('en-US')} pt`, { exact: false }).first()).toBeVisible();
    // Fake time must advance rAF/reveal timers before testing the painted chart.
    await page.clock.runFor(1_000);
    await expect(frame.getByTestId('chart-reveal-cover')).toHaveCSS('opacity', '0');
    const initial = await measurements(page);
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
    await expect(frame.getByRole('status')).toContainText('미국 5분봉');
    await expect.poll(async () => (await measurements(page)).count).toBe(evidence.responses.find(r => r.index_id === id && r.timeframe === '5m')!.candles.length);
    await page.reload();
    await expect(frame.getByRole('status')).toContainText('미국 5분봉');
    await expect(frame.getByRole('button', { name: '분봉 선택 열기: 5분', exact: true })).toBeVisible();
    for (const [label, title] of [['일', '일봉'], ['주', '주봉'], ['월', '월봉']]) {
      await frame.getByRole('group', { name: 'LiveTimeframe' }).getByRole('button', { name: label, exact: true }).click();
      await expect(frame.getByRole('status')).toContainText(`미국 ${title}`);
      await expect(frame.getByText('121.2345 pt', { exact: false }).first()).toBeVisible();
    }
    expect(requests.filter(url => /\/(past-candles|past-daily-candles|screener-daily-candles|index-investor-net|quotes|series)\?/.test(url) && new RegExp(id).test(url))).toEqual([]);
    expect(wsMessages.filter(message => /NASDAQ_COMPOSITE|SP500|SOX/.test(message))).toEqual([]);
    expect(errors).toEqual([]);
  });
}

test('US minute candles cross KST midnight without losing the next-date candles', async ({ page }, testInfo) => {
  await setup(page, { crossMidnight: true });
  await page.goto('/live?index=NASDAQ_COMPOSITE');
  await expect.poll(async () => (await measurements(page)).count).toBe(102);
  expect((await measurements(page)).last).toMatchObject({ time: Date.UTC(2026, 9, 16, 16, 11) / 1000 });
  await expect(page.getByRole('status')).toContainText('차트 시간 KST · 거래일 뉴욕');
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
