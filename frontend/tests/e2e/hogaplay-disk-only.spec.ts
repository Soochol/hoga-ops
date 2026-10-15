import { test, expect } from '@playwright/test';
import { installLiveMocks } from './helpers/liveMocks';
import { apiExact } from './helpers/apiRoutes';
import type { IChartApi } from 'lightweight-charts';

type ChartsWindow = Window & { __liveCharts: Map<string, IChartApi> };

test('HogaPlay mode displays local candles without requesting missing days from a vendor', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.clock.setFixedTime(new Date('2026-05-22T18:00:00+09:00'));
  await installLiveMocks(page);
  await page.routeWebSocket(/\/api\/ws/, () => {});
  let diskRequested = false;
  let servedMissingDates = false;
  const vendorRequests: string[] = [];
  await page.route(apiExact('live/past-candles'), async route => {
    if (diskRequested) vendorRequests.push(route.request().url());
    const p = new URL(route.request().url()).searchParams;
    await route.fulfill({ json: {
      code: '005930', from: p.get('from'), to: p.get('to'), candles: [],
      cached_dates: [], fresh_dates: [], data_warnings: [], adjust_factors: {},
    } });
  });
  await page.route(apiExact('range'), async route => {
    const p = new URL(route.request().url()).searchParams;
    if (p.get('mode') === 'candles') {
      diskRequested = true;
      expect(p.has('hogaplay_backfill')).toBe(false);
    }
    const response = await route.fetch();
    if (p.get('mode') === 'candles') {
      const body = await response.json();
      servedMissingDates ||= body.missing_dates.some((d: { date: string }) => d.date === '20260522');
    }
    await route.fulfill({ response });
  });
  await page.goto('/live?code=005930');
  await expect(page.getByRole('button', { name: 'hogaplay 저장 데이터로 보기', exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: 'hogaplay 저장 데이터로 보기', exact: true }).first().click();
  const chip = page.getByTestId('live-hogaplay-source-chip').first();
  await expect(chip).toContainText('05-21');
  await expect(chip).toHaveAttribute('title', /디스크에 있는 분봉만/);
  await expect.poll(() => servedMissingDates).toBe(true);
  await expect(page.getByTestId('chart-reveal-cover').first()).toHaveCSS('opacity', '0');
  expect(vendorRequests).toEqual([]);
});

