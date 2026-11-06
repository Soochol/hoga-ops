import { expect, test, type Page } from '@playwright/test';
import type { IChartApi } from 'lightweight-charts';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { installLiveMocks } from './helpers/liveMocks';
import { apiExact } from './helpers/apiRoutes';
import { hoverSyncChart, installSyncWorkspace, loadSyncDriver, syncBus, verifySyncChart, type SyncFixtures, type SyncWindow } from './helpers/tooltipCrosshair';
import { formatKoreanK } from '../../src/util/koreanNumber';

type HoldingsMode = 'normal' | 'error' | 'wrong-code' | 'soft-empty' | 'soft-unavailable' | 'complete-empty' | 'explicit-null';
type ChartWindow = Window & { __liveCharts: Map<string, IChartApi> };
const label = '외국인 보유';
const preview = resolve(process.cwd(), '../.audit/preview');
const days = Array.from({ length: 80 }, (_, i) => Date.UTC(2026, 1, 5 + i)).filter(t => ![0, 6].includes(new Date(t).getUTCDay()));
const candles = days.map((t_ms, i) => ({ t_ms, open: 35000 + i * 25, high: 35300 + i * 25,
  low: 34700 + i * 25, close: 35000 + i * 25 + Math.sin(i * .7) * 200, volume: 100000 + i * 2500 }));
const observations = candles.map((c, i) => ({ date: new Date(c.t_ms).toISOString().slice(0, 10).replaceAll('-', ''), t_ms: c.t_ms,
  quantity_shares: i === 20 ? 0 : 6_000_000 + i * 1000, ratio_pct: i === 20 ? 0 : 26 + i / 100 })).filter((_, i) => i !== 35 && i !== candles.length - 1);
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
async function hoverVisibleHolding(page: Page) {
  await page.waitForFunction(() => {
    const chart = [...(window as unknown as ChartWindow).__liveCharts.values()][0];
    const difference = chart.chartElement().getBoundingClientRect().width - chart.timeScale().width();
    return difference >= 0 && difference < 200;
  });
  const index = await page.evaluate(() => {
    const chart = [...(window as unknown as ChartWindow).__liveCharts.values()][0];
    const candle = chart.panes()[0].getSeries().find(series => series.seriesType() === 'Candlestick')!;
    const points = candle.data();
    const visible = points.map((point, i) => ({ i, x: chart.timeScale().timeToCoordinate(point.time) }))
      .filter(point => point.x !== null && point.x > 30 && point.x < chart.timeScale().width() - 30 && point.i !== 20 && point.i !== 35 && point.i < points.length - 1);
    return visible[Math.floor(visible.length / 2)].i;
  });
  await page.mouse.move(2, 2);
  await hoverCandle(page, index);
  await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
  return index;
}
async function setup(page: Page, requests: string[], mode: { value: HoldingsMode }) {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.clock.setFixedTime(new Date('2026-05-28T17:00:00+09:00'));
  await installLiveMocks(page);
  await page.routeWebSocket(/\/api\/ws/, () => {});
  await page.route(apiExact('live/past-daily-candles'), r => {
    const p = new URL(r.request().url()).searchParams;
    return r.fulfill({ json: { code: p.get('code'), from: p.get('from'), to: p.get('to'), candles,
      cached_batches: [], fresh_batches: [], data_warnings: [] } });
  });
  await page.route(apiExact('live/investor-holdings'), r => {
    requests.push(r.request().url());
    if (mode.value === 'error') return r.fulfill({ status: 503, json: { detail: 'synthetic unavailable' } });
    const p = new URL(r.request().url()).searchParams;
    return r.fulfill({ json: { code: mode.value === 'wrong-code' ? '005930' : p.get('code'), from: p.get('from'), to: p.get('to'),
      source: 'kiwoom_ka10008', provider_scope: 'KRX', institution_supported: false,
      observations: mode.value.startsWith('soft-') || mode.value === 'complete-empty' ? [] : mode.value === 'explicit-null' ? observations.map(point => ({ ...point, quantity_shares: null, ratio_pct: null })) : observations,
      oldest_observed_date: observations[0].date, latest_observed_date: observations.at(-1)!.date,
      pages_observed: 2, pagination_complete: mode.value === 'complete-empty', exhausted: mode.value === 'complete-empty', partial: mode.value !== 'complete-empty',
      data_warnings: mode.value === 'complete-empty' ? [] : mode.value.startsWith('soft-') ? [{ reason: mode.value === 'soft-unavailable' ? 'unavailable' : 'api_error', message: '합성 응답 · 자료 조회 미완료' }] : [{ reason: 'page_budget', message: '합성 경계 자료 · 조회 범위 일부' }] } });
  });
  await page.goto('/live?code=098460');
  await expect(page.getByTestId('live-chart-root').first()).toBeVisible();
  await page.getByRole('button', { name: '일', exact: true }).first().click();
  const maximize = page.getByRole('button', { name: '창 최대화', exact: true });
  if (await maximize.count()) await maximize.first().click();
  await page.getByTestId('live-indicators-button').first().click();
  const panel = page.getByTestId('indicator-panel-shell');
  await panel.getByRole('button', { name: '지표 추가', exact: true }).click();
  await panel.getByRole('button', { name: label, exact: true }).click();
}
const holdingsLines = async (page: Page) => (await chartState(page))[0].panes.flatMap(p => p.series).filter(s => s.type === 'Line' && 'color' in s.options && ['#EC4899', '#F97316'].includes(String(s.options.color)));

