import { netQuantityEnvelope } from './helpers/investorFlow';
import { test, expect, type Page } from '@playwright/test';
import type { IChartApi } from 'lightweight-charts';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { installLiveMocks } from './helpers/liveMocks';
import { apiExact } from './helpers/apiRoutes';

type ChartWindow = Window & { __liveCharts: Map<string, IChartApi> };
const label = '외국인·기관 순매수 라인';
const preview = resolve(process.cwd(), '../.audit/preview');
const days = Array.from({ length: 80 }, (_, i) => Date.UTC(2026, 1, 5 + i)).filter(t => ![0, 6].includes(new Date(t).getUTCDay()));
const candles = days.map((t_ms, i) => ({ t_ms, open: 35000 + i * 25, high: 35300 + i * 25,
  low: 34700 + i * 25, close: 35000 + i * 25 + Math.sin(i * .7) * 200, volume: 100000 + i * 2500 }));
const quantities = candles.map((c, i) => ({ t_ms: c.t_ms, foreign_net: Math.round(Math.sin(i * .4) * 800000), institution_net: Math.round(Math.cos(i * .32) * 500000) }));
async function chartState(page: Page) {
  return page.evaluate(() => [...(window as unknown as ChartWindow).__liveCharts.entries()].map(([id, chart]) => ({ id,
    panes: chart.panes().map(pane => ({ height: pane.getHeight(), series: pane.getSeries().map(series => ({
      type: series.seriesType(), options: series.options(), data: series.data(),
    })) })),
  })));
}
async function hoverCandle(page: Page, index: number) {
  const point = await page.evaluate(index => {
    const chart = [...(window as unknown as ChartWindow).__liveCharts.values()][0];
    const candle = chart.panes()[0].getSeries().find(s => s.seriesType() === 'Candlestick')!;
    const bounds = chart.chartElement().getBoundingClientRect();
    return { x: bounds.x + chart.timeScale().timeToCoordinate(candle.data()[index].time)!, y: bounds.y + chart.panes()[0].getHeight() / 2 };
  }, index);
  await page.mouse.move(point.x, point.y);
}

async function setup(page: Page, source: { unit: string; code: string }, requests: string[]) {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.clock.setFixedTime(new Date('2026-05-28T17:00:00+09:00'));
  await installLiveMocks(page);
  await page.routeWebSocket(/\/api\/ws/, () => {});
  await page.route(apiExact('live/past-daily-candles'), r => {
    const p = new URL(r.request().url()).searchParams;
    return r.fulfill({ json: { code: p.get('code'), from: p.get('from'), to: p.get('to'), candles,
      cached_batches: [], fresh_batches: [], data_warnings: [] } });
  });
  await page.route(apiExact('live/past-investor-net'), r => {
    requests.push(r.request().url());
    const p = new URL(r.request().url()).searchParams;
    const side = p.get('trade_side');
    const points = quantities.filter((_, i) => i !== 35 && i !== quantities.length - 1).map(point => side === 'net' ? point
      : { ...point, foreign_net: 9900000, institution_net: 8800000 });
    return r.fulfill({ json: { code: p.get('code'), from: p.get('from'), to: p.get('to'), unit: source.unit, trade_side: side,
      ...(side === 'net' && source.unit === 'qty_shares' ? netQuantityEnvelope(p, points) : {}),
      points, cached_batches: [], fresh_batches: [], data_warnings: [] } });
  });
  await page.goto(`/live?code=${source.code}`);
  await expect(page.getByTestId('live-chart-root').first()).toBeVisible();
  await page.getByRole('button', { name: '일', exact: true }).first().click();
  const maximize = page.getByRole('button', { name: '창 최대화', exact: true });
  if (await maximize.count()) await maximize.first().click();
  await page.getByTestId('live-indicators-button').first().click();
}
async function add(page: Page, name: string) {
  const panel = page.getByTestId('indicator-panel-shell');
  await panel.getByRole('button', { name: '지표 추가', exact: true }).click();
  await panel.getByRole('button', { name, exact: true }).click();
  await panel.getByRole('button', { name: '설정대로 추가', exact: true }).click();
}

