import { test, expect, type Page } from '@playwright/test';
import type { IChartApi } from 'lightweight-charts';
import type { WorkspaceWindow } from '../../src/state/workspace';
import { installLiveMocks } from './helpers/liveMocks';
import { apiExact } from './helpers/apiRoutes';

type ChartWindow = Window & { __liveCharts: Map<string, IChartApi> };
async function paneHeights(page: Page, id: string) {
  return page.evaluate(id => (window as unknown as ChartWindow).__liveCharts?.get(id)?.panes()
    .map(pane => pane.getHeight()) ?? [], id);
}
async function settleFrames(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

for (const kind of ['stock', 'index'] as const) {
  for (const reduced of ['foreign', 'institution'] as const) {
    test(`${kind}: reduced ${reduced} pane persists with volume and both investors`, async ({ page }) => {
      await page.setViewportSize({ width: 1600, height: 1000 });
      await page.clock.setFixedTime(new Date('2026-10-01T17:00:00+09:00'));
      await installLiveMocks(page);
      await page.routeWebSocket(/\/api\/ws/, () => {});
      const open = Date.parse('2026-09-28T09:00:00+09:00');
      const candles = [0, 1, 2, 3].map(i => ({ t_ms: open + i * 86400000,
        open: 3000, high: 3100, low: 2900, close: 3020 + i * 5, volume: 100 + i }));
      for (const endpoint of ['live/past-daily-candles', 'live/index-candles']) {
        await page.route(apiExact(endpoint), route => {
          const p = new URL(route.request().url()).searchParams;
          return route.fulfill({ json: { code: p.get('code'), index_id: p.get('index_id'),
            from: p.get('from'), to: p.get('to'), timeframe: p.get('timeframe'), candles,
            cached_batches: [], fresh_batches: [], data_warnings: [] } });
        });
      }
      for (const endpoint of ['live/past-investor-net', 'live/index-investor-net']) {
        await page.route(apiExact(endpoint), route => {
          const p = new URL(route.request().url()).searchParams;
          return route.fulfill({ json: { code: p.get('code'), index_id: p.get('index_id'),
            from: p.get('from'), to: p.get('to'), unit: kind === 'stock' ? 'qty_shares' : 'amt_eok',
            trade_side: 'net', points: candles.map((c, i) => ({ t_ms: c.t_ms,
              foreign_net: (i - 1) * 1000, institution_net: (1 - i) * 3000 })),
            cached_batches: [], fresh_batches: [], data_warnings: [] } });
        });
      }
      await page.route(apiExact('live/series'), route => route.fulfill({ json: {
        code: '098460', date: '20261001', snapshots: [], trades: [], brokers: [],
        session_open_ms: Date.parse('2026-10-01T09:00:00+09:00'),
        session_close_ms: Date.parse('2026-10-01T15:30:00+09:00'), is_open: false,
      } }));
      await page.goto('/live?code=098460');
      await expect.poll(() => page.evaluate(() => (window as unknown as ChartWindow).__liveCharts?.size ?? 0)).toBeGreaterThan(0);
      const id = await page.evaluate(async kind => {
        const workspacePath = '/src/state/workspace.ts';
        const indicatorPath = '/src/state/livePage.ts';
        const { useWorkspaceStore: store } = await import(workspacePath);
        const { useLivePageStore } = await import(indicatorPath);
        const win = store.getState().windows.find((w: WorkspaceWindow) => w.kind === 'chart');
        store.getState().applyWorkspaceSnapshot({ windows: [{ ...win, group: 1,
          rect: { x: 0, y: 0, w: 1, h: 1 }, chart: { ...win.chart, timeframe: 'D' } }],
          zOrder: [win.id], maximizedId: null });
        store.getState().setWindowSymbol(win.id, kind === 'index'
          ? { code: 'KOSPI', name: '코스피', kind } : { code: '098460', name: '고영', kind });
        useLivePageStore.getState().patchIndicatorsScoped({
          windowKey: `live:${win.id}${kind === 'index' ? ':index' : ''}`,
        }, 'D', { volumeEnabled: true, tradeValueEnabled: false, dailyProgramEnabled: false,
          foreignNetEnabled: true, institutionNetEnabled: true });
        return win.id as string;
      }, kind);
      await expect.poll(async () => (await paneHeights(page, id)).length).toBe(4);
      await expect(page.getByTestId('chart-reveal-cover').first()).toHaveCSS('opacity', '0');
      await settleFrames(page);
      const before = await paneHeights(page, id);
      // lwc has both a background and a raised hit target for each separator.
      const separators = page.locator('[style*="row-resize"][style*="z-index: 50"]');
      await expect(separators).toHaveCount(3);
      const handle = (await separators.nth(2).boundingBox())!;
      const x = handle.x + handle.width / 2;
      const y = handle.y + handle.height / 2;
      const delta = reduced === 'foreign' ? -35 : 35;
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x, y + delta, { steps: 10 });
      await settleFrames(page);
      const during = await paneHeights(page, id);
      await page.mouse.up();
      await settleFrames(page);
      const after = await paneHeights(page, id);
      const target = reduced === 'foreign' ? 2 : 3;
      expect(before[target] - after[target]).toBeGreaterThan(20);
      for (const i of [2, 3]) expect(Math.abs(after[i] - during[i])).toBeLessThanOrEqual(2);
      await page.evaluate(() => history.replaceState(null, '', '/live'));
      await page.reload();
      await expect.poll(async () => (await paneHeights(page, id)).length).toBe(4);
      await expect(page.getByTestId('chart-reveal-cover').first()).toHaveCSS('opacity', '0');
      await settleFrames(page);
      const restored = await paneHeights(page, id);
      for (const i of [2, 3]) expect(Math.abs(restored[i] - after[i])).toBeLessThanOrEqual(2);
    });
  }
}