test('actual holdings units, gaps, independent instances, styles and saved settings through real UI', async ({ page }, info) => {
  const requests: string[] = [], errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await setup(page, requests, { value: 'normal' });
  const panel = page.getByTestId('indicator-panel-shell');
  await expect(panel.getByRole('switch', { name: '보유 기관 표시 · 미지원' })).toHaveCount(0);
  await panel.getByRole('button', { name: '설정대로 추가', exact: true }).click();
  await panel.getByRole('combobox', { name: '보유 공통 선 두께' }).selectOption('3');
  await panel.getByRole('button', { name: '보유 외국인 선택' }).click();
  await page.getByRole('button', { name: '보유 외국인 #F97316', exact: true }).click();
  await panel.getByRole('button', { name: '닫기', exact: true }).click();
  const legend = page.getByTestId('pane-legend-rows-investor-holdings');
  await expect.poll(async () => (await holdingsLines(page)).length).toBe(1);
  await expect(legend).toContainText('일부 자료');
  await expect(legend).toContainText('기관 미지원');
  let line = (await holdingsLines(page))[0];
  expect(line.options).toHaveProperty('lineWidth', 3);
  expect(line.options).toHaveProperty('color', '#F97316');
  expect(line.data.filter(p => 'value' in p).map(p => 'value' in p ? p.value : null)).toEqual(observations.map(p => p.quantity_shares));
  expect(line.data[34]).toHaveProperty('color', 'rgba(0,0,0,0)');
  await hoverCandle(page, 20);
  await expect(legend).toContainText('0K주');
  await hoverCandle(page, 35);
  await expect(legend).toContainText('—');
  const before = requests.length;
  await legend.getByRole('button', { name: '보유 자료 다시 조회' }).click();
  await expect.poll(() => requests.length).toBeGreaterThan(before);
  await page.getByTestId('live-indicators-button').first().click();
  await panel.getByRole('button', { name: label, exact: true }).click();
  await panel.getByRole('combobox', { name: '보유 기준' }).selectOption('ratio');
  await panel.getByRole('button', { name: '설정 복사해서 추가', exact: true }).click();
  await panel.getByRole('combobox', { name: '보유 기준' }).selectOption('quantity');
  await panel.getByRole('combobox', { name: '보유 공통 선 두께' }).selectOption('1');
  await panel.getByRole('button', { name: '설정대로 추가', exact: true }).click();
  await panel.getByRole('button', { name: '닫기', exact: true }).click();
  await expect.poll(async () => (await holdingsLines(page)).length).toBe(2);
  await page.getByTestId('live-indicators-button').first().click();
  await panel.getByRole('button', { name: label, exact: true }).click();
  await panel.getByRole('combobox', { name: '보유 기준' }).selectOption('quantity');
  await panel.getByRole('button', { name: '닫기', exact: true }).click();
  await expect.poll(async () => (await chartState(page))[0].panes.filter(pane => pane.series.some(series => series.type === 'Line' && 'color' in series.options && series.options.color === '#F97316')).length).toBe(2);
  await page.getByTestId('live-indicators-button').first().click();
  await panel.getByRole('button', { name: label, exact: true }).click();
  await panel.getByRole('combobox', { name: '보유 기준' }).selectOption('ratio');
  await panel.getByRole('button', { name: '닫기', exact: true }).click();
  await expect.poll(async () => (await chartState(page))[0].panes.filter(pane => pane.series.some(series => series.type === 'Line' && 'color' in series.options && series.options.color === '#F97316')).length).toBe(2);
  const lines = await holdingsLines(page);
  expect(lines[0].options.priceFormat.minMove).toBe(.01);
  expect(lines[1].options.priceFormat.minMove).toBe(1);
  expect(lines[0].data.filter(p => 'value' in p).map(p => 'value' in p ? p.value : null)).toEqual(observations.map(p => p.ratio_pct));
  expect(lines[1].data.filter(p => 'value' in p).map(p => 'value' in p ? p.value : null)).toEqual(observations.map(p => p.quantity_shares));
  await hoverCandle(page, 21);
  await expect(legend).toContainText('26.21%');
  const duplicate = page.getByTestId(/^indicator-instance-legend-/);
  await expect(duplicate).toContainText('외국인(주)');
  await hoverCandle(page, 35);
  await expect(duplicate).toContainText('외국인(주) —');
  await hoverCandle(page, 21);
  await expect(legend).toContainText('26.21%');
  mkdirSync(preview, { recursive: true });
  await page.screenshot({ path: resolve(preview, 'investor-holdings.png') });
  writeFileSync(resolve(preview, 'investor-holdings.json'), JSON.stringify({ synthetic: true, boundary: 'external holdings and daily candle APIs', chart: await chartState(page), requests, errors }, null, 2));
  await info.attach('actual UI with synthetic external holdings', { path: resolve(preview, 'investor-holdings.png'), contentType: 'image/png' });
  await page.getByTestId('live-indicators-button').first().click();
  await panel.getByRole('button', { name: label, exact: true }).click();
  await panel.screenshot({ path: resolve(preview, 'investor-holdings-settings.png') });
  await panel.getByRole('button', { name: '닫기', exact: true }).click();
  const windowId = await page.evaluate(() => [...(window as unknown as ChartWindow).__liveCharts.keys()][0]);
  const frame = page.locator(`[data-win="${windowId}"]`);
  await frame.getByRole('button', { name: '원래 크기로 복원', exact: true }).click();
  const bounds = (await frame.boundingBox())!;
  const handle = (await frame.locator('[data-handle="e"]').boundingBox())!;
  const resizeX = handle.x + handle.width / 2, resizeY = handle.y + handle.height / 2;
  await page.mouse.move(resizeX, resizeY);
  await page.mouse.down();
  await page.mouse.move(resizeX + 700 - bounds.width, resizeY, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => (await frame.boundingBox())!.width).toBeCloseTo(700, 0);
  const narrowIndex = await hoverVisibleHolding(page);
  await expect(legend).toContainText(`${(26 + narrowIndex / 100).toFixed(2)}%`);
  await expect(legend.getByRole('button', { name: '보유 자료 다시 조회' })).toBeInViewport();
  await expect(legend.getByRole('button', { name: `${label} 지표 끄기` })).toBeInViewport();
  const noticeFits = await legend.getByRole('status').evaluate(node => {
    const range = document.createRange();
    range.selectNodeContents(node);
    return range.getBoundingClientRect().right <= node.closest('[data-testid]')!.getBoundingClientRect().right + 1;
  });
  expect(noticeFits).toBe(true);
  await frame.screenshot({ path: resolve(preview, 'investor-holdings-window-700.png') });
  writeFileSync(resolve(preview, 'investor-holdings-window-700.json'), JSON.stringify(await frame.evaluate(node => ({
    frame: node.getBoundingClientRect().toJSON(),
    legends: [...node.querySelectorAll('[data-testid="pane-legend-rows-investor-holdings"], [data-testid^="indicator-instance-legend-"]')].map(legend => ({ text: legend.textContent, rect: legend.getBoundingClientRect().toJSON() })),
  })), null, 2));
  await frame.getByRole('button', { name: '창 최대화', exact: true }).click();
  await page.reload();
  await expect.poll(async () => (await holdingsLines(page)).length).toBe(2);
  await expect(legend).toContainText('외국인(%)');
  await page.getByTestId('live-indicators-button').first().click();
  await panel.getByRole('button', { name: `${label} 2 설정`, exact: true }).click();
  await panel.getByRole('button', { name: `${label} 2 숨기기`, exact: true }).click();
  await expect.poll(async () => (await holdingsLines(page)).length).toBe(1);
  await panel.getByRole('button', { name: `${label} 2 표시`, exact: true }).click();
  await panel.getByRole('button', { name: '삭제', exact: true }).click();
  await panel.getByRole('button', { name: '닫기', exact: true }).click();
  await expect.poll(async () => (await holdingsLines(page)).length).toBe(1);
  await page.getByRole('button', { name: '주', exact: true }).first().click();
  await expect(page.getByTestId('pane-chip-investor-holdings')).toHaveCount(0);
  await page.getByTestId('live-indicators-button').first().click();
  await panel.getByRole('button', { name: '지표 추가', exact: true }).click();
  await panel.getByRole('button', { name: label, exact: true }).click();
  await expect(panel.getByRole('button', { name: '설정대로 추가' })).toBeDisabled();
  expect(errors.filter(e => !e.startsWith('ResizeObserver loop'))).toEqual([]);
});