test('disk scrollback crosses empty months and keeps empty trading minutes through zoom and timeframe changes', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.clock.setFixedTime(new Date('2026-06-25T18:00:00+09:00'));
  await installLiveMocks(page);
  await page.routeWebSocket(/\/api\/ws/, () => {});
  const open = (date: string) => Date.parse(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}T09:00:00+09:00`);
  const ymd = (t: number) => new Date(t).toISOString().slice(0, 10).replaceAll('-', '');
  const available = ['20260324', '20260521'];
  const holidays = ['20260501', '20260505', '20260525', '20260603'];
  const dates: string[] = [];
  for (let t = open('20260324'); t <= open('20260625'); t += 86400000) {
    if (![0, 6].includes(new Date(t).getUTCDay()) && !holidays.includes(ymd(t))) dates.push(ymd(t));
  }
  let diskOn = false;
  const vendorRequests: string[] = [];
  const diskRequests: { from: string; to: string }[] = [];
  await page.route(apiExact('live/past-candles'), async route => {
    if (diskOn) vendorRequests.push(route.request().url());
    const p = new URL(route.request().url()).searchParams;
    await route.fulfill({ json: { code: '005930', from: p.get('from'), to: p.get('to'), candles: [],
      cached_dates: [], fresh_dates: [], data_warnings: [], adjust_factors: {} } });
  });
  await page.route(apiExact('range'), async route => {
    const p = new URL(route.request().url()).searchParams;
    const from = p.get('from')!, to = p.get('to')!, bucket = Number(p.get('bucket_ms'));
    const candleMode = p.get('mode') === 'candles';
    if (candleMode) { diskOn = true; diskRequests.push({ from, to }); }
    const captured = available.filter(d => from <= d && d <= to);
    const candles = candleMode ? captured.flatMap(d => [0, bucket, 4 * bucket].map(offset => ({
      ts_ms: open(d) + offset, open: 70000, high: 70200, low: 69900, close: 70100 + offset / 60000, vol_a: 10, vol_b: 20,
    }))) : [];
    await route.fulfill({ json: { code: '005930', from_date: from, to_date: to, bucket_ms: bucket,
      earliest_captured_date: available[0],
      local_candle_history: candleMode ? { available_dates: available, trading_dates: dates.filter(d => from <= d && d <= to) } : null,
      segments: captured.map(date => ({ date, session_open_ms: open(date), session_close_ms: open(date) + 390 * 60000, source: 'hogaplay' })),
      candles, quote_ratio: { bucket_ms: bucket, points: [] }, fill_strength: { bucket_ms: bucket, points: [] },
      program_trade: { points: [] }, volume_profile_range: { bin_count: 0, price_min: 0, price_max: 0, bin_width: 0, bins: [] },
      volume_profile_by_day: [], missing_dates: [], ask_peaks: [], bid_peaks: [], broker_late_entries: [],
      trade_volume_pocs: [], depth_heatmap: [], volume_distributions: [],
    } });
  });
  await page.goto('/live?code=005930');
  await page.getByRole('button', { name: 'hogaplay 저장 데이터로 보기', exact: true }).first().click();
  const id = await page.evaluate(async () => {
    const path = '/src/state/workspace.ts';
    const { useWorkspaceStore: store } = await import(path);
    return store.getState().windows.find((w: { kind: string }) => w.kind === 'chart').id as string;
  });
  const inspect = () => page.evaluate(id => {
    const chart = (window as unknown as ChartsWindow).__liveCharts.get(id);
    const series = chart?.panes().flatMap(p => p.getSeries()).find(s => s.seriesType() === 'Candlestick');
    const rows = series?.data() ?? [];
    return { count: rows.length, bars: rows.filter(p => 'close' in p).length };
  }, id);
  // The recent seed has no candles; the global inventory must still find May.
  await expect.poll(async () => (await inspect()).bars).toBe(3);
  expect(diskRequests.some(r => r.from === '20260521')).toBe(true);
  await page.evaluate(async id => {
    const path = '/src/state/workspace.ts';
    const { useWorkspaceStore: store } = await import(path);
    store.getState().extendChartHistoricalRange(id, '20260324');
  }, id);
  await expect.poll(async () => (await inspect()).bars).toBe(6);
  expect((await inspect()).count).toBeGreaterThan(20000);
  await expect(page.getByTestId('chart-reveal-cover').first()).toHaveCSS('opacity', '0');
  // Empty June 2 has all 391 regular-session minute slots; weekend May 23
  // contributes none. Time-only rows have no manufactured prices or volume.
  const evidence = await page.evaluate(({ id, expectedBlankDay, expectedWeekend }) => {
    const chart = (window as unknown as ChartsWindow).__liveCharts.get(id)!;
    const pathRows = chart.panes().flatMap(p => p.getSeries()).find(s => s.seriesType() === 'Candlestick')!.data();
    // Session grids are contiguous, with a one-second inter-session boundary.
    const width = 390 * 60 + 1;
    const first = Number(pathRows[0].time);
    const day = (index: number) => pathRows.filter(p => Number(p.time) >= first + index * width && Number(p.time) < first + (index + 1) * width);
    const blank = day(expectedBlankDay);
    const blankIndex = pathRows.findIndex(p => p === blank[0]);
    chart.timeScale().setVisibleLogicalRange({ from: blankIndex, to: blankIndex + 300 });
    const range = chart.timeScale().getVisibleLogicalRange();
    const gridTimes = pathRows.map(p => Number(p.time));
    return { blank: blank.length, blankHasPrice: blank.some(p => 'close' in p), range,
      weekendExcluded: expectedWeekend < 0, gridTimes: gridTimes.slice(blankIndex, blankIndex + 3) };
  }, { id, expectedBlankDay: dates.indexOf('20260602'), expectedWeekend: dates.indexOf('20260523') });
  expect(evidence.blank).toBe(391);
  expect(evidence.blankHasPrice).toBe(false);
  expect(evidence.weekendExcluded).toBe(true);
  expect(evidence.gridTimes[1] - evidence.gridTimes[0]).toBe(60);
  const surface = page.getByTestId('live-chart-surface').first();
  await surface.hover();
  await page.mouse.wheel(0, -120);
  await expect.poll(async () => (await inspect()).bars).toBe(6);
  await page.evaluate(async id => {
    const path = '/src/state/workspace.ts';
    const { useWorkspaceStore: store } = await import(path);
    store.getState().setChartTimeframe(id, '3m');
    store.getState().extendChartHistoricalRange(id, '20260324');
  }, id);
  await expect.poll(async () => (await inspect()).bars).toBe(6);
  expect((await inspect()).count).toBeGreaterThan(6000);
  expect(vendorRequests).toEqual([]);
});
