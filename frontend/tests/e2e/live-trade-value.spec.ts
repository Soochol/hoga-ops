import { test, expect, type Page } from '@playwright/test';
import type { IChartApi } from 'lightweight-charts';
import type { WorkspaceWindow } from '../../src/state/workspace';
import { installLiveMocks } from './helpers/liveMocks';
import { apiExact } from './helpers/apiRoutes';

type ChartWindow = Window & { __liveCharts: Map<string, IChartApi> };

async function turnoverBars(page: Page, id: string) {
  return page.evaluate(id => {
    const chart = (window as unknown as ChartWindow).__liveCharts?.get(id);
    return chart?.panes().flatMap(p => p.getSeries())
      .filter(s => s.seriesType() === 'Histogram')
      .map(s => s.data().map(p => 'value' in p ? p.value : null));
  }, id);
}

for (const timeframe of ['D', 'W', 'M'] as const) {
  for (const bypass of [false, true]) {
    test(`stock ${timeframe} ${bypass ? 'saved data without turnover' : 'vendor turnover'}: histogram and reload`, async ({ page }) => {
      await page.setViewportSize({ width: 1600, height: 1000 });
      await page.clock.setFixedTime(new Date('2026-10-01T17:00:00+09:00'));
      await installLiveMocks(page);
      await page.route(apiExact('live/series'), route => route.fulfill({ json: {
        code: '098460', date: '20261001', snapshots: [], trades: [], brokers: [],
        session_open_ms: Date.parse('2026-10-01T09:00:00+09:00'),
        session_close_ms: Date.parse('2026-10-01T15:30:00+09:00'), is_open: false,
      } }));
      await page.route(apiExact('live/settings'), route => route.fulfill({ json: {
        schema_version: 1, rest_bypass_enabled: bypass,
        screener_depth_autocollect: false, krx_prefer_hogaplay: false,
      } }));
      const dates = ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01'];
      const amounts = [120_000_000, 0, 340_000_000, 560_000_000];
      const expected = bypass ? [] : timeframe === 'D' ? amounts
        : timeframe === 'W' ? [1_020_000_000] : [460_000_000, 560_000_000];
      const volumes = timeframe === 'D' ? [999, 999, 999, 999]
        : timeframe === 'W' ? [3996] : [2997, 999];
      const endpoint = bypass ? 'live/screener-daily-candles' : 'live/past-daily-candles';
      await page.route(apiExact(endpoint), route => {
        const params = new URL(route.request().url()).searchParams;
        return route.fulfill({ json: {
          code: params.get('code'), from: params.get('from'), to: params.get('to'),
          venue: params.get('venue') ?? 'KRX', source: 'screener_daily',
          cached_batches: [], fresh_batches: [], data_warnings: [],
          candles: dates.map((date, i) => ({
            t_ms: Date.parse(`${date}T09:00:00+09:00`),
            open: 35000, close: i === 1 ? 34900 : 35100, high: 35100, low: 34900,
            volume: 999, ...(!bypass ? { trade_value_won: amounts[i] } : {}),
          })),
        } });
      });
      await page.goto('/live?code=098460');
      await expect.poll(() => page.evaluate(() => (window as unknown as ChartWindow).__liveCharts?.size ?? 0)).toBeGreaterThan(0);
      const id = await page.evaluate(async timeframe => {
        const workspacePath = '/src/state/workspace.ts';
        const { useWorkspaceStore: store } = await import(workspacePath);
        const win = store.getState().windows.find((w: WorkspaceWindow) => w.kind === 'chart');
        store.getState().applyWorkspaceSnapshot({ windows: [{ ...win,
          group: 1, rect: { x: 0, y: 0, w: 1, h: 1 }, chart: { ...win.chart, timeframe } }],
          zOrder: [win.id], maximizedId: null });
        return win.id as string;
      }, timeframe);
      await expect.poll(() => turnoverBars(page, id)).toEqual([volumes]);
      await page.getByTestId('live-indicators-button').click();
      await page.getByTestId('indicator-panel-mode-toggle').click();
      await page.getByRole('button', { name: '거래대금 추가', exact: true }).click();
      await page.keyboard.press('Escape');
      await expect.poll(() => turnoverBars(page, id)).toEqual([volumes, expected]);
      await expect(page.getByTestId('pane-legend-rows-trade-value')).toBeVisible();
      await page.evaluate(() => history.replaceState(null, '', '/live'));
      await page.reload();
      await expect.poll(() => turnoverBars(page, id)).toEqual([volumes, expected]);
    });
  }
}

