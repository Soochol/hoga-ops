import { test, expect, type Page } from '@playwright/test';
import type { IChartApi, ISeriesApi } from 'lightweight-charts';
import type { WorkspaceWindow } from '../../src/state/workspace';
import { installLiveMocks } from './helpers/liveMocks';
import { apiExact } from './helpers/apiRoutes';

type ChartWindow = Window & { __liveCharts: Map<string, IChartApi> };
const closes = [10000, 10000, 14000, 15000, 9000, 8000, 14000, 15000];

async function trend(page: Page, id: string) {
  return page.evaluate(id => {
    const chart = (window as unknown as ChartWindow).__liveCharts?.get(id);
    const series = chart?.panes().flatMap(p => p.getSeries())
      .find(s => s.seriesType() === 'Line' && s.options().title === '슈퍼트렌드') as ISeriesApi<'Line'> | undefined;
    return series ? { visible: series.options().visible,
      points: series.data().flatMap(p => 'value' in p ? [{ value: p.value, color: p.color }] : []) } : null;
  }, id);
}

for (const timeframe of ['1m', 'D'] as const) {
  test(`Supertrend ${timeframe}: trend flips, persistence, visibility, deletion and undo`, async ({ page }, testInfo) => {
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
      candles: ['2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01'].map((date, i) => ({
        t_ms: Date.parse(`${date}T09:00:00+09:00`),
        open: closes[i], close: closes[i], high: closes[i] + 1000, low: closes[i] - 1000, volume: 999,
      })),
    } });
  });
  await page.route(apiExact('live/past-candles'), route => route.fulfill({ json: {
    code: '098460', from: '20260930', to: '20260930', cached_dates: ['20260930'], fresh_dates: [], data_warnings: [],
    candles: closes.map((close, i) => ({ t_ms: Date.parse('2026-09-30T09:00:00+09:00') + i * 60000,
      open: close, close, high: close + 1000, low: close - 1000, volume: 999 })),
  } }));
  await page.goto('/live?code=098460');
  await expect.poll(() => page.evaluate(() => (window as unknown as ChartWindow).__liveCharts?.size ?? 0)).toBeGreaterThan(0);
  const id = await page.evaluate(async timeframe => {
    const path = '/src/state/workspace.ts';
    const { useWorkspaceStore: store } = await import(path);
    const win = store.getState().windows.find((w: WorkspaceWindow) => w.kind === 'chart');
    store.getState().applyWorkspaceSnapshot({ windows: [{ ...win,
      group: 1, rect: { x: 0, y: 0, w: 1, h: 1 }, chart: { ...win.chart, timeframe } }],
      zOrder: [win.id], maximizedId: null });
    return win.id as string;
  }, timeframe);
  await page.getByTestId('live-indicators-button').click();
  await page.getByTestId('indicator-panel-mode-toggle').click();
  await page.getByRole('button', { name: '슈퍼트렌드', exact: true }).click();
  await page.getByRole('button', { name: '설정대로 추가', exact: true }).click();
  const period = page.getByRole('spinbutton', { name: '슈퍼트렌드 기간' });
  await expect(period).toHaveValue('10');
  await period.fill('2');
  await period.press('Enter');
  const multiplier = page.getByRole('spinbutton', { name: '슈퍼트렌드 ATR 배수' });
  await expect(multiplier).toHaveValue('3');
  await multiplier.fill('1');
  await multiplier.press('Enter');
  await page.keyboard.press('Escape');
  const expected = { visible: true, points: [
    { value: 12000, color: 'transparent' },
    { value: 10500, color: '#F04452' },
    { value: 12250, color: 'transparent' },
    { value: 13875, color: '#3485FA' },
    { value: 11437.5, color: 'transparent' },
    { value: 8781.25, color: '#F04452' },
    { value: 11390.625, color: '#F04452' },
  ] };
  await expect.poll(() => trend(page, id)).toEqual(expected);
  const legend = page.getByTestId('pane-legend-rows-candle');
  await expect(legend).toContainText('슈퍼트렌드 (2, 1)');
  await expect(legend).toContainText('상승');
  await expect(legend).toContainText('11,391');
  await page.screenshot({ path: testInfo.outputPath(`supertrend-${timeframe}.png`) });
  const eye = page.getByRole('button', { name: '슈퍼트렌드 (2, 1) 표시 숨김/표시', exact: true });
  await eye.click();
  await expect.poll(() => trend(page, id)).toEqual({ ...expected, visible: false });
  await page.evaluate(() => history.replaceState(null, '', '/live'));
  await page.reload();
  await expect.poll(() => trend(page, id)).toEqual({ ...expected, visible: false });
  await eye.click();
  await expect.poll(() => trend(page, id)).toEqual(expected);
  await page.getByRole('button', { name: '슈퍼트렌드 (2, 1) 삭제', exact: true }).click();
  await expect.poll(() => trend(page, id)).toBeNull();
  await expect(legend).not.toContainText('슈퍼트렌드');
  await page.getByRole('button', { name: '실행 취소', exact: true }).click();
  await expect.poll(() => trend(page, id)).toEqual(expected);
  });
}
