import { test, expect, type Page } from '@playwright/test';
import type { IChartApi, ISeriesApi } from 'lightweight-charts';
import type { WorkspaceWindow } from '../../src/state/workspace';
import { installLiveMocks } from './helpers/liveMocks';
import { apiExact } from './helpers/apiRoutes';

type ChartWindow = Window & { __liveCharts: Map<string, IChartApi> };

async function bands(page: Page, id: string) {
  return page.evaluate(id => {
    const chart = (window as unknown as ChartWindow).__liveCharts?.get(id);
    return chart?.panes().flatMap(p => p.getSeries())
      .filter(s => s.seriesType() === 'Line')
      .map(s => s as ISeriesApi<'Line'>)
      // The upper/lower default color is distinct from all default MA slots.
      .filter(s => s.options().color === '#3B82F6')
      .map(s => ({ visible: s.options().visible, values: s.data().flatMap(p => 'value' in p ? [p.value] : []) }));
  }, id);
}

test('Bollinger bands draw three lines, retain parameters on reload, and support hiding and deletion', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.clock.setFixedTime(new Date('2026-10-01T17:00:00+09:00'));
  await installLiveMocks(page);
  await page.route(apiExact('live/series'), route => route.fulfill({ json: {
    code: '098460', date: '20261001', snapshots: [], trades: [], brokers: [],
    session_open_ms: Date.parse('2026-10-01T09:00:00+09:00'),
    session_close_ms: Date.parse('2026-10-01T15:30:00+09:00'), is_open: false,
  } }));
  await page.route(apiExact('live/settings'), route => route.fulfill({ json: {
    schema_version: 1, rest_bypass_enabled: false, screener_depth_autocollect: false, krx_prefer_hogaplay: false,
  } }));
  await page.route(apiExact('live/past-daily-candles'), route => {
    const params = new URL(route.request().url()).searchParams;
    return route.fulfill({ json: {
      code: params.get('code'), from: params.get('from'), to: params.get('to'), venue: 'KRX',
      source: 'screener_daily', cached_batches: [], fresh_batches: [], data_warnings: [],
      candles: ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01'].map((date, i) => ({
        t_ms: Date.parse(`${date}T09:00:00+09:00`),
        open: 10000 + i * 100, close: 10000 + i * 100, high: 10100 + i * 100, low: 9900 + i * 100, volume: 999,
      })),
    } });
  });
  await page.goto('/live?code=098460');
  await expect.poll(() => page.evaluate(() => (window as unknown as ChartWindow).__liveCharts?.size ?? 0)).toBeGreaterThan(0);
  const id = await page.evaluate(async () => {
    const path = '/src/state/workspace.ts';
    const { useWorkspaceStore: store } = await import(path);
    const win = store.getState().windows.find((w: WorkspaceWindow) => w.kind === 'chart');
    store.getState().applyWorkspaceSnapshot({ windows: [{ ...win,
      group: 1, rect: { x: 0, y: 0, w: 1, h: 1 }, chart: { ...win.chart, timeframe: 'D' } }],
      zOrder: [win.id], maximizedId: null });
    return win.id as string;
  });
  await page.getByTestId('live-indicators-button').click();
  await page.getByTestId('indicator-panel-mode-toggle').click();
  await page.getByRole('button', { name: '볼린저 밴드', exact: true }).click();
  await page.getByRole('button', { name: '설정대로 추가', exact: true }).click();
  const period = page.getByRole('spinbutton', { name: '볼린저 기간' });
  await expect(period).toHaveValue('20');
  await period.fill('3');
  await period.press('Enter');
  await page.keyboard.press('Escape');
  const width = 2 * Math.sqrt(20000 / 3);
  const expected = [
    { visible: true, values: [10100 + width, 10200 + width] },
    { visible: true, values: [10100 - width, 10200 - width] },
  ];
  await expect.poll(() => bands(page, id)).toEqual(expected);
  const legend = page.getByTestId('pane-legend-rows-candle');
  await expect(legend).toContainText('볼린저 밴드 (3, 2)');
  await expect(legend).toContainText('중심');
  await expect(legend).toContainText('10,200');
  await page.screenshot({ path: testInfo.outputPath('bollinger-bands.png') });
  const eye = page.getByRole('button', { name: '볼린저 밴드 (3, 2) 표시 숨김/표시', exact: true });
  await eye.click();
  await expect.poll(() => bands(page, id)).toEqual(expected.map(s => ({ ...s, visible: false })));
  await page.evaluate(() => history.replaceState(null, '', '/live'));
  await page.reload();
  await expect.poll(() => bands(page, id)).toEqual(expected.map(s => ({ ...s, visible: false })));
  await eye.click();
  await expect.poll(() => bands(page, id)).toEqual(expected);
  await page.getByRole('button', { name: '볼린저 밴드 (3, 2) 삭제', exact: true }).click();
  await expect.poll(() => bands(page, id)).toEqual([]);
  await expect(legend).not.toContainText('볼린저 밴드');
});
