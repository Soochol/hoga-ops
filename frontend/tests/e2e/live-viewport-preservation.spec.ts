import { test, expect, type Page } from '@playwright/test';
import type { IChartApi, Time } from 'lightweight-charts';
import type { WorkspaceWindow } from '../../src/state/workspace';
import { installLiveMocks } from './helpers/liveMocks';
import { apiExact } from './helpers/apiRoutes';

type ChartsWindow = Window & { __liveCharts: Map<string, IChartApi> };
const dayMs = 86400000;
const today = '20261001';
const end = Date.UTC(2026, 9, 1);
const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10).replaceAll('-', '');
const days = Array.from({ length: 30 }, (_, i) => end - (29 - i) * dayMs)
  .filter(ms => ![0, 6].includes(new Date(ms).getUTCDay()));

function candles(from: string, to: string, bucketMs: number) {
  return days.filter(ms => ymd(ms) >= from && ymd(ms) <= to).flatMap(ms =>
    Array.from({ length: Math.ceil(390 * 60000 / bucketMs) }, (_, i) => {
      const t_ms = ms + i * bucketMs; // 09:00 KST
      const close = 35000 + (t_ms - days[0]) / 60000;
      return { t_ms, open: close - 1, high: close + 2, low: close - 2, close, volume: 100 };
    }));
}

async function snapshot(page: Page, id?: string, anchorClose?: number) {
  return page.evaluate(({ id, anchorClose }) => {
    const charts = (window as unknown as ChartsWindow).__liveCharts;
    const chart = id ? charts?.get(id) : charts?.values().next().value;
    const series = chart?.panes()[0]?.getSeries().find(s => s.seriesType() === 'Candlestick');
    if (!chart || !series || !series.data().length) return null;
    const rows = series.data() as readonly { time: Time; close: number }[];
    const ts = chart.timeScale();
    const range = ts.getVisibleLogicalRange();
    if (!range) return null;
    const last = rows.at(-1)!;
    const anchor = anchorClose === undefined ? last : rows.find(p => p.close === anchorClose)!;
    return {
      visibleCount: rows.filter(row => {
        const index = ts.timeToIndex(row.time)!;
        return index >= range.from && index <= range.to;
      }).length,
      count: rows.length, lastClose: last.close, x: ts.timeToCoordinate(anchor.time),
      latestX: ts.timeToCoordinate(last.time), width: ts.width(),
      span: range.to - range.from, spacing: ts.options().barSpacing, range,
      rightClose: (series.dataByIndex(Math.floor(range.to), -1) as { close?: number } | null)?.close,
    };
  }, { id, anchorClose });
}

async function setup(page: Page) {
  await page.setViewportSize({ width: 1800, height: 1000 });
  await page.clock.setFixedTime(new Date('2026-10-01T17:00:00+09:00'));
  await installLiveMocks(page);
  await page.routeWebSocket(/\/api\/ws/, () => {});
  // The shared fixture is dated May; use session metadata matching this
  // scenario's clock so the daily axis has ordered, non-overlapping sessions.
  await page.route(apiExact('live/series'), route => route.fulfill({ json: {
    code: new URL(route.request().url()).searchParams.get('code'), date: today,
    session_open_ms: end, session_close_ms: end + 390 * 60000, is_open: false,
    snapshots: [], trades: [], brokers: [],
  } }));
}

