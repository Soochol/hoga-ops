import { expect, test, type Page } from '@playwright/test';
import type { IChartApi } from 'lightweight-charts';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { InvestorNetPoint } from '../../src/api/types';
import { apiExact } from './helpers/apiRoutes';
import { installLiveMocks } from './helpers/liveMocks';

const preview = resolve(process.cwd(), '../.audit/preview/pane-legend-values');
const days = Array.from({ length: 80 }, (_, index) => Date.UTC(2026, 1, 5 + index))
  .filter(time => ![0, 6].includes(new Date(time).getUTCDay()));
const candles = days.map((t_ms, index) => ({ t_ms, open: 35000 + index * 25,
  high: 35400 + index * 25, low: 34700 + index * 25, close: 35100 + index * 25,
  volume: 100000 + index * 2500 }));
const gapIndex = 25;
const quantities: InvestorNetPoint[] = candles.map(({ t_ms }, index) => ({ t_ms,
  foreign_net: index === 22 ? 0 : index % 2 === 0 ? 123000 + index * 1000 : -234000 - index * 1000,
  institution_net: index === 22 ? 0 : index % 2 === 0 ? -345000 - index * 1000 : 456000 + index * 1000,
}));
const formatQuantity = (value: number | null) => value === null ? '—' : `${Math.round(value / 1000).toLocaleString('ko-KR')}K`;

async function setup(page: Page, requests: string[]) {
  await page.setViewportSize({ width: 1600, height: 1100 });
  await page.clock.setFixedTime(new Date('2026-05-28T17:00:00+09:00'));
  await installLiveMocks(page);
  await page.routeWebSocket(/\/api\/ws/, () => {});
  await page.route(apiExact('live/past-daily-candles'), route => {
    const params = new URL(route.request().url()).searchParams;
    return route.fulfill({ json: { code: params.get('code'), from: params.get('from'), to: params.get('to'),
      candles, cached_batches: [], fresh_batches: [], data_warnings: [] } });
  });
  await page.route(apiExact('live/past-investor-net'), route => {
    requests.push(route.request().url());
    const params = new URL(route.request().url()).searchParams;
    const tradeSide = params.get('trade_side');
    const points = quantities.map((point, index) => tradeSide === 'buy'
      ? { ...point, foreign_net: 820000 + index * 1000, institution_net: 930000 + index * 1000 }
      : tradeSide === 'sell' ? { ...point, foreign_net: 1010000 + index * 1000, institution_net: 1040000 + index * 1000 }
      : point).filter((_, index) => index !== gapIndex);
    return route.fulfill({ json: { code: params.get('code'), from: params.get('from'), to: params.get('to'),
      unit: 'qty_shares', trade_side: tradeSide, points, cached_batches: [], fresh_batches: [], data_warnings: [] } });
  });
  await page.goto('/live?code=098460');
  await expect(page.getByTestId('live-chart-root').first()).toBeVisible();
  await page.getByRole('button', { name: '일', exact: true }).first().click();
  const maximize = page.getByRole('button', { name: '창 최대화', exact: true });
  if (await maximize.count()) await maximize.first().click();
  const frame = page.locator('[data-win]').filter({ has: page.getByTestId('live-chart-root') }).first();
  const windowId = await frame.getAttribute('data-win');
  expect(windowId).not.toBeNull();
  if (windowId === null) throw new Error('Live chart window has no stable id');
  await frame.getByTestId('live-indicators-button').click();
  const panel = page.getByTestId('indicator-panel-shell');
  for (const label of ['외국인 순매수량', '기관 순매수량']) {
    await panel.getByRole('button', { name: '지표 추가', exact: true }).click();
    await panel.getByRole('button', { name: label, exact: true }).click();
    await panel.getByRole('button', { name: '설정대로 추가', exact: true }).click();
  }
  await panel.getByRole('button', { name: '닫기', exact: true }).click();
  return windowId;
}

async function chartValues(page: Page, windowId: string, index: number) {
  return page.evaluate(async ({ windowId, index }) => {
    const charts: Map<string, IChartApi> | undefined = Reflect.get(window, '__liveCharts');
    const chart = charts?.get(windowId);
    if (!chart) throw new Error(`Chart ${windowId} is not registered`);
    const registryPath = '/src/live/indicators/paneLegendRegistry.ts';
    const registry: typeof import('../../src/live/indicators/paneLegendRegistry') = await import(registryPath);
    const candle = chart.panes().flatMap(pane => pane.getSeries()).find(series => series.seriesType() === 'Candlestick');
    const time = candle?.data()[index]?.time;
    if (typeof time !== 'number') throw new Error(`Candle ${index} is unavailable`);
    const chartSeries = chart.panes().flatMap(pane => pane.getSeries());
    return { time, series: [...(registry.usePaneLegendRegistry.getState().byScope.get(windowId) ?? [])]
      .filter(([name]) => name === 'investor-foreign' || name === 'investor-institution' || name.startsWith('indicator:'))
      .flatMap(([name, entries]) => entries.map(({ series }) => {
        const point = series.data().find(point => point.time === time);
        const last = series.data().at(-1);
        return { name, type: series.seriesType(), registeredOnChart: chartSeries.includes(series),
          value: point && 'value' in point ? point.value : null,
          latest: last && 'value' in last ? last.value : null };
      })) };
  }, { windowId, index });
}

