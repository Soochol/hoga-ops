import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { expect, test, type Page } from '@playwright/test';
import type { IChartApi, ISeriesApi } from 'lightweight-charts';
import type { UsStockMinuteResponse } from '../../src/api/usDailyCandles';
import { installLiveMocks } from './helpers/liveMocks';

// Production-adapter reads, including strictly older native cursor chunks.
const evidence = JSON.parse(gunzipSync(readFileSync(new URL('../../../docs/research/2026-10-19-us-stock-minute-history-live.json.gz', import.meta.url))).toString('utf8')) as {
  responses: { exchange: string; symbol: string; timeframe: string; pages: UsStockMinuteResponse[] }[];
};
const id = 'us-stock-scrollback';
type Charts = Window & { __liveCharts?: Map<string, IChartApi> };
async function snapshot(page: Page, anchor = 200) {
  return page.evaluate(({ id, anchor }) => {
    const chart = (window as Charts).__liveCharts?.get(id);
    const series = chart?.panes().flatMap(p => p.getSeries()).find(s => s.seriesType() === 'Candlestick') as ISeriesApi<'Candlestick'> | undefined;
    const rows = series?.data().filter(r => 'close' in r) ?? [];
    const ts = chart?.timeScale(), range = ts?.getVisibleLogicalRange(), row = rows[anchor];
    return { count: rows.length, span: range ? range.to - range.from : null, range,
      spacing: ts?.options().barSpacing, x: row ? ts?.timeToCoordinate(row.time) : null, row };
  }, { id, anchor });
}
async function settle(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}
async function setup(page: Page, item: typeof evidence.responses[number], options: { fail?: () => boolean; gate?: Promise<void>; clock?: boolean; fullChain?: boolean; unconfigured?: () => boolean } = {}) {
  await installLiveMocks(page);
  await page.addInitScript(({ id, tf }) => sessionStorage.setItem('live.workspace.v1', JSON.stringify({ schema_version: 2,
    windows: [{ id, kind: 'chart', group: 1, rect: { x: 0, y: 0, w: .95, h: .95 }, chart: { timeframe: tf } }], zOrder: [id], groupSymbols: {} })), { id, tf: item.timeframe });
  const requests = { latest: 0, history: 0 };
  await page.route(/\/api\/live\/us-stock-minute-candles\?/, async route => {
    const p = new URL(route.request().url()).searchParams;
    expect(p.get('exchange')).toBe(item.exchange); expect(p.get('symbol')).toBe(item.symbol); expect(p.get('timeframe')).toBe(item.timeframe);
    if (p.has('cursor')) {
      requests.history++;
      const previous = item.pages.findIndex(page => page.minute_metadata.next_cursor === p.get('cursor'));
      expect(previous).toBeGreaterThanOrEqual(0);
      await options.gate;
      if (options.fail?.()) return route.fulfill({ status: 503, json: { detail: { message: 'simulated temporary failure' } } });
      const older = structuredClone(item.pages[previous + 1]);
      // Simulate exhaustion after this page; AAAA also exhausted in the live read.
      if (!options.fullChain || previous + 2 === item.pages.length) {
        older.minute_metadata.next_cursor = null; older.minute_metadata.more_available = false;
      }
      return route.fulfill({ json: older });
    }
    requests.latest++;
    const latest = structuredClone(item.pages[0]);
    if (requests.latest > 1) {
      const last = latest.candles.at(-1)!;
      latest.candles = [...latest.candles.slice(1), { ...last, t_ms: last.t_ms + Number(item.timeframe.slice(0, -1)) * 60_000 }];
    }
    if (options.unconfigured?.()) {
      latest.candles = []; latest.minute_metadata.refresh_status = 'unconfigured';
      latest.minute_metadata.next_cursor = null; latest.minute_metadata.more_available = false;
    }
    return route.fulfill({ json: latest });
  });
  await page.goto(`/live?market=US&exchange=${item.exchange}&symbol=${item.symbol}`);
  await expect.poll(async () => (await snapshot(page)).count).toBe(800);
  if (options.clock) await page.clock.runFor(500);
  await expect(page.getByTestId('chart-reveal-cover')).toHaveCSS('opacity', '0');
  if (options.clock) await page.clock.runFor(50); else await settle(page);
  return requests;
}
async function wheelIntoHistory(page: Page) {
  // Start at an already-loaded historical view. The wheel gesture crosses the
  // load threshold; there is no request from this setup position itself.
  await page.evaluate(id => (window as Charts).__liveCharts!.get(id)!.timeScale().setVisibleLogicalRange({ from: 60, to: 360 }), id);
  await settle(page);
  const pane = page.locator('.live-window-chart canvas').first();
  const box = await pane.boundingBox(); expect(box).toBeTruthy();
  await page.mouse.move(box!.x + box!.width * .5, box!.y + box!.height * .5);
  await page.keyboard.down('Shift'); await page.mouse.wheel(0, -300); await page.keyboard.up('Shift');
}
for (const item of evidence.responses) {
  test(`${item.exchange} ${item.symbol} ${item.timeframe}: wheel fetches native history and keeps commit-time zoom and pixels`, async ({ page }, info) => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const errors: string[] = [], urls: string[] = [], frames: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.text().includes('[virtualAxis]')) errors.push(m.text()); });
    page.on('request', r => urls.push(r.url()));
    page.on('websocket', ws => ws.on('framesent', e => frames.push(String(e.payload))));
    const requests = await setup(page, item, { gate });
    expect(requests.history).toBe(0);
    await wheelIntoHistory(page);
    await expect.poll(() => requests.history).toBe(1);
    await expect(page.locator('.live-window-chart').getByRole('status')).toContainText('이전 분봉 불러오는 중');
    // User changes zoom while HTTP is pending; the commit must preserve THIS view.
    await page.mouse.wheel(0, -120); await settle(page);
    const before = await snapshot(page);
    release();
    const added = item.pages[1].candles.length;
    await expect.poll(async () => (await snapshot(page)).count).toBe(800 + added);
    await settle(page);
    const after = await snapshot(page, added + 200);
    expect(after.row).toMatchObject({ open: before.row!.open, high: before.row!.high, low: before.row!.low, close: before.row!.close });
    expect(after.span!).toBeCloseTo(before.span!, 5);
    expect(after.spacing!).toBeCloseTo(before.spacing!, 5);
    expect(Math.abs(after.x! - before.x!)).toBeLessThan(1);
    await expect(page.locator('.live-window-chart').getByRole('status')).toContainText('공급자 제공 과거 구간 끝');
    writeFileSync(info.outputPath('viewport.json'), JSON.stringify({ before, after, source: { exchange: item.exchange, symbol: item.symbol, timeframe: item.timeframe } }, null, 2));
    await page.locator('.live-window-chart').screenshot({ path: info.outputPath('history.png') });
    expect(urls.filter(url => /\/(past-candles|past-daily-candles|quotes|series|stock-limits|investor-net)\?/.test(url) && url.includes(item.symbol))).toEqual([]);
    expect(frames.filter(message => message.includes(item.symbol))).toEqual([]);
    expect(errors).toEqual([]);
  });
}

