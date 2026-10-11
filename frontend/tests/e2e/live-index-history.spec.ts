import { test, expect, type Page } from '@playwright/test';
import type { IChartApi, Time } from 'lightweight-charts';
import type { WorkspaceWindow } from '../../src/state/workspace';
import { installLiveMocks } from './helpers/liveMocks';
import { apiExact } from './helpers/apiRoutes';

type ChartWindow = Window & { __liveCharts: Map<string, IChartApi> };
const day = 86400000;
const end = Date.UTC(2026, 9, 1);
const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10).replaceAll('-', '');
function rows(from: string, tf: string) {
  const points = [];
  let month = '';
  for (let ms = end - 12000 * day; ms <= end; ms += day) {
    const date = new Date(ms);
    if (ymd(ms) < from || [0, 6].includes(date.getUTCDay())) continue;
    if (tf === 'W' && date.getUTCDay() !== 1) continue;
    if (tf === 'M') {
      const key = ymd(ms).slice(0, 6);
      if (month === key) continue;
      month = key;
    }
    const n = tf === '3m' ? 130 : 1;
    for (let i = 0; i < n; i++) {
      const t_ms = ms + i * 180000;
      const close = 3000 + (t_ms - end) / day * .02;
      points.push({ t_ms, open: close - 1, high: close + 2, low: close - 2, close, volume: 100, trade_value_won: 120000000 });
    }
  }
  return points;
}
async function snapshot(page: Page, id: string, anchor?: number) {
  return page.evaluate(({ id, anchor }) => {
    const chart = (window as unknown as ChartWindow).__liveCharts?.get(id);
    const series = chart?.panes()[0]?.getSeries().find(s => s.seriesType() === 'Candlestick');
    const data = series?.data() as readonly { time: Time; close: number }[] | undefined;
    if (!chart || !data?.length) return null;
    const ts = chart.timeScale();
    const range = ts.getVisibleLogicalRange();
    if (!range) return null;
    const selected = anchor == null ? data[80] : data.find(r => r.close === anchor);
    return { count: data.length, anchor: selected?.close, x: selected ? ts.timeToCoordinate(selected.time) : null,
      range, spacing: ts.options().barSpacing,
      visible: data.filter(r => {
        const index = ts.timeToIndex(r.time);
        return index != null && index >= range.from && index <= range.to;
      }).length };
  }, { id, anchor });
}
for (const tf of ['D', 'W', 'M', '3m'] as const) {
  for (const failure of [false, true]) {
    test(`index ${tf} history ${failure ? 'empty failure retains candles' : 'prepend retains viewport'}`, async ({ page }) => {
      await page.setViewportSize({ width: 1600, height: 1000 });
      await page.clock.setFixedTime(new Date('2026-10-01T17:00:00+09:00'));
      await installLiveMocks(page);
      await page.routeWebSocket(/\/api\/ws/, () => {});
      let armed = false;
      let extensions = 0;
      await page.route(apiExact('live/index-candles'), route => {
        const p = new URL(route.request().url()).searchParams;
        const from = p.get('from')!;
        if (armed) extensions++;
        return route.fulfill({ json: {
          index_id: p.get('index_id'), timeframe: tf, from, to: p.get('to'),
          candles: armed && failure ? [] : rows(from, tf),
          data_warnings: armed && failure ? [{ batch: `${from}__20261001`,
            reason: 'index_kis_capacity_overloaded', kind: 'deferred', is_failure: true, msg: 'busy' }] : [],
        } });
      });
      await page.goto('/live?code=098460');
      await expect.poll(() => page.evaluate(() => (window as unknown as ChartWindow).__liveCharts?.size ?? 0)).toBeGreaterThan(0);
      const id = await page.evaluate(async tf => {
        const path = '/src/state/workspace.ts';
        const { useWorkspaceStore: store } = await import(path);
        const win = store.getState().windows.find((w: WorkspaceWindow) => w.kind === 'chart');
        store.getState().applyWorkspaceSnapshot({ windows: [{ ...win,
          group: 1, rect: { x: 0, y: 0, w: 1, h: 1 }, chart: { ...win.chart, timeframe: tf } }],
          zOrder: [win.id], maximizedId: null });
        store.getState().setWindowSymbol(win.id, { code: 'KOSPI', name: '코스피', kind: 'index' });
        return win.id as string;
      }, tf);
      await expect.poll(async () => (await snapshot(page, id))?.count ?? 0).toBeGreaterThan(100);
      await expect(page.getByTestId('chart-reveal-cover').first()).toHaveCSS('opacity', '0');
      const original = (await snapshot(page, id))!;
      armed = true;
      await page.evaluate(id => (window as unknown as ChartWindow).__liveCharts.get(id)!.timeScale()
        .setVisibleLogicalRange({ from: -10, to: 100 }), id);
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      const before = (await snapshot(page, id, original.anchor))!;
      await expect.poll(() => extensions).toBeGreaterThan(0);
      if (failure) await expect.poll(async () => (await snapshot(page, id))?.count).toBe(original.count);
      else await expect.poll(async () => (await snapshot(page, id))?.count ?? 0).toBeGreaterThan(original.count);
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      const after = (await snapshot(page, id, original.anchor))!;
      expect(after.visible).toBeGreaterThan(0);
      expect(after.spacing).toBeCloseTo(before.spacing, 4);
      expect(after.x).not.toBeNull();
      expect(Math.abs(after.x! - before.x!)).toBeLessThan(1);
    });
  }
}