async function hoverCandle(page: Page, windowId: string, index: number) {
  const point = await page.evaluate(({ windowId, index }) => {
    const charts: Map<string, IChartApi> | undefined = Reflect.get(window, '__liveCharts');
    const chart = charts?.get(windowId);
    if (!chart) throw new Error(`Chart ${windowId} is not registered`);
    const candle = chart.panes()[0].getSeries().find(series => series.seriesType() === 'Candlestick');
    const time = candle?.data()[index]?.time;
    if (time === undefined) throw new Error(`Candle ${index} is unavailable`);
    const x = chart.timeScale().timeToCoordinate(time);
    if (x === null) throw new Error(`Candle ${index} has no screen coordinate`);
    const bounds = chart.chartElement().getBoundingClientRect();
    return { x: bounds.x + x, y: bounds.y + chart.panes()[0].getHeight() / 2 };
  }, { windowId, index });
  await page.mouse.move(point.x, point.y);
}

test('daily investor Pane Legends read the hovered histogram, including signed zero and missing dates', async ({ page }, info) => {
  const requests: string[] = [];
  const windowId = await setup(page, requests);
  const frame = page.locator(`[data-win="${windowId}"]`);
  const foreign = frame.getByTestId('pane-legend-rows-investor-foreign');
  const institution = frame.getByTestId('pane-legend-rows-investor-institution');
  const readbacks: Awaited<ReturnType<typeof chartValues>>[] = [];
  await expect(frame.getByTestId('chart-reveal-cover')).toHaveCSS('opacity', '0');
  await expect.poll(async () => (await chartValues(page, windowId, 20)).series.length).toBe(2);
  mkdirSync(preview, { recursive: true });
  try {
    for (const index of [20, 21, 22, gapIndex]) {
      await hoverCandle(page, windowId, index);
      const readback = await chartValues(page, windowId, index);
      readbacks.push(readback);
      const expected = index === gapIndex ? null : quantities[index];
      const foreignSeries = readback.series.find(series => series.name === 'investor-foreign');
      const institutionSeries = readback.series.find(series => series.name === 'investor-institution');
      expect(foreignSeries).toMatchObject({ type: 'Histogram', registeredOnChart: true, value: expected?.foreign_net ?? null });
      expect(institutionSeries).toMatchObject({ type: 'Histogram', registeredOnChart: true, value: expected?.institution_net ?? null });
      await expect(foreign).toContainText(formatQuantity(foreignSeries?.value ?? null));
      await expect(institution).toContainText(formatQuantity(institutionSeries?.value ?? null));
      expect((await foreign.innerText()).split('외국인 순매수량')).toHaveLength(2);
      expect((await institution.innerText()).split('기관 순매수량')).toHaveLength(2);
      await page.screenshot({ path: resolve(preview, `daily-cursor-${index}.png`) });
    }
    await page.mouse.move(5, 5);
    const latest = await chartValues(page, windowId, candles.length - 1);
    await expect(foreign).toContainText(formatQuantity(latest.series.find(series => series.name === 'investor-foreign')?.latest ?? null));
    await expect(institution).toContainText(formatQuantity(latest.series.find(series => series.name === 'investor-institution')?.latest ?? null));
    expect(requests.every(url => new URL(url).searchParams.get('axis') === 'qty')).toBe(true);
  } finally {
    const screenshot = resolve(preview, 'daily-cursor-result.png');
    await page.screenshot({ path: screenshot });
    writeFileSync(resolve(preview, 'daily-cursor.json'), JSON.stringify({ synthetic: true,
      boundary: 'external daily candle and investor API responses', windowId, requests, readbacks,
      legends: await frame.locator('[data-testid^="pane-legend-rows-investor-"]').allTextContents() }, null, 2));
    await info.attach('daily investor cursor UI', { path: screenshot, contentType: 'image/png' });
  }
});