test('failed or mismatched responses never borrow holdings, unsupported assets never query', async ({ page }) => {
  const requests: string[] = [];
  const mode: { value: HoldingsMode } = { value: 'wrong-code' };
  await setup(page, requests, mode);
  const panel = page.getByTestId('indicator-panel-shell');
  await panel.getByRole('button', { name: '설정대로 추가', exact: true }).click();
  await panel.getByRole('button', { name: '닫기', exact: true }).click();
  await expect.poll(() => requests.length).toBeGreaterThan(0);
  await expect.poll(async () => (await holdingsLines(page)).every(s => s.data.every(p => !('value' in p)))).toBe(true);
  mode.value = 'error';
  await page.getByRole('button', { name: '보유 자료 다시 조회' }).first().click();
  await page.clock.runFor(15_000);
  await expect(page.getByTestId('pane-legend-rows-investor-holdings')).toContainText('조회 실패');
  await page.getByRole('button', { name: /분봉으로 전환/ }).first().click();
  await expect(page.getByTestId('pane-chip-investor-holdings')).toHaveCount(0);
  requests.length = 0;
  await page.goto('/live?market=US&exchange=NASDAQ&symbol=NVDA');
  await expect(page.getByTestId('live-chart-root').first()).toBeVisible();
  await page.getByTestId('live-indicators-button').first().click();
  await panel.getByRole('button', { name: '지표 추가', exact: true }).click();
  await panel.getByRole('button', { name: label, exact: true }).click();
  await expect(panel.getByRole('button', { name: '설정대로 추가' })).toBeDisabled();
  expect(requests).toEqual([]);
});


