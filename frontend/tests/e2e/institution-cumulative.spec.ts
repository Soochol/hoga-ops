import { investorNetEnvelope } from './helpers/investorFlow';
import { expect, test, type Page } from '@playwright/test';
import type { IChartApi } from 'lightweight-charts';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { installLiveMocks } from './helpers/liveMocks';
import { apiExact } from './helpers/apiRoutes';

type ChartWindow = Window & { __liveCharts: Map<string, IChartApi> };
const label = '기관 누적 순매수';
const preview = resolve(process.cwd(), '../.audit/preview');
const days = Array.from({ length: 80 }, (_, i) => Date.UTC(2026, 1, 5 + i)).filter(t => ![0, 6].includes(new Date(t).getUTCDay()));
const candles = days.map((t_ms, i) => ({ t_ms, open: 35000 + i * 25, high: 35300 + i * 25,
  low: 34700 + i * 25, close: 35000 + i * 25 + Math.sin(i * .7) * 200, volume: 100000 + i * 2500 }));
const observations = candles.map((c, i) => ({ date: new Date(c.t_ms).toISOString().slice(0, 10).replaceAll('-', ''),
  t_ms: c.t_ms, institution_net_shares: i === 0 ? 1000 : i % 3 === 0 ? -200 : 150, foreign_net_shares: i === 0 ? -1000 : i % 4 === 0 ? -250 : 100 }));