test('daily lines retain signed values independently of bars, restore styles and support repeated instances', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  const requests: string[] = [];
  await setup(page, { unit: 'qty_shares', code: '098460' }, requests);
  await add(page, '외국인 순매수량');
  const panel = page.getByTestId('indicator-panel-shell');
  await panel.getByRole('combobox', { name: '투자자 매매 기준' }).selectOption('buy');
  await add(page, '기관 순매수량');
  await panel.getByRole('combobox', { name: '투자자 매매 기준' }).selectOption('sell');
  await add(page, label);
  await panel.getByRole('combobox', { name: '순매수 라인 공통 선 두께' }).selectOption('3');
  await panel.getByRole('button', { name: '닫기', exact: true }).click();
  const chip = page.getByTestId('pane-chip-investor-net-line');
  await expect(chip).toHaveText(label);
  await expect.poll(async () => (await chartState(page))[0].panes.filter(p => p.series.filter(s => s.type === 'Line').length === 2).length).toBe(1);
  let state = (await chartState(page))[0];
  const linePane = state.panes.find(p => p.series.filter(s => s.type === 'Line').length === 2)!;
  const lines = linePane.series.filter(s => s.type === 'Line');
  expect(lines[0].data.filter(p => 'value' in p).map(p => 'value' in p ? p.value : null)).toEqual(quantities.filter((_, i) => i !== 35 && i !== quantities.length - 1).map(p => p.foreign_net));
  expect(lines[1].data.filter(p => 'value' in p).map(p => 'value' in p ? p.value : null)).toEqual(quantities.filter((_, i) => i !== 35 && i !== quantities.length - 1).map(p => p.institution_net));
  expect(lines[0].data[34]).toHaveProperty('color', 'rgba(0,0,0,0)');
  expect(lines[0].data).toHaveLength(quantities.length - 2);
  expect(lines[0].options).toHaveProperty('lineWidth', 3);
  expect(state.panes.flatMap(p => p.series).filter(s => s.type === 'Histogram').some(s => s.data.some(p => 'value' in p && p.value === 9900000))).toBe(true);
  expect(state.panes.flatMap(p => p.series).filter(s => s.type === 'Histogram').some(s => s.data.some(p => 'value' in p && p.value === 8800000))).toBe(true);
  await expect(page.getByTestId('pane-legend-rows-investor-net-line')).toContainText('외국인(주)');
  await expect(page.getByText('외국인(주)', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('기관(주)', { exact: true }).first()).toBeVisible();
  await expect(page.getByTestId('chart-reveal-cover').first()).toHaveCSS('opacity', '0');
  const hover = await page.evaluate(() => {
    const chart = [...(window as unknown as ChartWindow).__liveCharts.values()][0];
    const bounds = chart.chartElement().getBoundingClientRect();
    const time = chart.panes().find(p => p.getSeries().filter(s => s.seriesType() === 'Line').length === 2)!.getSeries()[0].data().at(-1)!.time;
    return { x: bounds.x + chart.timeScale().timeToCoordinate(time)!, y: bounds.y + chart.panes()[0].getHeight() / 2 };
  });
  await page.mouse.move(hover.x, hover.y);
  await expect(page.getByTestId('pane-legend-rows-investor-net-line')).not.toContainText('—');
  mkdirSync(preview, { recursive: true });
  await page.screenshot({ path: resolve(preview, 'investor-netbuy-lines.png') });
  writeFileSync(resolve(preview, 'investor-netbuy-lines.json'), JSON.stringify({ synthetic: true, boundary: 'mocked daily candle and investor APIs', chart: state, requests, errors }, null, 2));
  console.log(`PREVIEW_READY ${resolve(preview, 'investor-netbuy-lines.png')} synthetic=true`);
  await info.attach('actual UI with synthetic API data', { path: resolve(preview, 'investor-netbuy-lines.png'), contentType: 'image/png' });
  await page.reload();
  await expect(chip).toHaveText(label);
  await expect.poll(async () => (await chartState(page))[0].panes.flatMap(p => p.series).filter(s => s.type === 'Line' && 'lineWidth' in s.options && s.options.lineWidth === 3).length).toBe(2);
  await page.getByTestId('live-indicators-button').first().click();
  await panel.getByRole('button', { name: label, exact: true }).click();
  await panel.getByRole('switch', { name: '순매수 라인 기관 표시' }).click();
  await panel.getByRole('button', { name: '설정 복사해서 추가', exact: true }).click();
  await panel.getByRole('combobox', { name: '순매수 라인 공통 선 두께' }).selectOption('1');
  await panel.getByRole('button', { name: '설정대로 추가', exact: true }).click();
  await panel.getByRole('button', { name: '닫기', exact: true }).click();
  await expect.poll(async () => (await chartState(page))[0].panes.filter(p => p.series.filter(s => s.type === 'Line').length === 2).length).toBe(2);
  state = (await chartState(page))[0];
  expect(state.panes.filter(p => p.series.filter(s => s.type === 'Line').length === 2).flatMap(p => p.series).filter(s => s.options.visible === false)).toHaveLength(2);
  const duplicateLegend = page.getByTestId(/^indicator-instance-legend-/);
  await expect(duplicateLegend).toContainText('외국인(주)');
  await expect(duplicateLegend).not.toContainText('기관(주)');
  await hoverCandle(page, 20);
  await expect(page.getByTestId('pane-legend-rows-investor-net-line')).toContainText('791K');
  await expect(duplicateLegend).toContainText('외국인(주) 791K');
  await hoverCandle(page, 35);
  await expect(page.getByTestId('pane-legend-rows-investor-net-line')).toContainText('—');
  await expect(duplicateLegend).toContainText('외국인(주) —');
  await page.reload();
  await expect.poll(async () => (await chartState(page))[0].panes.filter(p => p.series.filter(s => s.type === 'Line').length === 2).length).toBe(2);
  for (const period of ['주', '월'] as const) {
    await page.getByRole('button', { name: period, exact: true }).first().click();
    await expect(chip).toHaveCount(0);
    await page.getByRole('button', { name: '일', exact: true }).first().click();
    await expect(chip).toHaveCount(1);
  }
  await page.getByTestId('live-indicators-button').first().click();
  await panel.getByRole('button', { name: `${label} 2 설정`, exact: true }).click();
  await panel.getByRole('button', { name: '삭제', exact: true }).click();
  await panel.getByRole('button', { name: '닫기', exact: true }).click();
  await expect.poll(async () => (await chartState(page))[0].panes.filter(p => p.series.filter(s => s.type === 'Line').length === 2).length).toBe(1);
  await page.getByRole('button', { name: `${label} 지표 끄기`, exact: true }).click();
  await expect(chip).toHaveCount(0);
  expect(requests.some(url => url.includes('trade_side=net') && url.includes('axis=qty'))).toBe(true);
  expect(requests.some(url => url.includes('trade_side=buy'))).toBe(true);
  expect(requests.some(url => url.includes('trade_side=sell'))).toBe(true);
  expect(errors.filter(e => e !== 'ResizeObserver loop completed with undelivered notifications.')).toEqual([]);
});