test('holdings exact-date legends sync between independent units and survive resize and reload', async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1800, height: 1100 });
  const windows: SyncWindow[] = [
    { id: 's', timeframe: 'D', code: '098460', group: 1, tooltip: false },
    { id: 'd', timeframe: 'D', code: '098460', group: 1, tooltip: false },
  ];
  const fixtures: SyncFixtures = { D: candles, '1m': candles, W: candles, M: candles };
  await installSyncWorkspace(page, windows, false, fixtures);
  const requests: string[] = [];
  await page.route(apiExact('live/investor-holdings'), route => {
    requests.push(route.request().url());
    const params = new URL(route.request().url()).searchParams;
    return route.fulfill({ json: {
      code: params.get('code'), from: params.get('from'), to: params.get('to'),
      source: 'kiwoom_ka10008', provider_scope: 'KRX', institution_supported: false, observations,
      oldest_observed_date: observations[0].date, latest_observed_date: observations.at(-1)!.date,
      pages_observed: 1, pagination_complete: true, exhausted: true, partial: false, data_warnings: [],
    } });
  });
  await expect(page.getByTestId('pane-legend-rows-investor-holdings')).toHaveCount(0);
  expect(requests).toEqual([]);
  const panel = page.getByTestId('indicator-panel-shell');
  for (const [index, metric] of ['quantity', 'ratio'].entries()) {
    const root = page.locator(`[data-win="${windows[index].id}"]`);
    await root.getByTestId('live-indicators-button').click();
    await panel.getByRole('button', { name: '지표 추가', exact: true }).click();
    await panel.getByRole('button', { name: label, exact: true }).click();
    await panel.getByRole('combobox', { name: '보유 기준' }).selectOption(metric);
    await panel.getByRole('button', { name: '설정대로 추가', exact: true }).click();
    await panel.getByRole('button', { name: '닫기', exact: true }).click();
    await expect(root.getByTestId('pane-legend-rows-investor-holdings')).toContainText(metric === 'quantity' ? '외국인(주)' : '외국인(%)');
  }
  const source = page.locator('[data-win="s"]').getByTestId('pane-legend-rows-investor-holdings');
  const target = page.locator('[data-win="d"]').getByTestId('pane-legend-rows-investor-holdings');
  const validIndex = 40;
  const valid = observations.find(point => point.t_ms === candles[validIndex].t_ms)!;
  for (const resized of [false, true]) {
    if (resized) await page.setViewportSize({ width: 1600, height: 1000 });
    await expect.poll(async () => { await hoverSyncChart(page, windows[0], 0, false, candles[validIndex].t_ms); return (await syncBus(page)).ms; }).toBe(candles[validIndex].t_ms);
    await expect.poll(async () => (await syncBus(page)).origin?.windowId).toBe('s');
    expect((await syncBus(page)).origin).toMatchObject({ group: 1, code: '098460', timeframe: 'D' });
    await expect(source).toContainText(`외국인(주)${formatKoreanK(valid.quantity_shares)}주`);
    await expect(target).toContainText(`외국인(%)${valid.ratio_pct.toFixed(2)}%`);
    await expect.poll(async () => { await hoverSyncChart(page, windows[0], 0, false, candles[35].t_ms); return (await syncBus(page)).ms; }).toBe(candles[35].t_ms);
    await expect(source).toContainText('외국인(주)—');
    await expect(target).toContainText('외국인(%)—');
  }
  await page.reload();
  await loadSyncDriver(page);
  for (const win of windows) await verifySyncChart(page, win);
  await expect(source).toContainText('외국인(주)');
  await expect(target).toContainText('외국인(%)');
  await expect.poll(async () => { await hoverSyncChart(page, windows[0], 0, false, candles[validIndex].t_ms); return (await syncBus(page)).ms; }).toBe(candles[validIndex].t_ms);
  await expect.poll(async () => (await syncBus(page)).origin?.windowId).toBe('s');
  await expect(source).toContainText(`외국인(주)${formatKoreanK(valid.quantity_shares)}주`);
  await expect(target).toContainText(`외국인(%)${valid.ratio_pct.toFixed(2)}%`);
});