test('stock and index indicators remain independent when switching and reloading the same chart', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.clock.setFixedTime(new Date('2026-10-01T17:00:00+09:00'));
  await installLiveMocks(page);
  await page.routeWebSocket(/\/api\/ws/, () => {});
  await page.route(apiExact('live/series'), route => route.fulfill({ json: {
    code: '098460', date: '20261001', snapshots: [], trades: [], brokers: [],
    session_open_ms: end, session_close_ms: end + 23400000, is_open: false,
  } }));
  for (const endpoint of ['live/index-candles', 'live/past-daily-candles']) {
    await page.route(apiExact(endpoint), route => {
      const p = new URL(route.request().url()).searchParams;
      return route.fulfill({ json: { index_id: p.get('index_id'), code: p.get('code'),
        timeframe: 'D', from: p.get('from'), to: p.get('to'), candles: rows(p.get('from')!, 'D'),
        cached_batches: [], fresh_batches: [], data_warnings: [] } });
    });
  }
  await page.goto('/live?code=098460');
  await expect.poll(() => page.evaluate(() => (window as unknown as ChartWindow).__liveCharts?.size ?? 0)).toBeGreaterThan(0);
  const id = await page.evaluate(async () => {
    const path = '/src/state/workspace.ts';
    const { useWorkspaceStore: store } = await import(path);
    const win = store.getState().windows.find((w: WorkspaceWindow) => w.kind === 'chart');
    store.getState().applyWorkspaceSnapshot({ windows: [{ ...win, group: 1,
      rect: { x: 0, y: 0, w: 1, h: 1 }, chart: { ...win.chart, timeframe: 'D' } }],
      zOrder: [win.id], maximizedId: null });
    return win.id as string;
  });
  const switchKind = async (kind: 'stock' | 'index') => {
    await page.evaluate(async ({ id, kind }) => {
      const path = '/src/state/workspace.ts';
      const { useWorkspaceStore: store } = await import(path);
      store.getState().setWindowSymbol(id, kind === 'index'
        ? { code: 'KOSPI', name: '코스피', kind } : { code: '098460', name: '고영', kind });
    }, { id, kind });
  };
  await page.getByTestId('live-indicators-button').click();
  await page.getByTestId('indicator-panel-mode-toggle').click();
  await page.getByRole('button', { name: '거래대금 추가', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('pane-legend-rows-trade-value')).toBeVisible();
  await switchKind('index');
  await page.getByTestId('live-indicators-button').click();
  await page.getByRole('button', { name: '거래량 삭제', exact: true }).click();
  await page.getByRole('button', { name: '거래대금 삭제', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('pane-legend-rows-trade-value')).toHaveCount(0);
  await switchKind('stock');
  await expect(page.getByTestId('pane-legend-rows-trade-value')).toBeVisible();
  await expect(page.getByTestId('pane-legend-rows-volume')).toBeVisible();
  await switchKind('index');
  await expect(page.getByTestId('pane-legend-rows-trade-value')).toHaveCount(0);
  await page.evaluate(() => history.replaceState(null, '', '/live'));
  await page.reload();
  await expect.poll(async () => (await snapshot(page, id))?.visible ?? 0).toBeGreaterThan(0);
  await expect(page.getByTestId('pane-legend-rows-trade-value')).toHaveCount(0);
  await switchKind('stock');
  await expect(page.getByTestId('pane-legend-rows-trade-value')).toBeVisible();
  await expect(page.getByTestId('pane-legend-rows-volume')).toBeVisible();
});