test('alphanumeric domestic Code works and amount responses never render as shares', async ({ page }) => {
  const requests: string[] = [];
  await setup(page, { unit: 'amt_mwon', code: '00088K' }, requests);
  await add(page, label);
  await page.getByTestId('indicator-panel-shell').getByRole('button', { name: '닫기', exact: true }).click();
  await expect.poll(() => requests.length).toBeGreaterThan(0);
  await expect.poll(async () => (await chartState(page))[0].panes.filter(p => p.series.filter(s => s.type === 'Line').length === 2).length).toBe(1);
  const lines = (await chartState(page))[0].panes.find(p => p.series.filter(s => s.type === 'Line').length === 2)!.series;
  expect(lines.every(s => s.data.every(p => !('value' in p)))).toBe(true);
  expect(requests.every(url => url.includes('code=00088K') && url.includes('trade_side=net'))).toBe(true);
});


test('stock lines disappear on unsupported minute and overseas charts and stay out of their catalog', async ({ page }) => {
  const requests: string[] = [];
  await setup(page, { unit: 'qty_shares', code: '098460' }, requests);
  await add(page, label);
  const panel = page.getByTestId('indicator-panel-shell');
  await panel.getByRole('button', { name: '닫기', exact: true }).click();
  await page.getByRole('button', { name: /분봉으로 전환/ }).first().click();
  await expect(page.getByTestId('pane-chip-investor-net-line')).toHaveCount(0);
  await page.getByTestId('live-indicators-button').first().click();
  await panel.getByRole('button', { name: '지표 추가', exact: true }).click();
  await expect(panel.getByRole('button', { name: label, exact: true })).toHaveCount(0);
  await panel.getByRole('button', { name: '닫기', exact: true }).click();
  requests.length = 0;
  await page.goto('/live?market=US&exchange=NASDAQ&symbol=NVDA');
  await expect(page.getByTestId('live-chart-root').first()).toBeVisible();
  await expect(page.getByTestId('pane-chip-investor-net-line')).toHaveCount(0);
  await page.getByTestId('live-indicators-button').first().click();
  await panel.getByRole('button', { name: '지표 추가', exact: true }).click();
  await expect(panel.getByRole('button', { name: label, exact: true })).toHaveCount(0);
  expect(requests).toEqual([]);
});