test('history failure preserves displayed bars and retries the same cursor', async ({ page }) => {
  let fail = true;
  const item = evidence.responses[0];
  const requests = await setup(page, item, { fail: () => fail });
  await wheelIntoHistory(page);
  await expect(page.locator('.live-window-chart').getByRole('status')).toContainText('과거 조회 실패 · 기존 데이터 유지');
  expect((await snapshot(page)).count).toBe(800);
  expect(requests.history).toBe(1);
  fail = false;
  await page.getByRole('button', { name: '다시 시도', exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).count).toBe(1600);
  expect(requests.history).toBe(2);
  await expect(page.locator('.live-window-chart').getByRole('status')).not.toContainText('과거 조회 실패');
});


test('plain wheel zoom-out fetches older data when its left edge reaches loaded history', async ({ page }) => {
  const requests = await setup(page, evidence.responses[0]);
  await page.evaluate(id => (window as Charts).__liveCharts!.get(id)!.timeScale().setVisibleLogicalRange({ from: 60, to: 360 }), id);
  await settle(page);
  const box = await page.locator('.live-window-chart canvas').first().boundingBox();
  await page.mouse.move(box!.x + box!.width * .5, box!.y + box!.height * .5);
  await page.mouse.wheel(0, 120);
  await expect.poll(async () => (await snapshot(page)).count).toBe(1600);
  expect(requests.history).toBe(1);
});


test('latest polling preserves cursor history without re-fetching old pages', async ({ page }) => {
  await page.clock.install();
  const requests = await setup(page, evidence.responses[0], { clock: true });
  await page.evaluate(id => (window as Charts).__liveCharts!.get(id)!.timeScale().setVisibleLogicalRange({ from: 0, to: 300 }), id);
  await page.clock.runFor(300);
  await expect.poll(async () => { await page.clock.runFor(40); return (await snapshot(page)).count; }).toBe(1600);
  await page.clock.fastForward(61_000);
  await expect.poll(() => requests.latest).toBeGreaterThan(1);
  await expect.poll(async () => (await snapshot(page)).count).toBe(1601);
  expect(requests.history).toBe(1);
});

test('continued scrolling resumes the next native cursor instead of replaying recent pages', async ({ page }) => {
  const requests = await setup(page, evidence.responses[0], { fullChain: true });
  await wheelIntoHistory(page);
  await expect.poll(async () => (await snapshot(page)).count).toBe(1600);
  await wheelIntoHistory(page);
  await expect.poll(async () => (await snapshot(page)).count).toBe(2400);
  expect(requests.history).toBe(2);
  await expect(page.locator('.live-window-chart').getByRole('status')).toContainText('공급자 제공 과거 구간 끝');
});


test('a latest-quote outage does not masquerade as the provider history floor', async ({ page }) => {
  await page.clock.install();
  let unconfigured = false;
  await setup(page, evidence.responses[0], { clock: true, unconfigured: () => unconfigured });
  unconfigured = true;
  await page.clock.fastForward(61_000);
  const status = page.locator('.live-window-chart').getByRole('status');
  await expect(status).toContainText('조회 API 키 설정 필요');
  await expect(status).not.toContainText('공급자 제공 과거 구간 끝');
  expect((await snapshot(page)).count).toBe(800);
});