async function settleFrame(page: Page) {
  // Pointer events request a range; lwc paints it on the next frame. Compare
  // committed pixel positions on both sides of backfill, not a pending draw.
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

for (const timeframe of ['1m', '15m'] as const) {
  test(`${timeframe}: watchlist today seed stays at latest through history loading`, async ({ page }) => {
    await setup(page);
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.route(apiExact('watchlist'), route => route.fulfill({ json: {
      folders: [], next_run_at_ms: 0,
      entries: ['098460', '005930'].map((code, order) => ({ code, name: code === '005930' ? '삼성전자' : '고영',
        folder_id: null, order, registered_at_kst_date: today, last_success_date: today })),
    } }));
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let historyRequests = 0;
    await page.route(apiExact('live/past-candles'), async route => {
      const p = new URL(route.request().url()).searchParams;
      const code = p.get('code')!;
      const from = p.get('from')!;
      const to = p.get('to')!;
      const bucket_ms = Number(p.get('bucket_ms') ?? 60000);
      if (code === '005930' && from !== to) { historyRequests++; await gate; }
      await route.fulfill({ json: { code, from, to, bucket_ms, candles: candles(from, to, bucket_ms),
        cached_dates: [], fresh_dates: [], data_warnings: [] } });
    });
    await page.goto('/live?code=098460');
    await page.evaluate(async timeframe => {
      const path = '/src/state/workspace.ts';
      const { useWorkspaceStore: store } = await import(path);
      const win = store.getState().windows.find((w: { kind: string }) => w.kind === 'chart');
      store.getState().setChartTimeframe(win.id, timeframe);
    }, timeframe);
    await expect.poll(() => snapshot(page)).not.toBeNull();
    await page.getByRole('button', { name: '관심종목 패널 토글' }).click();
    await page.getByTestId('watchlist-row-005930').click();
    // KRX's closing-auction minutes collapse to one candle.
    const seedCount = timeframe === '1m' ? 381 : 26;
    await expect.poll(async () => (await snapshot(page))?.count).toBe(seedCount);
    await expect(page.getByTestId('chart-reveal-cover').first()).toHaveCSS('opacity', '0');
    const seed = (await snapshot(page))!;
    expect(seed.latestX).toBeGreaterThan(0);
    expect(seed.latestX).toBeLessThan(seed.width);
    await expect.poll(() => historyRequests).toBeGreaterThan(0);
    release();
    await expect.poll(async () => (await snapshot(page))?.count).toBeGreaterThan(seedCount);
    await expect.poll(async () => {
      const after = await snapshot(page);
      return after && Math.abs(after.latestX! - seed.latestX!) < 1 && after.rightClose === seed.lastClose;
    }).toBe(true);
    // Check another frame/commit after all progressive chunks, not just the
    // first passing draw. No manual viewport repositioning in this scenario.
    await expect(page.locator('[data-drawing-overlay]').first()).toHaveAttribute('data-day-extremes-ready', 'true');
    await settleFrame(page);
    const after = (await snapshot(page))!;
    expect(after.lastClose).toBe(seed.lastClose);
    expect(after.span).toBeCloseTo(seed.span, 5);
    expect(after.spacing).toBeCloseTo(seed.spacing, 5);
    expect(Math.abs(after.latestX! - seed.latestX!)).toBeLessThan(1);
    expect(errors).toEqual([]);
  });
}

test('refresh, minute jump and held drag keep the target date and backfill anchor', async ({ page }) => {
  await setup(page);
  let held = false;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const queries: { from: string; to: string }[] = [];
  await page.route(apiExact('live/past-candles'), async route => {
    const p = new URL(route.request().url()).searchParams;
    const from = p.get('from')!;
    const to = p.get('to')!;
    const bucket_ms = Number(p.get('bucket_ms') ?? 60000);
    queries.push({ from, to });
    if (held) await gate;
    await route.fulfill({ json: { code: '098460', from, to, bucket_ms,
      candles: candles(from, to, bucket_ms), cached_dates: [], fresh_dates: [], data_warnings: [] } });
  });
  await page.route(apiExact('live/past-daily-candles'), route => route.fulfill({ json: {
    code: '098460', from: ymd(days[0]), to: today,
    candles: days.map(ms => ({ t_ms: ms, open: 35000, high: 35100, low: 34900, close: 35050, volume: 100 })),
    cached_batches: [], fresh_batches: [], data_warnings: [],
  } }));
  await page.goto('/live?code=098460');
  await expect.poll(() => snapshot(page)).not.toBeNull();
  await page.reload();
  await expect.poll(() => snapshot(page)).not.toBeNull();
  // Reset the workspace through its public action, then arrange two visible
  // windows in one group. The user's storage and development browser are untouched.
  const ids = await page.evaluate(async () => {
    const path = '/src/state/workspace.ts';
    const { useWorkspaceStore: store } = await import(path);
    store.getState().applyWorkspaceSnapshot({ windows: [] });
    store.getState().addWindow('chart');
    const wins = store.getState().windows.filter((w: { kind: string }) => w.kind === 'chart').slice(0, 2);
    store.setState({ windows: wins.map((w: any, i: number) => ({ ...w, group: 1,
      rect: { x: i * .5, y: 0, w: .5, h: 1 }, chart: { ...w.chart, timeframe: i ? 'D' : '1m' } })),
      zOrder: wins.map((w: { id: string }) => w.id), maximizedId: null });
    for (const w of wins) store.getState().setWindowSymbol(w.id, { code: '098460', name: '고영', kind: 'stock' });
    return { minute: wins[0].id, daily: wins[1].id };
  });
  await expect.poll(() => snapshot(page, ids.daily)).not.toBeNull();
  // Set the daily source date, never reposition the minute destination.
  await page.evaluate(id => {
    const chart = (window as unknown as ChartsWindow).__liveCharts.get(id)!;
    const rows = chart.panes()[0].getSeries().find(s => s.seriesType() === 'Candlestick')!.data();
    const ts = chart.timeScale();
    const idx = ts.timeToIndex(rows.at(-3)!.time)!;
    ts.setVisibleLogicalRange({ from: idx - 5, to: idx });
  }, ids.daily);
  const jump = page.getByTestId('live-jump-to-minute-button');
  await expect(jump).toHaveAttribute('title', '분봉으로 — 09-29');
  await jump.click();
  const chip = page.getByTestId('live-minute-jump-chip');
  await expect(chip).toHaveText(/점프 09-29/);
  const target = candles('20260929', '20260929', 60000).at(-1)!.close;
  await expect.poll(async () => (await snapshot(page, ids.minute))?.lastClose).toBe(target);
  await expect.poll(async () => {
    const state = await snapshot(page, ids.minute);
    return state && state.latestX! > 0 && state.latestX! < state.width;
  }).toBe(true);
  await settleFrame(page);
  const box = await page.evaluate(id => {
    const c = (window as unknown as ChartsWindow).__liveCharts.get(id)!;
    const rect = c.panes()[0].getHTMLElement()!.getBoundingClientRect();
    return { x: rect.left, y: rect.top, width: c.timeScale().width(), height: rect.height };
  }, ids.minute);
  held = true;
  const start = (await snapshot(page, ids.minute))!;
  await page.mouse.move(box.x + box.width * .4, box.y + box.height * .6);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * .6, box.y + box.height * .6, { steps: 8 });
  await expect.poll(async () => (await snapshot(page, ids.minute))?.range.to)
    .toBeCloseTo(start.range.to - box.width * .2 / start.spacing, 2);
  // Request more history while held and keep moving before its response.
  const beforeQueries = queries.length;
  await page.evaluate(async id => {
    const path = '/src/state/workspace.ts';
    const { useWorkspaceStore: store } = await import(path);
    store.getState().extendChartHistoricalRange(id, '20260910');
  }, ids.minute);
  await expect.poll(() => queries.length).toBeGreaterThan(beforeQueries);
  await page.mouse.move(box.x + box.width * .7, box.y + box.height * .6, { steps: 5 });
  await settleFrame(page);
  const reference = await page.evaluate(id => {
    const c = (window as unknown as ChartsWindow).__liveCharts.get(id)!;
    const ts = c.timeScale();
    const r = ts.getVisibleLogicalRange()!;
    const anchor = c.panes()[0].getSeries().find(s => s.seriesType() === 'Candlestick')!
      .dataByIndex(Math.round((r.from + r.to) / 2)) as { close: number };
    return anchor.close;
  }, ids.minute);
  const before = (await snapshot(page, ids.minute, reference))!;
  release();
  await expect.poll(async () => (await snapshot(page, ids.minute))?.count).toBeGreaterThan(before.count);
  await expect.poll(async () => Math.abs((await snapshot(page, ids.minute, reference))!.x! - before.x!)).toBeLessThan(1);
  const rebased = (await snapshot(page, ids.minute, reference))!;
  await page.mouse.move(box.x + box.width * .75, box.y + box.height * .6, { steps: 5 });
  await expect.poll(async () => (await snapshot(page, ids.minute))?.range.to)
    .toBeCloseTo(rebased.range.to - box.width * .05 / rebased.spacing, 2);
  await page.mouse.up();
  // Walkback chunks can end earlier than the target; none may move the
  // destination's data bound forward beyond the originally clicked date.
  expect(queries.slice(beforeQueries).every(q => q.to <= '20260929')).toBe(true);
  expect((await snapshot(page, ids.minute))!.lastClose).toBe(target);
  await expect(chip).toHaveText(/점프 09-29/);
  await page.getByRole('button', { name: '기간 점프 해제' }).click();
  await expect(chip).toHaveCount(0);
  const currentLast = candles(today, today, 60000).at(-1)!.close;
  await expect.poll(async () => (await snapshot(page, ids.minute))?.lastClose).toBe(currentLast);
  await expect.poll(async () => {
    const state = await snapshot(page, ids.minute);
    return state && state.latestX! > 0 && state.latestX! < state.width && state.rightClose === currentLast;
  }).toBe(true);
});