test('soft empty responses retain known holdings, complete empty and dated nulls replace them', async ({ page }) => {
  const requests: string[] = [];
  const mode: { value: HoldingsMode } = { value: 'normal' };
  await setup(page, requests, mode);
  const panel = page.getByTestId('indicator-panel-shell');
  await panel.getByRole('button', { name: '설정대로 추가', exact: true }).click();
  await panel.getByRole('button', { name: '닫기', exact: true }).click();
  const legend = page.getByTestId('pane-legend-rows-investor-holdings');
  await expect.poll(async () => (await holdingsLines(page))[0].data.filter(point => 'value' in point).length).toBe(observations.length);
  const values = async () => (await holdingsLines(page))[0].data.filter(point => 'value' in point).map(point => 'value' in point ? point.value : null);
  const known = await values();
  for (const value of ['soft-empty', 'soft-unavailable'] as const) {
    mode.value = value;
    await legend.getByRole('button', { name: '보유 자료 다시 조회' }).click();
    await expect(legend).toContainText('합성 응답 · 자료 조회 미완료');
    await expect(legend).toContainText('확인된 자료 유지');
    await expect(legend).not.toContainText('해당 구간 자료 없음');
    expect(await values()).toEqual(known);
  }
  mode.value = 'explicit-null';
  await legend.getByRole('button', { name: '보유 자료 다시 조회' }).click();
  await expect.poll(values).toEqual([]);
  mode.value = 'normal';
  await legend.getByRole('button', { name: '보유 자료 다시 조회' }).click();
  await expect.poll(values).toEqual(known);
  mode.value = 'complete-empty';
  await legend.getByRole('button', { name: '보유 자료 다시 조회' }).click();
  await expect(legend).toContainText('해당 구간 자료 없음');
  await expect.poll(values).toEqual([]);
});