async function chartState(page: Page) {
  return page.evaluate(() => [...(window as unknown as ChartWindow).__liveCharts.entries()].map(([id, chart]) => ({ id,
    panes: chart.panes().map(pane => ({ height: pane.getHeight(), series: pane.getSeries().map(series => ({
      type: series.seriesType(), options: series.options(), data: series.data(),
    })) })),
  })));
}
const lines = async (page: Page) => (await chartState(page))[0].panes.flatMap(p => p.series).filter(s => s.type === 'Line' && 'color' in s.options && ['#EC4899', '#F97316'].includes(String(s.options.color)));
async function setup(page: Page, mode: { partial: boolean; gap: boolean }, requests: string[]) {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.clock.setFixedTime(new Date('2026-05-28T17:00:00+09:00'));
  await installLiveMocks(page);
  await page.routeWebSocket(/\/api\/ws/, () => {});
  await page.route(apiExact('live/past-daily-candles'), route => {
    const p = new URL(route.request().url()).searchParams;
    return route.fulfill({ json: { code: p.get('code'), from: p.get('from'), to: p.get('to'), candles,
      cached_batches: [], fresh_batches: [], data_warnings: [] } });
  });
  await page.route(apiExact('live/past-investor-net'), route => {
    requests.push(route.request().url());
    const p = new URL(route.request().url()).searchParams;
    return route.fulfill({ json: investorNetEnvelope({ code: p.get('code'), from: p.get('from'), to: p.get('to'),
      source: 'kiwoom_ka10059', provider_scope: 'KRX', unit: 'qty_shares', trade_side: 'net',
      observations: observations.filter((_, i) => !mode.gap || i !== 35), pagination: mode.partial ? 'incomplete' : 'covered',
      unlocated_defect: false, pages_observed: mode.partial ? 6 : 8, can_continue: false,
      data_warnings: mode.partial ? [{ reason: 'page_budget', date: null, subject: null, message: '합성 자료 · 조회 범위 도달 · 전체 완료 미확인' }] : [] }) });
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

test('catalog add, partial gaps, unobtrusive legends, styles and real rendered preview', async ({ page }) => {
  const requests: string[] = [], errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const mode = { partial: true, gap: false };
  await setup(page, mode, requests);
  const panel = page.getByTestId('indicator-panel-shell');
  await expect(panel).toContainText('비중 미지원');
  await panel.getByRole('button', { name: '설정대로 추가', exact: true }).click();
  await panel.getByRole('combobox', { name: '기관 누적 순매수 공통 선 두께' }).selectOption('3');
  await panel.getByRole('button', { name: '기관 누적 순매수 선택' }).click();
  await page.getByRole('button', { name: '기관 누적 순매수 #F97316', exact: true }).click();
  await panel.getByRole('button', { name: '닫기', exact: true }).click();
  const legend = page.getByTestId('pane-legend-rows-institution-cumulative');
  await expect(legend).not.toContainText('누적 기준');
  await expect(legend.getByRole('status')).toHaveCount(0);
  await expect(legend.getByRole('button', { name: '누적 자료 계속 조회·재시도' })).toHaveCount(0);
  await expect.poll(async () => (await lines(page)).length).toBe(1);
  let provisionalSum = 0;
  expect((await lines(page))[0].data.filter(point => 'value' in point).map(point => 'value' in point ? point.value : null))
    .toEqual(observations.map((point, index) => index === 0 ? 0 : (provisionalSum += point.institution_net_shares)));
  await expect(page.locator('[data-testid="indicator-panel-shell"]')).toHaveCount(0);
  await page.waitForTimeout(250);
  mkdirSync(preview, { recursive: true });
  await page.screenshot({ path: resolve(preview, 'institution-cumulative-partial.png') });
  mode.partial = false;
  await page.reload();
  await expect(page.getByTestId('live-chart-root').first()).toBeVisible();
  let sum = 0;
  const expected = observations.map((point, index) => index === 0 ? 0 : (sum += point.institution_net_shares));
  await expect.poll(async () => (await lines(page))[0]?.data.filter(point => 'value' in point).map(point => 'value' in point ? point.value : null) ?? []).toEqual(expected);
  const line = (await lines(page))[0];
  expect(line.options).toMatchObject({ color: '#F97316', lineWidth: 3 });
  await page.screenshot({ path: resolve(preview, 'institution-cumulative-netbuy.png') });
  writeFileSync(resolve(preview, 'institution-cumulative-netbuy.json'), JSON.stringify({ synthetic: true,
    boundary: 'external daily candles and past-investor-net market-data API responses; no live vendor proof', requests, errors, chart: await chartState(page) }, null, 2));
  expect(errors.filter(error => !error.startsWith('ResizeObserver loop'))).toEqual([]);
});

test('two distinct cumulative categories, repeated panes, persistence, hide, delete and undo', async ({ page }) => {
  const requests: string[] = [];
  await setup(page, { partial: false, gap: false }, requests);
  const panel = page.getByTestId('indicator-panel-shell');
  await panel.getByRole('button', { name: '설정대로 추가', exact: true }).click();
  await panel.getByRole('button', { name: '지표 추가', exact: true }).click();
  await expect(panel.getByRole('button', { name: '외국인 보유', exact: true })).toBeVisible();
  await expect(panel.getByRole('button', { name: '외국인·기관 보유', exact: true })).toHaveCount(0);
  await panel.getByRole('button', { name: '외국인 누적 순매수', exact: true }).click();
  await expect(panel).toContainText('외국인투자자 + 내외국인');
  await panel.getByRole('button', { name: '설정대로 추가', exact: true }).click();
  mkdirSync(preview, { recursive: true });
  await panel.screenshot({ path: resolve(preview, 'cumulative-catalog-two-subjects.png') });
  await panel.getByRole('button', { name: '닫기', exact: true }).click();
  await page.getByTestId('live-indicators-button').first().click();
  await panel.getByRole('button', { name: label, exact: true }).click();
  await panel.getByRole('button', { name: '설정 복사해서 추가', exact: true }).click();
  await panel.getByRole('combobox', { name: '기관 누적 순매수 공통 선 두께' }).selectOption('4');
  await panel.getByRole('button', { name: '설정대로 추가', exact: true }).click();
  await panel.getByRole('button', { name: '닫기', exact: true }).click();
  await expect.poll(async () => (await chartState(page))[0].panes.filter(p => p.series.some(s => s.type === 'Line' && 'color' in s.options && ['#EC4899','#22D3EE'].includes(String(s.options.color)))).length).toBe(3);
  const foreignLegend = page.getByTestId('pane-legend-rows-foreign-cumulative');
  await expect(foreignLegend).toContainText('외국인 누적 순매수');
  await expect(foreignLegend).not.toContainText('외국인 누적 순매수(주)');
  expect((await foreignLegend.innerText()).split('외국인 누적 순매수')).toHaveLength(2);
  const repeatedLegend = page.getByTestId(/^indicator-instance-legend-/);
  await expect(repeatedLegend).not.toContainText('조회자료 첫날');
  await expect(repeatedLegend).not.toContainText('기관 누적 순매수(주)');
  expect((await repeatedLegend.innerText()).split(label)).toHaveLength(2);
  await expect(page.getByTestId(/^indicator-instance-legend-/).getByRole('button', { name: '누적 자료 계속 조회·재시도' })).toHaveCount(0);
  await expect(page.getByTestId(/^indicator-instance-legend-/)).not.toContainText('조회 완료');
  const before = requests.length;
  await page.reload();
  await expect(foreignLegend).not.toContainText('누적 기준');
  await expect.poll(async () => (await chartState(page))[0].panes.filter(p => p.series.some(s => s.type === 'Line' && 'color' in s.options && ['#EC4899','#22D3EE'].includes(String(s.options.color)))).length).toBe(3);
  expect(requests.length - before).toBe(1);
  await page.getByTestId('live-indicators-button').first().click();
  await panel.getByRole('button', { name: `${label} 2 설정`, exact: true }).click();
  await panel.getByRole('button', { name: `${label} 2 숨기기`, exact: true }).click();
  await expect.poll(async () => (await lines(page)).length).toBe(1);
  await panel.getByRole('button', { name: `${label} 2 표시`, exact: true }).click();
  await panel.getByRole('button', { name: '삭제', exact: true }).click();
  await expect.poll(async () => (await lines(page)).length).toBe(1);
  await panel.getByRole('button', { name: '되돌리기', exact: true }).click();
  await expect.poll(async () => (await lines(page)).length).toBe(2);
  await panel.getByRole('button', { name: '닫기', exact: true }).click();
  await page.getByRole('button', { name: '주', exact: true }).first().click();
  await expect(page.getByTestId('pane-chip-institution-cumulative')).toHaveCount(0);
  await expect(page.getByTestId('pane-chip-foreign-cumulative')).toHaveCount(0);
});

import { hoverSyncChart, installSyncWorkspace, syncBus, type SyncFixtures, type SyncWindow } from './helpers/tooltipCrosshair';

test('cumulative exact gaps and two-window cursor survive actual 700px resize', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1800, height: 1100 });
  const windows: SyncWindow[] = [
    { id: 's', timeframe: 'D', code: '098460', group: 1, tooltip: false },
    { id: 'd', timeframe: 'D', code: '098460', group: 1, tooltip: false },
  ];
  const fixtures: SyncFixtures = { D: candles, '1m': candles, W: candles, M: candles };
  await installSyncWorkspace(page, windows, false, fixtures);
  await page.route(apiExact('live/past-investor-net'), route => {
    const p = new URL(route.request().url()).searchParams;
    return route.fulfill({ json: investorNetEnvelope({ code: p.get('code'), from: p.get('from'), to: p.get('to'), source: 'kiwoom_ka10059',
      provider_scope: 'KRX', unit: 'qty_shares', trade_side: 'net', observations: observations.filter((_, i) => i !== 35),
      pagination: 'covered', unlocated_defect: false, pages_observed: 8, can_continue: false, data_warnings: [] }) });
  });
  const panel = page.getByTestId('indicator-panel-shell');
  for (const [index, name] of [label, '외국인 누적 순매수'].entries()) {
    await page.locator(`[data-win="${windows[index].id}"]`).getByTestId('live-indicators-button').click();
    await panel.getByRole('button', { name: '지표 추가', exact: true }).click();
    await panel.getByRole('button', { name, exact: true }).click();
    await panel.getByRole('button', { name: '설정대로 추가', exact: true }).click();
    await panel.getByRole('button', { name: '닫기', exact: true }).click();
  }
  const source = page.locator('[data-win="s"]').getByTestId('pane-legend-rows-institution-cumulative');
  const target = page.locator('[data-win="d"]').getByTestId('pane-legend-rows-foreign-cumulative');
  const institution = observations.slice(1, 31).reduce((sum, point) => sum + point.institution_net_shares, 0);
  const foreign = observations.slice(1, 31).reduce((sum, point) => sum + point.foreign_net_shares, 0);
  for (const resize of [false, true]) {
    if (resize) {
      const frame = page.locator('[data-win="s"]');
      const bounds = (await frame.boundingBox())!;
      const handle = (await frame.locator('[data-handle="e"]').boundingBox())!;
      const x = handle.x + handle.width / 2, y = handle.y + handle.height / 2;
      await page.mouse.move(x, y); await page.mouse.down();
      await page.mouse.move(x + 700 - bounds.width, y, { steps: 8 }); await page.mouse.up();
      await expect.poll(async () => (await frame.boundingBox())!.width).toBeCloseTo(700, 0);
    }
    await hoverSyncChart(page, windows[0], 0, false, candles[30].t_ms);
    await expect.poll(async () => (await syncBus(page)).origin?.windowId).toBe('s');
    await expect(source).toContainText(`${institution.toLocaleString('ko-KR')}주`);
    await expect(target).toContainText(`${foreign.toLocaleString('ko-KR')}주`);
    for (const index of [35, 40]) {
      await hoverSyncChart(page, windows[0], 0, false, candles[index].t_ms);
      await expect(source).toContainText('기관 누적 순매수—');
      await expect(target).toContainText('외국인 누적 순매수—');
    }
  }
  await expect(source.getByRole('button', { name: '누적 자료 계속 조회·재시도' })).toHaveCount(0);
  await expect(source.getByRole('status')).toHaveCount(0);
  mkdirSync(preview, { recursive: true });
  await page.locator('[data-win="s"]').screenshot({ path: resolve(preview, 'cumulative-window-700.png') });
});

