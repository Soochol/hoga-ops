import { test, expect, type Page } from '@playwright/test';
import type { IChartApi, ISeriesApi, SeriesType } from 'lightweight-charts';
import type { WorkspaceWindow } from '../../src/state/workspace';
import { installLiveMocks } from './helpers/liveMocks';
import { apiExact } from './helpers/apiRoutes';

type TestWindow = Window & {
  __liveCharts: Map<string, IChartApi>;
  __maOrderBefore: {
    chart: IChartApi;
    series: ISeriesApi<SeriesType>[];
    range: ReturnType<ReturnType<IChartApi['timeScale']>['getVisibleLogicalRange']>;
  };
};

async function ordering(page: Page, id: string) {
  return page.evaluate(id => {
    const w = window as unknown as TestWindow;
    const chart = w.__liveCharts?.get(id);
    const series = chart?.panes()[0]?.getSeries() ?? [];
    const candle = series.find(s => s.seriesType() === 'Candlestick');
    const before = w.__maOrderBefore;
    return {
      count: series.length,
      candleOrder: candle?.seriesOrder(),
      populatedLines: series.filter(s => s.seriesType() === 'Line' && s.data().length > 0).length,
      range: chart?.timeScale().getVisibleLogicalRange(),
      ...(before ? {
        sameChart: chart === before.chart,
        originalsKept: before.series.every(s => series.includes(s)),
      } : {}),
    };
  }, id);
}

for (const kind of ['current', 'daily', 'calendar'] as const) {
  for (const onTop of [true, false]) {
    test(`${kind} MA add/remove preserves candles ${onTop ? 'above' : 'below'} lines and viewport`, async ({ page }) => {
      await page.setViewportSize({ width: 1600, height: 1000 });
      await page.clock.setFixedTime(new Date('2026-10-01T17:00:00+09:00'));
      await installLiveMocks(page);
      await page.route(apiExact('live/settings'), route => route.fulfill({ json: {
        schema_version: 1, rest_bypass_enabled: false,
        screener_depth_autocollect: false, krx_prefer_hogaplay: false,
      } }));
      await page.route(apiExact('live/series'), route => route.fulfill({ json: {
        code: '098460', date: '20261001', snapshots: [], trades: [], brokers: [],
        session_open_ms: Date.parse('2026-10-01T09:00:00+09:00'),
        session_close_ms: Date.parse('2026-10-01T15:30:00+09:00'), is_open: false,
      } }));
      await page.route(apiExact('live/past-candles'), route => route.fulfill({ json: {
        code: '098460', from: '20260930', to: '20261001',
        cached_dates: ['20260930'], fresh_dates: [], data_warnings: [],
        candles: Array.from({ length: 120 }, (_, i) => ({
          t_ms: Date.parse('2026-09-30T09:00:00+09:00') + i * 60_000,
          open: 35000 + i, high: 35100 + i, low: 34900 + i, close: 35050 + i, volume: 100,
        })),
      } }));
      for (const endpoint of ['live/past-daily-candles', 'live/screener-daily-candles']) {
        await page.route(apiExact(endpoint), route => route.fulfill({ json: {
          code: '098460', from: '20260928', to: '20261001', venue: 'KRX',
          cached_batches: [], fresh_batches: [], data_warnings: [],
          candles: ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01'].map(date => ({
            t_ms: Date.parse(`${date}T09:00:00+09:00`),
            open: 35000, high: 35200, low: 34900, close: 35050, volume: 10000,
          })),
        } }));
      }
      await page.goto('/live?code=098460');
      await expect.poll(() => page.evaluate(() => (window as unknown as TestWindow).__liveCharts?.size ?? 0)).toBeGreaterThan(0);
      const id = await page.evaluate(async ({ onTop, kind }) => {
        const workspacePath = '/src/state/workspace.ts';
        const livePath = '/src/state/livePage.ts';
        const prefsPath = '/src/state/chartPrefs.ts';
        const { useWorkspaceStore: workspace } = await import(workspacePath);
        const { useLivePageStore: live } = await import(livePath);
        const { useChartPrefsStore: prefs } = await import(prefsPath);
        const win = workspace.getState().windows.find((w: WorkspaceWindow) => w.kind === 'chart');
        const timeframe = kind === 'calendar' ? 'D' : '1m';
        workspace.getState().applyWorkspaceSnapshot({ windows: [{ ...win,
          group: 1, rect: { x: 0, y: 0, w: 1, h: 1 }, chart: { ...win.chart, timeframe } }],
          zOrder: [win.id], maximizedId: null });
        const slot = { period: 2, enabled: true, color: '#ff0000', lineWidth: 1, source: 'close' };
        live.getState().patchIndicatorsScoped({ windowKey: `live:${win.id}` }, timeframe, {
          movingAverages: [{ ...slot, id: 'current' }, ...(kind === 'calendar' ? [{ ...slot, id: 'second' }] : [])],
          dailyMovingAverages: kind === 'calendar' ? [] : [{ ...slot, id: 'daily' }],
        });
        prefs.getState().setToggle('candleAlwaysOnTop', onTop);
        return win.id as string;
      }, { onTop, kind });
      await expect.poll(() => ordering(page, id)).toMatchObject({ count: 3, populatedLines: 2, candleOrder: onTop ? 2 : 0 });

      // Opening the real drawer and editing slots must preserve all existing handles and the user's zoom.
      await page.getByTestId('live-indicators-button').click();
      await page.getByRole('button', { name: kind === 'daily' ? '일봉 이동평균선' : '이동평균선', exact: true }).click();
      const range = kind === 'calendar' ? { from: -10, to: 2 } : { from: 20, to: 65 };
      await page.evaluate(({ id, range }) => {
        const w = window as unknown as TestWindow;
        const chart = w.__liveCharts.get(id)!;
        chart.timeScale().setVisibleLogicalRange(range);
      }, { id, range });
      await expect.poll(() => ordering(page, id)).toMatchObject({ range });
      await page.evaluate(id => {
        const w = window as unknown as TestWindow;
        const chart = w.__liveCharts.get(id)!;
        w.__maOrderBefore = { chart, series: chart.panes()[0].getSeries(), range: chart.timeScale().getVisibleLogicalRange() };
      }, id);
      await page.getByRole('button', { name: /기간 추가/ }).click();
      await page.getByRole('spinbutton').last().fill('3');
      await page.getByRole('spinbutton').last().press('Enter');
      await expect.poll(() => ordering(page, id)).toMatchObject({
        count: 4, populatedLines: 3, candleOrder: onTop ? 3 : 0,
        sameChart: true, originalsKept: true, range,
      });
      await page.getByRole('button', { name: '슬롯 삭제', exact: true }).last().click();
      await expect.poll(() => ordering(page, id)).toMatchObject({
        count: 3, populatedLines: 2, candleOrder: onTop ? 2 : 0,
        sameChart: true, originalsKept: true, range,
      });
      await page.getByRole('button', { name: /기간 추가/ }).click();
      await expect.poll(() => ordering(page, id)).toMatchObject({
        count: 4, candleOrder: onTop ? 3 : 0, sameChart: true, originalsKept: true, range,
      });
      await page.keyboard.press('Escape');
      await page.evaluate(() => history.replaceState(null, '', '/live'));
      await page.reload();
      await expect.poll(() => ordering(page, id)).toMatchObject({ count: 4, candleOrder: onTop ? 3 : 0 });
    });
  }
}
