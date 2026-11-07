import { expect, test, type Page } from '@playwright/test';
import type { InvestorDailyFlowResponse } from '../../src/api/investorDailyFlow';
import { apiExact } from './helpers/apiRoutes';
import { installSyncWorkspace, verifySyncChart, type SyncBrowser, type SyncWindow } from './helpers/tooltipCrosshair';

const chartWindow: SyncWindow = { id: 'shared-investor-flow', timeframe: 'D', code: '098460', group: 1, tooltip: false };
const quantities = [
  { date: '20261026', foreign: 99, institution: 77 },
  { date: '20261027', foreign: 10, institution: -3 },
  { date: '20261028', foreign: 0, institution: 0 },
  { date: '20261029', foreign: -4, institution: 8 },
  { date: '20261030', foreign: 5, institution: -1 },
  { date: '20261102', foreign: 0, institution: 0 },
  { date: '20261103', foreign: 8, institution: 2 },
  { date: '20261104', foreign: -2, institution: 4 },
];
const observations = quantities.map(row => ({
  date: row.date,
  t_ms: Date.parse(`${row.date.slice(0, 4)}-${row.date.slice(4, 6)}-${row.date.slice(6)}T00:00:00Z`),
  foreign_net_shares: row.foreign,
  institution_net_shares: row.institution,
}));
const candles = observations.map((row, i) => ({
  t_ms: row.t_ms, open: 35000 + i * 10, high: 35200 + i * 10,
  low: 34800 + i * 10, close: 35100 + i * 10, volume: 1000 + i,
}));

async function addIndicator(page: Page, name: string) {
  const panel = page.getByTestId('indicator-panel-shell');
  await panel.getByRole('button', { name: '지표 추가', exact: true }).click();
  await panel.getByRole('button', { name, exact: true }).click();
  await panel.getByRole('button', { name: '설정대로 추가', exact: true }).click();
}

async function readChart(page: Page) {
  return page.evaluate(id => {
    const chart = (window as unknown as SyncBrowser).__liveCharts.get(id);
    if (!chart) throw new Error(`Missing chart handle for ${id}`);
    return {
      id,
      owner: chart.chartElement().closest<HTMLElement>('[data-win]')?.dataset.win,
      panes: chart.panes().map(pane => ({
        series: pane.getSeries().map(series => ({
          type: series.seriesType(),
          data: series.data().map(point => ({ time: point.time, value: 'value' in point ? point.value : null })),
        })),
      })),
    };
  }, chartWindow.id);
}

test('daily bars, daily lines and cumulative lines share one strict net quantity request', async ({ page }, info) => {
  await page.setViewportSize({ width: 1600, height: 1200 });
  const requests: { endpoint: string; code: string | null; from: string | null; to: string | null; axis: string; side: string }[] = [];
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await installSyncWorkspace(page, [chartWindow], false, { D: candles, '1m': candles, W: candles, M: candles });
  // The two responses use identical raw shares so the old path can render before the request assertion fails.
  await page.route(apiExact('live/investor-daily-flow'), async route => {
    const params = new URL(route.request().url()).searchParams;
    requests.push({ endpoint: 'investor-daily-flow', code: params.get('code'), from: params.get('from'), to: params.get('to'),
      axis: params.get('axis') ?? 'qty', side: params.get('trade_side') ?? 'net' });
    const response = {
      code: params.get('code') ?? '', from: params.get('from') ?? '', to: params.get('to') ?? '',
      source: 'kiwoom_ka10059', provider_scope: 'KRX', unit: 'qty_shares', trade_side: 'net',
      observations, pagination: 'covered', unlocated_defect: false, pages_observed: 1, can_continue: false, data_warnings: [],
    } satisfies InvestorDailyFlowResponse;
    await route.fulfill({ json: response });
  });
  await page.route(apiExact('live/past-investor-net'), async route => {
    const params = new URL(route.request().url()).searchParams;
    requests.push({ endpoint: 'past-investor-net', code: params.get('code'), from: params.get('from'), to: params.get('to'),
      axis: params.get('axis') ?? 'qty', side: params.get('trade_side') ?? 'net' });
    await route.fulfill({ json: {
      code: params.get('code'), from: params.get('from'), to: params.get('to'), unit: 'qty_shares', trade_side: 'net',
      points: observations.map(row => ({ t_ms: row.t_ms, foreign_net: row.foreign_net_shares, institution_net: row.institution_net_shares })),
      cached_batches: [], fresh_batches: [], data_warnings: [],
    } });
  });
  const owner = page.locator(`[data-win="${chartWindow.id}"]`);
  await owner.getByTestId('live-indicators-button').click();
  for (const label of ['외국인 순매수량', '기관 순매수량', '외국인·기관 순매수 라인', '외국인 누적 순매수', '기관 누적 순매수']) {
    await addIndicator(page, label);
  }
  await page.getByTestId('indicator-panel-shell').getByRole('button', { name: '닫기', exact: true }).click();
  await verifySyncChart(page, chartWindow);
  await expect.poll(async () => (await readChart(page)).panes.slice(1).flatMap(pane => pane.series)
    .filter(series => series.type === 'Line' && series.data.some(point => point.value !== null)).length).toBe(4);
  const chart = await readChart(page);
  expect(chart.owner).toBe(chartWindow.id);
  const histograms = chart.panes.flatMap(pane => pane.series).filter(series => series.type === 'Histogram');
  const lines = chart.panes.flatMap(pane => pane.series).filter(series => series.type === 'Line');
  const values = (series: (typeof lines)[number]) => series.data.map(point => point.value);
  expect(histograms.map(values)).toEqual(expect.arrayContaining([
    quantities.map(row => row.foreign), quantities.map(row => row.institution),
  ]));
  expect(lines.map(values)).toEqual(expect.arrayContaining([
    quantities.map(row => row.foreign), quantities.map(row => row.institution),
    [0, 10, 10, 6, 11, 11, 19, 17], [0, -3, -3, 5, 4, 4, 6, 10],
  ]));
  await info.attach('actual chart handles and API requests', {
    body: JSON.stringify({ boundary: 'mocked investor and candle APIs; real workspace, indicators and chart series', requests, chart, errors }, null, 2),
    contentType: 'application/json',
  });
  await page.screenshot({ path: info.outputPath('shared-investor-flow.png') });
  expect(errors.filter(error => error !== 'ResizeObserver loop completed with undelivered notifications.')).toEqual([]);
  expect(requests.filter(request => request.endpoint === 'past-investor-net')).toEqual([]);
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ endpoint: 'investor-daily-flow', code: chartWindow.code, axis: 'qty', side: 'net' });
});
