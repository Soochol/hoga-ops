import { writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import type { IChartApi } from 'lightweight-charts';
import { installLiveMocks } from './helpers/liveMocks';
import { installLiveWs } from './helpers/liveWs';
import { apiExact } from './helpers/apiRoutes';

const ids = ['NASDAQ_COMPOSITE', 'SP500', 'SOX'];
const values = [26000, 7600, 10800];
type Charts = Window & { __liveCharts?: Map<string, IChartApi> };
const chartFrom = '20251107';
const chartCount = 250;
const maColor = '#06B6D4';
const at = Date.parse('2026-10-22T15:00:00Z');

async function dailyMaValues(page: Page, id: string) {
  return page.evaluate(({ id, color }) => (window as Charts).__liveCharts?.get(id)?.panes()
    .flatMap(pane => pane.getSeries()).find(series => {
      const options = series.options();
      return series.seriesType() === 'Line' && 'color' in options && options.color === color;
    })
    ?.data().flatMap(row => 'value' in row ? [row.value] : []) ?? [], { id, color: maColor });
}

async function state(page: Page, id: string) {
  return page.evaluate(id => {
    const series = (window as Charts).__liveCharts?.get(id)?.panes().flatMap(p => p.getSeries())
      .find(s => s.seriesType() === 'Candlestick');
    const rows = series?.data().filter(r => 'close' in r) ?? [];
    return { count: rows.length, first: rows[0], last: rows.at(-1) };
  }, id);
}

test('six US index charts retain history with tail transfers, full corrections and rollover', async ({ page }, info) => {
  await page.setViewportSize({ width: 1920, height: 1200 });
  await page.clock.install({ time: new Date(at) });
  await installLiveMocks(page);
  const ws = await installLiveWs(page);
  await page.addInitScript(ids => {
    const windows = ids.flatMap((id, i) => ['D', '1m'].map((tf, row) => ({ id: `${id}-${tf}`, kind: 'chart', group: i + 1,
      chart: { timeframe: tf }, rect: { x: i / 3, y: row / 2, w: .33, h: .49 } })));
    sessionStorage.setItem('live.workspace.v1', JSON.stringify({ schema_version: 2, windows, zOrder: windows.map(w => w.id),
      groupSymbols: Object.fromEntries(ids.map((id, i) => [i + 1, { kind: 'index', code: id, name: id }])) }));
  }, ids);
  const days: number[] = [];
  for (let day = Date.UTC(2026, 9, 22); days.length < 500; day -= 86_400_000) {
    if (![0, 6].includes(new Date(day).getUTCDay())) days.unshift(day);
  }
  let closeDelta = 0;
  let revision = 'a'.repeat(64);
  let correction = false;
  let rollover = false;
  let fail = false;
  const records: { id: string; tf: string; revision: string | null; from: string; count: number; bytes: number; fullBytes: number }[] = [];
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route(apiExact('live/indices'), r => r.fulfill({ json: { indices: ids.map(id => ({ kind: 'index', id, label: id,
    investor_scope: 'none', market: 'US', market_timezone: 'America/New_York', supported_timeframes: ['D', 'W', 'M', '1m'] })) } }));
  await page.route(apiExact('live/index-header-quote'), r => {
    const id = new URL(r.request().url()).searchParams.get('index_id')!;
    return r.fulfill({ json: { index_id: id, value: values[ids.indexOf(id)] + closeDelta, change: 1, change_rate: .01,
      previous_close: values[ids.indexOf(id)] - 1, trading_date: '20261022', observed_at_ms: at, checked_at_ms: at,
      market_timezone: 'America/New_York', session_status: 'open', refresh_status: 'normal', source: 'kis',
      delay_unverified: true, refresh_interval_ms: 2000 } });
  });
  await page.route(apiExact('live/index-candles'), r => {
    const params = new URL(r.request().url()).searchParams;
    const id = params.get('index_id')!, tf = params.get('timeframe')!;
    const base = values[ids.indexOf(id)];
    const row = (time: number, close: number) => ({ t_ms: time, trading_date: new Date(time).toISOString().slice(0, 10).replaceAll('-', ''),
      open: base, high: Math.max(base + 10, close), low: Math.min(base - 10, close), close, volume: 0 });
    const candles = tf === 'D' ? days.map((day, i) => row(day, base - (days.length - 1 - i)))
      : Array.from({ length: 102 }, (_, i) => row(at - (101 - i) * 60_000, base));
    if (tf === 'D' && correction) {
      const corrected = candles.findIndex(candle => candle.trading_date === chartFrom);
      candles[corrected] = row(days[corrected], base - 3);
    }
    if (tf === 'D' && rollover) candles.push(row(days.at(-1)! + 86_400_000, base));
    candles[candles.length - 1] = { ...candles.at(-1)!, close: base + closeDelta };
    const requestedCandles = candles.filter(candle => candle.trading_date >= params.get('from')! && candle.trading_date <= params.get('to')!);
    const full = { index_id: id, timeframe: tf, from: params.get('from'), to: params.get('to'), candles: requestedCandles, data_warnings: [],
      minute_metadata: { market_timezone: 'America/New_York', source: 'kis', history_scope: 'latest_snapshot', delay_status: 'unverified',
        session_scope: 'vendor_regular_including_postclose_corrections', available_from_ms: at - 101 * 60_000,
        available_to_ms: at, last_successful_check_at_ms: at + closeDelta * 1000, refresh_status: 'normal', messages: [],
        refresh_interval_ms: 2000 },
      ...(tf === 'D' ? { daily_history_revision: revision, daily_history_unchanged: false } : {}) };
    const compact = tf === 'D' && params.get('daily_history_revision') === revision;
    const payload = compact ? { ...full, candles: requestedCandles.slice(-1), daily_history_unchanged: true } : full;
    records.push({ id, tf, from: params.get('from')!, revision: params.get('daily_history_revision'), count: payload.candles.length,
      bytes: Buffer.byteLength(JSON.stringify(payload)), fullBytes: Buffer.byteLength(JSON.stringify(full)) });
    return r.fulfill({ status: fail ? 503 : 200, json: payload });
  });
  await page.goto('/live');
  await page.evaluate(async ({ ids, color }) => {
    const path = '/src/state/livePage.ts';
    const { useLivePageStore } = await import(path);
    for (const id of ids) useLivePageStore.getState().patchIndicatorsScoped({ windowKey: `live:${id}-1m:index` }, '1m', {
      dailyMovingAverages: [{ id: 'warmup-200', enabled: true, period: 200, source: 'close', color, colorMode: 'manual', lineWidth: 2 }],
    });
  }, { ids, color: maColor });
  for (const id of ids) {
    await expect.poll(async () => (await state(page, `${id}-D`)).count).toBe(chartCount);
    await expect.poll(async () => (await state(page, `${id}-1m`)).count).toBe(102);
  }
  for (const id of ids) {
    await expect.poll(async () => (await dailyMaValues(page, `${id}-1m`)).length).toBe(102);
    expect((await dailyMaValues(page, `${id}-1m`))[0]).toBeCloseTo(values[ids.indexOf(id)] - 99.5, 6);
    expect((await state(page, `${id}-D`)).first).toMatchObject({ close: values[ids.indexOf(id)] - 249 });
  }
  await expect.poll(() => ws.connectionCount()).toBe(1);
  const ranges = await page.evaluate(ids => ids.map(id => (window as Charts).__liveCharts?.get(`${id}-D`)?.timeScale().getVisibleLogicalRange()), ids);
  const before = records.length;
  closeDelta = 1;
  await page.clock.runFor(2300);
  for (const id of ids) {
    await expect.poll(async () => (await state(page, `${id}-D`)).last).toMatchObject({ close: values[ids.indexOf(id)] + 1 });
    expect((await state(page, `${id}-D`)).count).toBe(chartCount);
    await expect.poll(async () => (await state(page, `${id}-1m`)).last).toMatchObject({ close: values[ids.indexOf(id)] + 1 });
  }
  expect(await page.evaluate(ids => ids.map(id => (window as Charts).__liveCharts?.get(`${id}-D`)?.timeScale().getVisibleLogicalRange()), ids)).toEqual(ranges);
  for (const id of ids) expect((await dailyMaValues(page, `${id}-1m`))[0]).toBeCloseTo(values[ids.indexOf(id)] - 99.5 + 1 / 200, 6);
  const steady = records.slice(before);
  expect(steady.filter(r => r.tf === 'D')).toHaveLength(3);
  expect(steady.filter(r => r.tf === 'D').every(r => r.count === 1 && r.revision === 'a'.repeat(64))).toBe(true);
  expect(steady.filter(r => r.tf === '1m').every(r => r.count === 102 && r.revision === null)).toBe(true);
  const bytes = steady.reduce((n, r) => n + r.bytes, 0);
  const fullBytes = steady.reduce((n, r) => n + r.fullBytes, 0);
  expect(bytes).toBeLessThan(fullBytes * .4);

  correction = true;
  revision = 'b'.repeat(64);
  const correctedAt = records.length;
  await page.clock.runFor(2300);
  for (const id of ids) {
    await expect.poll(async () => (await state(page, `${id}-D`)).first).toMatchObject({ close: values[ids.indexOf(id)] - 3 });
  }
  expect(records.slice(correctedAt).filter(r => r.tf === 'D').every(r => r.count > chartCount)).toBe(true);
  rollover = true;
  revision = 'c'.repeat(64);
  await page.clock.runFor(2300);
  for (const id of ids) await expect.poll(async () => (await state(page, `${id}-D`)).count).toBe(chartCount + 1);

  closeDelta = 2;
  await page.clock.runFor(2300);
  for (const id of ids) {
    await expect.poll(async () => (await state(page, `${id}-D`)).last).toMatchObject({ close: values[ids.indexOf(id)] + 2 });
    expect((await state(page, `${id}-D`)).count).toBe(chartCount + 1);
  }
  fail = true;
  await page.clock.runFor(2300);
  for (const id of ids) expect((await state(page, `${id}-D`)).count).toBe(chartCount + 1);
  fail = false;
  closeDelta = 3;
  for (let i = 0; i < 6; i++) {
    ws.pushEvent({ type: 'diagnostic_heartbeat' });
    await page.clock.runFor(10_000);
  }
  await page.clock.runFor(1000);
  for (const id of ids) {
    await expect.poll(async () => (await state(page, `${id}-D`)).last).toMatchObject({ close: values[ids.indexOf(id)] + 3 });
    expect((await state(page, `${id}-D`)).count).toBe(chartCount + 1);
  }
  await page.screenshot({ path: info.outputPath('us-index-six-charts.png') });
  await page.evaluate(async () => {
    const path = '/src/state/workspace.ts';
    const { useWorkspaceStore } = await import(path);
    const current = useWorkspaceStore.getState();
    const windows = current.windows.filter((window: { id: string }) => window.id.endsWith('-D'));
    current.applyWorkspaceSnapshot({ windows, zOrder: windows.map((window: { id: string }) => window.id), maximizedId: null });
  });
  const afterOwner = records.length;
  closeDelta = 4;
  await page.clock.runFor(2300);
  expect(records.slice(afterOwner).filter(record => record.tf === 'D')).toHaveLength(3);
  expect(records.slice(afterOwner).filter(record => record.tf === '1m')).toHaveLength(0);
  for (const id of ids) {
    await expect.poll(async () => (await state(page, `${id}-D`)).last).toMatchObject({ close: values[ids.indexOf(id)] + 4 });
    expect((await state(page, `${id}-D`)).count).toBe(chartCount + 1);
    expect(records.slice(afterOwner).find(record => record.id === id && record.tf === 'D')?.from)
      .toBe(steady.find(record => record.id === id && record.tf === 'D')?.from);
  }
  expect(ws.connectionCount()).toBe(1);
  expect(errors).toEqual([]);
  const trafficPath = info.outputPath('traffic.json');
  writeFileSync(trafficPath, JSON.stringify({ steady, bytes, fullBytes, reduction: 1 - bytes / fullBytes }, null, 2));
  await info.attach('traffic.json', { path: trafficPath, contentType: 'application/json' });
  await page.screenshot({ path: info.outputPath('us-index-source-owner-removed.png') });
});
