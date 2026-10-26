import { test, expect, type Page } from '@playwright/test';
import type { IChartApi, Time } from 'lightweight-charts';
import type { StudyViewReference } from '../../src/api/studyViews';
import type { WorkspaceWindow } from '../../src/state/workspace';
import { installLiveMocks } from './helpers/liveMocks';
import { apiExact } from './helpers/apiRoutes';

const day = 86400000;
const savedMs = Date.UTC(2021, 3, 22);
const savedClose = 1000 + savedMs / day;
const end = Date.UTC(2026, 9, 26);
const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10).replaceAll('-', '');
const save: StudyViewReference = { id: 'daily-20210422', schema_version: 2, group_id: 'daily', code: '068290', label: '삼성출판사',
  name: '삼성출판사 · 21.04.22', timeframe: 'D', memo: '', tags: [], created_at_ms: 1, updated_at_ms: 1,
  range: { from_date: '20210422', to_date: '20210422', from_ms: savedMs, to_ms: savedMs },
  viewport: { right_edge_ms: savedMs, left_edge_ms: Date.UTC(2020, 6, 10), bar_span: 191.47, at_live_edge: false } };
type ChartWindow = Window & { __liveCharts: Map<string, IChartApi> };
async function snap(page: Page) {
  return page.evaluate((savedClose) => {
    const chart = (window as unknown as ChartWindow).__liveCharts?.get('saved-daily');
    const series = chart?.panes()[0]?.getSeries().find(s => s.seriesType() === 'Candlestick');
    const data = series?.data() as readonly { time: Time; close: number }[] | undefined;
    if (!chart || !data?.length) return null;
    const ts = chart.timeScale(), range = ts.getVisibleLogicalRange();
    if (!range) return null;
    const anchor = data.find(r => r.close === savedClose);
    const x = anchor ? ts.timeToCoordinate(anchor.time) : null;
    const chartLeft = chart.chartElement().getBoundingClientRect().left;
    const panelLeft = document.querySelector('aside[aria-label="저장뷰"]')?.getBoundingClientRect().left ?? Infinity;
    return { count: data.length, range, span: range.to - range.from,
      visibleCount: data.filter(r => { const x = ts.timeToCoordinate(r.time); return x != null && x >= 0 && x <= ts.width(); }).length,
      firstClose: data[0].close, lastClose: data.at(-1)?.close,
      anchorLoaded: !!anchor, anchorX: x, width: ts.width(),
      anchorVisible: x != null && x >= 0 && x <= ts.width() && chartLeft + x < panelLeft };
  }, savedClose);
}
async function setup(page: Page, delayed = false, savedView = save) {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.clock.setFixedTime(new Date('2026-10-26T18:00:00+09:00'));
  await installLiveMocks(page);
  await page.routeWebSocket(/\/api\/ws/, () => {});
  const calls: { from: string; to: string }[] = [];
  let release = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  const daily = async (route: import('@playwright/test').Route) => {
    const p = new URL(route.request().url()).searchParams;
    const from = p.get('from')!, to = p.get('to')!;
    calls.push({ from, to });
    if (delayed && from <= '20210422') await gate;
    const candles = [];
    for (let ms = Date.UTC(2019, 0, 1); ms <= end; ms += day) {
      if (ymd(ms) < from || ymd(ms) > to || [0, 6].includes(new Date(ms).getUTCDay())) continue;
      const close = 1000 + ms / day;
      candles.push({ t_ms: ms, open: close - 1, high: close + 2, low: close - 2, close, volume: 100 });
    }
    await route.fulfill({ json: { code: save.code, from, to, candles, cached_batches: [], fresh_batches: [], data_warnings: [], adjust_factors: [] } });
  };
  await page.route(apiExact('live/past-daily-candles'), daily);
  await page.route(apiExact('live/screener-daily-candles'), daily);
  await page.route(apiExact('study-views/saves'), r => r.fulfill({ json: { schema_version: 2, groups: [{ id: 'daily', name: '과거 일봉' }], saves: [savedView] } }));
  await page.goto('/live?code=068290');
  await page.evaluate(async () => {
    const path = '/src/state/workspace.ts';
    const { useWorkspaceStore: store } = await import(path);
    const win: WorkspaceWindow = { id: 'saved-daily', kind: 'chart', group: 1, chart: { timeframe: 'D' }, rect: { x: 0, y: 0, w: 1, h: 1 } };
    store.setState({ windows: [win], zOrder: [win.id], chartRuntime: {}, maximizedId: null,
      groupSymbols: { 1: { code: '068290', name: '삼성출판사', kind: 'stock' } } });
  });
  await expect.poll(async () => (await snap(page))?.count ?? 0).toBeGreaterThan(100);
  await page.getByRole('button', { name: '저장뷰 패널 토글' }).click();
  const row = page.getByRole('button', { name: '삼성출판사 · 21.04.22 저장뷰 열기', exact: true });
  return { calls, row, release };
}