test('repeated daily investor modes read independent exact dates, recover latest and preserve scoped controls', async ({ page }, info) => {
  const requests: string[] = [];
  const windowId = await setup(page, requests);
  const frame = page.locator(`[data-win="${windowId}"]`);
  const panel = page.getByTestId('indicator-panel-shell');
  await frame.getByTestId('live-indicators-button').click();
  for (const [label, side] of [['외국인 순매수량', 'buy'], ['기관 순매수량', 'sell']]) {
    await panel.getByRole('button', { name: '내 지표', exact: true }).click();
    await panel.getByRole('button', { name: label, exact: true }).click();
    await panel.getByRole('button', { name: '설정 복사해서 추가', exact: true }).click();
    await panel.getByRole('combobox', { name: '투자자 매매 기준' }).selectOption(side);
    await panel.getByRole('button', { name: '설정대로 추가', exact: true }).click();
  }
  await panel.getByRole('button', { name: '닫기', exact: true }).click();
  await expect(frame.getByTestId('chart-reveal-cover')).toHaveCSS('opacity', '0');
  await expect.poll(async () => (await chartValues(page, windowId, 20)).series.length).toBe(4);
  const initial = await chartValues(page, windowId, 20);
  const repeated = initial.series.filter(series => series.name.startsWith('indicator:'));
  expect(repeated).toHaveLength(2);
  const readbacks: Awaited<ReturnType<typeof chartValues>>[] = [];
  for (const index of [20, 21, 22, gapIndex]) {
    await hoverCandle(page, windowId, index);
    const readback = await chartValues(page, windowId, index);
    readbacks.push(readback);
    for (const series of readback.series) {
      const repeat = series.name.startsWith('indicator:');
      const foreign = series.name.endsWith('investor-foreign');
      const expected = index === gapIndex ? null : repeat ? (foreign ? 820000 : 1040000) + index * 1000
        : foreign ? quantities[index].foreign_net : quantities[index].institution_net;
      expect(series).toMatchObject({ type: 'Histogram', registeredOnChart: true, value: expected });
      const legend = repeat ? frame.getByTestId(`indicator-instance-legend-${series.name.split(':')[1]}`)
        : frame.getByTestId(`pane-legend-rows-${series.name}`);
      await expect(legend).toContainText(formatQuantity(series.value));
      expect((await legend.innerText()).split(foreign ? '외국인 순매수량' : '기관 순매수량')).toHaveLength(2);
    }
  }
  await page.mouse.move(5, 5);
  const latest = await chartValues(page, windowId, candles.length - 1);
  for (const series of latest.series) {
    const legend = series.name.startsWith('indicator:') ? frame.getByTestId(`indicator-instance-legend-${series.name.split(':')[1]}`)
      : frame.getByTestId(`pane-legend-rows-${series.name}`);
    await expect(legend).toContainText(formatQuantity(series.latest));
  }
  const repeatId = repeated[0].name.split(':')[1];
  const legend = frame.getByTestId(`indicator-instance-legend-${repeatId}`);
  await legend.getByRole('button', { name: /숨기기$/ }).click();
  await expect.poll(async () => (await chartValues(page, windowId, 20)).series.length).toBe(3);
  await frame.getByTestId('live-indicators-button').click();
  await panel.getByRole('button', { name: '내 지표', exact: true }).click();
  await panel.getByRole('button', { name: '외국인 순매수량 2 설정', exact: true }).click();
  await panel.getByRole('button', { name: '외국인 순매수량 2 표시', exact: true }).click();
  await panel.getByRole('button', { name: '닫기', exact: true }).click();
  await expect.poll(async () => (await chartValues(page, windowId, 20)).series.length).toBe(4);
  await legend.getByRole('button', { name: /삭제$/ }).click();
  await expect(legend).toHaveCount(0);
  await page.getByRole('button', { name: '실행 취소', exact: true }).click();
  await expect(legend).toBeVisible();
  await expect.poll(async () => (await chartValues(page, windowId, 20)).series.length).toBe(4);
  await hoverCandle(page, windowId, gapIndex);
  await expect(legend).toContainText('—');
  expect(requests.map(url => new URL(url).searchParams.get('trade_side'))).toEqual(expect.arrayContaining(['net', 'buy', 'sell']));
  expect(requests.every(url => new URL(url).searchParams.get('axis') === 'qty')).toBe(true);
  mkdirSync(preview, { recursive: true });
  const screenshot = resolve(preview, 'daily-repeated-cursor-result.png');
  await page.screenshot({ path: screenshot });
  writeFileSync(resolve(preview, 'daily-repeated-cursor.json'), JSON.stringify({ synthetic: true,
    boundary: 'external daily candle and investor API responses', windowId, requests, readbacks }, null, 2));
  await info.attach('daily repeated investor cursor UI', { path: screenshot, contentType: 'image/png' });
});