test('unsupported minute, calendar, index and overseas contexts do not query cumulative flow', async ({ page }) => {
  const requests: string[] = [];
  await setup(page, { partial: false, gap: false }, requests);
  const panel = page.getByTestId('indicator-panel-shell');
  await panel.getByRole('button', { name: '설정대로 추가', exact: true }).click();
  await panel.getByRole('button', { name: '닫기', exact: true }).click();
  await expect.poll(() => requests.length).toBeGreaterThan(0);
  for (const button of ['주', '월']) {
    await page.getByRole('button', { name: button, exact: true }).first().click();
    await expect(page.getByTestId('pane-chip-institution-cumulative')).toHaveCount(0);
  }
  await page.getByRole('button', { name: /분봉으로 전환/ }).first().click();
  await expect(page.getByTestId('pane-chip-institution-cumulative')).toHaveCount(0);
  requests.length = 0;
  for (const url of ['/live?index=KOSPI', '/live?market=US&exchange=NASDAQ&symbol=NVDA']) {
    await page.goto(url); await expect(page.getByTestId('live-chart-root').first()).toBeVisible();
    await page.getByTestId('live-indicators-button').first().click();
    await panel.getByRole('button', { name: '지표 추가', exact: true }).click();
    for (const name of [label, '외국인 누적 순매수']) {
      await panel.getByRole('button', { name, exact: true }).click();
      await expect(panel.getByRole('button', { name: '설정대로 추가' })).toBeDisabled();
    }
    await panel.getByRole('button', { name: '닫기', exact: true }).click();
  }
  expect(requests).toEqual([]);
});