test('an old saved daily date is fetched and seated after a delayed response', async ({ page }, testInfo) => {
  const { calls, row, release } = await setup(page, true);
  try {
    expect((await snap(page))?.anchorLoaded).toBe(false);
    await row.click();
    await expect(row).toHaveAttribute('aria-current', 'true');
    await expect.poll(() => calls.some(c => c.from <= '20210422')).toBe(true);
    expect((await snap(page))?.anchorLoaded).toBe(false);
  } finally { release(); }
  await expect.poll(async () => (await snap(page))?.anchorVisible).toBe(true);
  await expect.poll(async () => (await snap(page))?.span).toBeCloseTo(save.viewport.bar_span, 0);
  expect((await snap(page))?.visibleCount).toBeGreaterThan(150);
  const after = await snap(page);
  await testInfo.attach('saved-daily-placement', { body: JSON.stringify({ after, calls }, null, 2), contentType: 'application/json' });
  await page.screenshot({ path: testInfo.outputPath('saved-daily-date.png') });
});

test('reopening the same saved view returns to its date after panning away', async ({ page }, testInfo) => {
  const { row } = await setup(page);
  await row.click();
  await expect.poll(async () => (await snap(page))?.anchorVisible).toBe(true);
  await expect.poll(async () => (await snap(page))?.span).toBeCloseTo(save.viewport.bar_span, 0);
  await page.evaluate(() => {
    const chart = (window as unknown as ChartWindow).__liveCharts.get('saved-daily')!;
    const s = chart.panes()[0].getSeries().find(s => s.seriesType() === 'Candlestick')!;
    chart.timeScale().setVisibleLogicalRange({ from: s.data().length - 60, to: s.data().length - 1 });
  });
  await expect.poll(async () => (await snap(page))?.anchorVisible).toBe(false);
  // Closing/reopening the panel refreshes its list; that must not replay the range.
  await page.getByRole('button', { name: '저장뷰 패널 토글' }).click();
  await page.getByRole('button', { name: '저장뷰 패널 토글' }).click();
  await expect(row).toBeVisible();
  expect((await snap(page))?.anchorVisible).toBe(false);
  await row.click();
  await expect.poll(async () => (await snap(page))?.anchorVisible).toBe(true);
  await expect.poll(async () => (await snap(page))?.span).toBeCloseTo(save.viewport.bar_span, 0);
  await page.screenshot({ path: testInfo.outputPath('reopened-saved-daily-date.png') });
});

test('changing calendar timeframe uses context and returning to daily restores the saved zoom', async ({ page }) => {
  const { row } = await setup(page);
  await row.click();
  await expect.poll(async () => (await snap(page))?.span).toBeCloseTo(save.viewport.bar_span, 0);
  for (const timeframe of ['W', 'M', 'D'] as const) {
    await page.evaluate(async (tf) => {
      const path = '/src/state/workspace.ts';
      const { useWorkspaceStore } = await import(path);
      useWorkspaceStore.getState().setChartTimeframe('saved-daily', tf);
    }, timeframe);
    if (timeframe === 'D') {
      await expect.poll(async () => (await snap(page))?.span).toBeCloseTo(save.viewport.bar_span, 0);
      await expect.poll(async () => (await snap(page))?.anchorVisible).toBe(true);
    } else {
      await expect.poll(async () => (await snap(page))?.span).toBeCloseTo(2, 0);
    }
  }
});

test('a wide saved daily zoom fetches its earlier left edge before restoring', async ({ page }) => {
  const savedView = { ...save, viewport: { ...save.viewport, bar_span: 400, left_edge_ms: Date.UTC(2019, 6, 1) } };
  const { row, calls } = await setup(page, false, savedView);
  await row.click();
  await expect.poll(async () => (await snap(page))?.span).toBeCloseTo(400, 0);
  expect(calls.some(c => c.from <= '20190701')).toBe(true);
  await expect.poll(async () => (await snap(page))?.anchorVisible).toBe(true);
});

for (const [timeframe, span] of [['W', 40], ['M', 12]] as const) {
  test(`a saved ${timeframe} view restores its own zoom`, async ({ page }) => {
    const savedView = { ...save, timeframe, viewport: { ...save.viewport, bar_span: span } };
    const { row } = await setup(page, false, savedView);
    // Opening a calendar save keeps the chart's current timeframe. Match it
    // explicitly so this exercises same-timeframe restoration, not context.
    await page.getByRole('button', { name: timeframe === 'W' ? '주' : '월', exact: true }).click();
    await row.click();
    await expect.poll(async () => (await snap(page))?.span).toBeCloseTo(span, 0);
    expect((await snap(page))?.visibleCount).toBeGreaterThan(span - 2);
  });
}