// Partial responses must reserve the initial zoom without resetting later user input.
for (const gesture of ['none', 'pan', 'zoom'] as const) {
  test(`3m: partial history recovery preserves ${gesture} viewport`, async ({ page }) => {
    await setup(page);
    let partial = true;
    const queries: { from: string; to: string }[] = [];
    await page.route(apiExact('live/past-candles'), async route => {
      const p = new URL(route.request().url()).searchParams;
      const from = p.get('from')!;
      const to = p.get('to')!;
      const bucket_ms = Number(p.get('bucket_ms') ?? 60000);
      queries.push({ from, to });
      if (to === '20260929' && partial) {
        await route.fulfill({ json: {
          code: '098460', from, to, bucket_ms,
          candles: candles(to, to, bucket_ms).slice(-4), cached_dates: [], fresh_dates: [],
          data_warnings: [{ date: from, reason: 'rate_limit_aborted',
            msg: 'rate limit cooldown active', kind: 'rate_limit', is_failure: true }],
        } });
        return;
      }
      await route.fulfill({ json: { code: '098460', from, to, bucket_ms,
        candles: candles(from, to, bucket_ms), cached_dates: [], fresh_dates: [], data_warnings: [] } });
    });
    await page.route(apiExact('live/past-daily-candles'), route => route.fulfill({ json: {
      code: '098460', from: ymd(days[0]), to: today,
      candles: days.map(ms => ({ t_ms: ms, open: 35000, high: 35100, low: 34900, close: 35050, volume: 100 })),
      cached_batches: [], fresh_batches: [], data_warnings: [],
    } }));
    await page.goto('/live?code=098460');
    await expect.poll(() => snapshot(page)).not.toBeNull();
    // Reset the workspace through its public action, then arrange two visible
    // windows in one group. The user's storage and development browser are untouched.
    const ids = await page.evaluate(async () => {
      const path = '/src/state/workspace.ts';
      const { useWorkspaceStore: store } = await import(path);
      store.getState().applyWorkspaceSnapshot({ windows: [] });
      store.getState().addWindow('chart');
      const wins = store.getState().windows.filter((w: { kind: string }) => w.kind === 'chart').slice(0, 2);
      store.setState({ windows: wins.map((w: WorkspaceWindow, i: number) => ({ ...w, group: 1,
        rect: { x: i * .5, y: 0, w: .5, h: 1 }, chart: { ...w.chart, timeframe: i ? 'D' : '3m' } })),
        zOrder: wins.map((w: { id: string }) => w.id), maximizedId: null });
      for (const w of wins) store.getState().setWindowSymbol(w.id, { code: '098460', name: '고영', kind: 'stock' });
      return { minute: wins[0].id, daily: wins[1].id };
    });
    await expect.poll(() => snapshot(page, ids.daily)).not.toBeNull();
    // Set the daily source date, never reposition the minute destination.
    await page.evaluate(id => {
      const chart = (window as unknown as ChartsWindow).__liveCharts.get(id)!;
      const rows = chart.panes()[0].getSeries().find(s => s.seriesType() === 'Candlestick')!.data();
      const ts = chart.timeScale();
      const idx = ts.timeToIndex(rows.at(-3)!.time)!;
      ts.setVisibleLogicalRange({ from: idx - 5, to: idx });
    }, ids.daily);
    const jump = page.getByTestId('live-jump-to-minute-button');
    await expect(jump).toHaveAttribute('title', '분봉으로 — 09-29');
    await jump.click();
    const chip = page.getByTestId('live-minute-jump-chip');
    await expect(chip).toHaveText(/점프 09-29/);
    await expect.poll(async () => (await snapshot(page, ids.minute))?.count).toBe(2);
    await expect(page.getByTestId('chart-reveal-cover').first()).toHaveCSS('opacity', '0');
    await settleFrame(page);
    const seed = (await snapshot(page, ids.minute))!;
    const anchor = seed.lastClose;
    const box = await page.evaluate(id => {
      const chart = (window as unknown as ChartsWindow).__liveCharts.get(id)!;
      const rect = chart.panes()[0].getHTMLElement()!.getBoundingClientRect();
      return { x: rect.left, y: rect.top, width: chart.timeScale().width(), height: rect.height };
    }, ids.minute);
    await page.mouse.move(box.x + box.width * .4, box.y + box.height * .6);
    if (gesture === 'pan') {
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * .55, box.y + box.height * .6, { steps: 8 });
      await page.mouse.up();
      await settleFrame(page);
      const moved = (await snapshot(page, ids.minute, anchor))!;
      expect(moved.x! - seed.x!).toBeGreaterThan(100);
      expect(moved.span).toBeCloseTo(seed.span, 5);
    } else if (gesture === 'zoom') {
      await page.mouse.wheel(0, -240);
      await expect.poll(async () => (await snapshot(page, ids.minute))!.span).toBeLessThan(seed.span);
      await settleFrame(page);
    }
    const before = (await snapshot(page, ids.minute, anchor))!;
    // The reserved whitespace must not start a left-pan backfill before the
    // failed initial query retries; its original date bounds remain intact.
    expect(queries.filter(q => q.to === '20260929')).toEqual([
      { from: '20260922', to: '20260929' },
    ]);
    partial = false;
    await page.clock.install({ time: new Date('2026-10-01T17:00:00+09:00') });
    await page.clock.fastForward(61000);
    await expect.poll(async () => (await snapshot(page, ids.minute))?.count).toBe(768);
    await page.clock.runFor(100);
    const after = (await snapshot(page, ids.minute, anchor))!;
    if (gesture === 'none') {
      expect(after.visibleCount).toBe(300);
      expect(after.span).toBeGreaterThan(300);
      expect(after.latestX).toBeGreaterThan(0);
      expect(after.latestX).toBeLessThan(after.width);
    } else {
      expect(after.span).toBeCloseTo(before.span, 5);
      expect(after.spacing).toBeCloseTo(before.spacing, 5);
      expect(Math.abs(after.x! - before.x!)).toBeLessThan(1);
    }
  });
}