for (const timeframe of ['D', 'W', 'M'] as const) {
  test(`index ${timeframe}: turnover histogram, independent toggle and reload persistence`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.clock.setFixedTime(new Date('2026-10-01T17:00:00+09:00'));
    await installLiveMocks(page);
    const dates = timeframe === 'D' ? ['2026-09-29', '2026-09-30', '2026-10-01']
      : timeframe === 'W' ? ['2026-09-14', '2026-09-21', '2026-09-28']
        : ['2026-08-03', '2026-09-01', '2026-10-01'];
    const amounts = [0, 54703685000000, 18840196000000];
    await page.route(apiExact('live/index-candles'), route => {
      const params = new URL(route.request().url()).searchParams;
      return route.fulfill({ json: {
        index_id: params.get('index_id'), timeframe: params.get('timeframe'),
        from: params.get('from'), to: params.get('to'), data_warnings: [],
        candles: dates.map((date, i) => ({ t_ms: Date.parse(`${date}T09:00:00+09:00`),
          open: 3000, close: i === 1 ? 2900 : 3100, high: 3100, low: 2900,
          volume: 999999, trade_value_won: amounts[i] })),
      } });
    });
    await page.goto('/live?code=098460');
    await expect.poll(() => page.evaluate(() => (window as unknown as ChartWindow).__liveCharts?.size ?? 0)).toBeGreaterThan(0);
    const id = await page.evaluate(async timeframe => {
      const path = '/src/state/workspace.ts';
      const { useWorkspaceStore: store } = await import(path);
      const win = store.getState().windows.find((w: WorkspaceWindow) => w.kind === 'chart');
      store.getState().applyWorkspaceSnapshot({ windows: [{ ...win,
        group: 1, rect: { x: 0, y: 0, w: 1, h: 1 }, chart: { ...win.chart, timeframe } }],
        zOrder: [win.id], maximizedId: null });
      store.getState().setWindowSymbol(win.id, { code: 'KOSPI', name: '코스피', kind: 'index' });
      return win.id as string;
    }, timeframe);
    await expect.poll(async () => (await turnoverBars(page, id))?.length).toBe(1); // existing volume
    await page.getByTestId('live-indicators-button').click();
    await page.getByTestId('indicator-panel-mode-toggle').click();
    await page.getByRole('button', { name: '거래대금 추가', exact: true }).click();
    await page.keyboard.press('Escape');
    await expect.poll(() => turnoverBars(page, id)).toEqual([[999999, 999999, 999999], amounts]);
    await expect(page.getByTestId('pane-legend-rows-trade-value')).toContainText('18.84조');
    await expect(page.getByTestId('pane-legend-rows-trade-value')).toBeVisible();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await page.screenshot({ path: testInfo.outputPath('index-turnover.png') });

    // Both panes are independent; reload restores the window's calendar bucket.
    // Drop the initial stock deep link so it doesn't replace the saved index.
    await page.evaluate(() => history.replaceState(null, '', '/live'));
    await page.reload();
    await expect.poll(() => turnoverBars(page, id)).toEqual([[999999, 999999, 999999], amounts]);
    await page.getByTestId('live-indicators-button').click();
    await page.getByRole('button', { name: '거래량 삭제', exact: true }).click();
    await page.keyboard.press('Escape');
    await expect.poll(() => turnoverBars(page, id)).toEqual([amounts]);
    await page.getByTestId('live-indicators-button').click();
    await page.getByRole('button', { name: '거래대금 삭제', exact: true }).click();
    await page.keyboard.press('Escape');
    await expect.poll(async () => (await turnoverBars(page, id))?.length).toBe(0);
  });
}
