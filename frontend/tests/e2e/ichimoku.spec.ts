import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AutoscaleInfo, IChartApi, Logical } from 'lightweight-charts';
import type { IchimokuSnapshot } from '../../src/chart/IchimokuPrimitive';
import { installLiveMocks } from './helpers/liveMocks';
import { apiExact } from './helpers/apiRoutes';
type Probe = { snapshot: IchimokuSnapshot | null; autoscaleInfo: (from: Logical, to: Logical) => AutoscaleInfo | null };
type ChartWindow = Window & { __liveCharts: Map<string, IChartApi>; __ichimokuProbes: Probe[]; __ichimokuAutoscaleCalls: { from: number; to: number }[] };
const evidence = path.resolve('../.audit/preview');
async function setup(page: Page) {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.clock.setFixedTime(new Date('2026-05-28T17:00:00+09:00'));
  await installLiveMocks(page);
  await page.route(apiExact('live/settings'), route => route.fulfill({ json: { schema_version: 1, rest_bypass_enabled: false, screener_depth_autocollect: false, krx_prefer_hogaplay: false } }));
  const start = Date.parse('2026-05-27T09:00:00+09:00');
  await page.route(apiExact('live/past-candles'), route => route.fulfill({ json: {
    code: '098460', from: '20260527', to: '20260528', cached_dates: ['20260527'], fresh_dates: [], data_warnings: [],
    candles: Array.from({ length: 240 }, (_, i) => {
      const close = 35000 + Math.sin(i / 22) * 950 + Math.sin(i / 7) * 180, open = close + Math.cos(i / 3) * 90;
      return { t_ms: start + i * 60000, open, close, high: Math.max(open, close) + 95, low: Math.min(open, close) - 95, volume: 100 + i };
    }),
  } }));
  await page.goto('/live?code=098460');
  await expect.poll(() => page.evaluate(() => (window as unknown as ChartWindow).__liveCharts?.size ?? 0)).toBe(1);
  const id = await page.evaluate(() => [...(window as unknown as ChartWindow).__liveCharts.keys()][0]);
  await expect.poll(() => page.evaluate(id => (window as unknown as ChartWindow).__liveCharts.get(id)!.panes()[0].getSeries().find(s => s.seriesType() === 'Candlestick')?.data().filter(p => 'close' in p).length, id)).toBe(240);
  await page.evaluate(async () => {
    const modulePath = '/src/chart/IchimokuPrimitive.ts'; const { IchimokuPrimitive } = await import(modulePath);
    const attached = IchimokuPrimitive.prototype.attached;
    (window as unknown as ChartWindow).__ichimokuProbes = [];
    (window as unknown as ChartWindow).__ichimokuAutoscaleCalls = [];
    const autoscale = IchimokuPrimitive.prototype.autoscaleInfo;
    IchimokuPrimitive.prototype.autoscaleInfo = function (...args: unknown[]) {
      const result = autoscale.apply(this, args);
      (window as unknown as ChartWindow).__ichimokuAutoscaleCalls.push({ from: Number(args[0]), to: Number(args[1]) });
      return result;
    };
    IchimokuPrimitive.prototype.attached = function (...args: unknown[]) {
      (window as unknown as ChartWindow).__ichimokuProbes.push(this); return attached.apply(this, args);
    };
  });
  return id;
}
async function chartState(page: Page, id: string) {
  return page.evaluate(id => {
    const chart = (window as unknown as ChartWindow).__liveCharts.get(id)!, scale = chart.timeScale();
    const series = chart.panes()[0].getSeries(), candle = series.find(s => s.seriesType() === 'Candlestick')!;
    const data = candle.data().filter(p => 'close' in p);
    return { rows: data, times: series.map(s => s.data().map(p => p.time)), range: scale.getVisibleLogicalRange(), latestX: scale.timeToCoordinate(data.at(-1)!.time), width: scale.width(), spacing: scale.options().barSpacing, seriesCount: series.length };
  }, id);
}
for (const theme of ['toss-light', 'toss-dark']) {
  test(`${theme}: actual Add, full forward cloud, settings and immutable candle time keys`, async ({ page, browser }, info) => {
    test.setTimeout(90000);
    const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(theme => localStorage.setItem('ui.themePreference.v1', JSON.stringify({ themePreference: theme })), theme);
    const id = await setup(page);
    const frame = page.locator(`[data-win="${id}"]`), frameBox = (await frame.boundingBox())!, handle = (await frame.locator('[data-handle="e"]').boundingBox())!;
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2); await page.mouse.down();
    await page.mouse.move(handle.x + handle.width / 2 + 700 - frameBox.width, handle.y + handle.height / 2, { steps: 8 }); await page.mouse.up();
    await expect.poll(async () => (await frame.boundingBox())!.width).toBeCloseTo(700, 0);
    const before = await chartState(page, id);
    await page.getByTestId('live-indicators-button').click();
    const editor = page.getByTestId('indicator-panel-shell');
    await editor.getByRole('button', { name: '지표 추가', exact: true }).click();
    await editor.getByRole('textbox', { name: /검색/ }).fill('일목');
    await editor.getByRole('button', { name: '일목균형표', exact: true }).click();
    await expect(editor.getByRole('spinbutton', { name: '일목 전환 기간' })).toHaveValue('9');
    await expect(editor.locator('[data-preview-cloud]')).not.toHaveCount(0);
    await expect.poll(() => page.evaluate(() => (window as unknown as ChartWindow).__ichimokuProbes.length)).toBe(0);
    await editor.getByRole('button', { name: '설정대로 추가', exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as unknown as ChartWindow).__ichimokuProbes.filter(p => p.snapshot).length)).toBe(1);
    const afterAdd = await chartState(page, id);
    expect(afterAdd.rows).toEqual(before.rows); expect(afterAdd.times).toEqual(before.times);
    expect(afterAdd.range).toEqual(before.range); expect(afterAdd.latestX).toBe(before.latestX);
    mkdirSync(evidence, { recursive: true });
    await editor.screenshot({ path: path.join(evidence, theme === 'toss-light' ? 'ichimoku-settings.png' : 'ichimoku-settings-dark.png') });
    await page.keyboard.press('Escape');
    const canvas = page.locator('canvas').first(); const box = await canvas.boundingBox(); expect(box).not.toBeNull();
    const panPixels = afterAdd.width - 12 - (afterAdd.latestX! + afterAdd.spacing * 26);
    await page.mouse.move(box!.x + box!.width * .65, box!.y + box!.height * .6);
    await page.mouse.down(); await page.mouse.move(box!.x + box!.width * .65 + panPixels, box!.y + box!.height * .6, { steps: 16 }); await page.mouse.up();
    await expect.poll(async () => { const s = await chartState(page, id); return s.latestX! + s.spacing * 26 < s.width; }).toBe(true);
    await page.mouse.move(10, 10);
    const afterPan = await chartState(page, id);
    const probe = await page.evaluate(() => {
      const p = (window as unknown as ChartWindow).__ichimokuProbes.find(p => p.snapshot)!.snapshot!;
      return { bars: p.model.bars.length, offsets: Object.fromEntries(Object.entries(p.model.lines).map(([key, line]) => [key, line.offset])), lastA: p.model.lines.leadingA.values.at(-1), lastB: p.model.lines.leadingB.values.at(-1) };
    });
    expect(probe.offsets).toEqual({ conversion: 0, base: 0, leadingA: 26, leadingB: 26, lagging: -26 });
    expect(afterPan.rows).toEqual(before.rows); expect(afterPan.times).toEqual(before.times);
    const tailPixel = await page.evaluate(id => {
      const chart = (window as unknown as ChartWindow).__liveCharts.get(id)!, ts = chart.timeScale();
      const candle = chart.panes()[0].getSeries().find(s => s.seriesType() === 'Candlestick')!;
      const model = (window as unknown as ChartWindow).__ichimokuProbes.find(p => p.snapshot)!.snapshot!.model;
      const last = ts.timeToIndex(model.bars.at(-1)!.virtualSecond as never, false)!;
      const x = ts.logicalToCoordinate((last + 26) as never)!, y = candle.priceToCoordinate(model.lines.leadingA.values.at(-1)!)!;
      const canvases = [...document.querySelectorAll(`[data-win="${id}"] .live-chart-canvas canvas`)] as HTMLCanvasElement[];
      const hits = canvases.some(canvas => {
        if (canvas.clientWidth < ts.width() - 2 || canvas.clientHeight < y) return false;
        const ratio = canvas.width / canvas.clientWidth;
        const data = canvas.getContext('2d')!.getImageData(Math.max(0, Math.floor(x * ratio) - 3), Math.max(0, Math.floor(y * ratio) - 3), 7, 7).data;
        for (let i = 0; i < data.length; i += 4) if (data[i] > 200 && data[i + 1] < 120 && data[i + 2] < 120 && data[i + 3] > 0) return true;
        return false;
      });
      return { x, y, last: Number(last), hits };
    }, id);
    expect(tailPixel.hits).toBe(true);
    await page.screenshot({ path: path.join(evidence, theme === 'toss-light' ? 'ichimoku-cloud.png' : 'ichimoku-cloud-dark.png') });
    writeFileSync(path.join(evidence, `metadata-${theme}.json`), JSON.stringify({ fixture: 'Synthetic API-boundary OHLC, 240 observed 1-minute bars, 2026-05-27 KRX regular session. No vendor credentials.', browser: browser.version(), theme, url: page.url(), before, afterAdd, afterPan, probe, tailPixel, panPixels, frameWidth: (await frame.boundingBox())!.width, test: info.title }, null, 2));
    expect(errors.filter(message => !message.startsWith('ResizeObserver loop'))).toEqual([]);
  });
}
async function settings(page: Page, id: string) {
  return page.evaluate(async id => {
    const storePath = '/src/state/livePage.ts', settingsPath = '/src/state/indicatorSettingsV2.ts';
    const { useLivePageStore } = await import(storePath), { resolveIndicatorSettings, bucketsForScope } = await import(settingsPath);
    const s = useLivePageStore.getState();
    return resolveIndicatorSettings(bucketsForScope(s.indicatorsByTimeframe, s.indicatorsByWindow, { windowKey: `live:${id}` }), '1m');
  }, id);
}
test('configure-before-add, independent instances, style, cloud, reset, deletion, undo and reload', async ({ page }) => {
  test.setTimeout(90000);
  const id = await setup(page);
  await page.getByTestId('live-indicators-button').click();
  const editor = page.getByTestId('indicator-panel-shell');
  await editor.getByRole('button', { name: '지표 추가', exact: true }).click();
  await editor.getByRole('button', { name: '일목균형표', exact: true }).click();
  await editor.getByRole('spinbutton', { name: '일목 전환 기간' }).fill('7');
  await editor.getByRole('spinbutton', { name: '일목 전환 기간' }).press('Enter');
  await editor.getByRole('switch', { name: '일목 선행 A 표시', exact: true }).click();
  await editor.getByRole('combobox', { name: '일목 공통 선 두께' }).selectOption('3');
  expect((await settings(page, id)).ichimokuEnabled).toBe(false);
  expect((await settings(page, id)).ichimokuConversionPeriod).toBe(9);
  await expect(editor.locator('[data-preview-line="선행 A"]')).toHaveCount(0);
  await expect(editor.locator('[data-preview-cloud]')).not.toHaveCount(0);
  await editor.getByRole('button', { name: '설정대로 추가', exact: true }).click();
  await expect.poll(async () => (await settings(page, id)).ichimokuConversionPeriod).toBe(7);
  await editor.getByRole('button', { name: '하나 더 추가', exact: true }).click();
  await editor.getByRole('spinbutton', { name: '일목 기준 기간' }).fill('35');
  await editor.getByRole('spinbutton', { name: '일목 기준 기간' }).press('Enter');
  await editor.getByRole('switch', { name: '일목 구름 표시', exact: true }).click();
  await editor.getByRole('button', { name: '설정대로 추가', exact: true }).click();
  await expect.poll(async () => (await settings(page, id)).indicatorInstances.length).toBe(1);
  const extra = (await settings(page, id)).indicatorInstances[0];
  expect(extra.settings).toMatchObject({ ichimokuBasePeriod: 35, ichimokuCloudVisible: false });
  expect((await settings(page, id)).ichimokuBasePeriod).toBe(26);
  await editor.getByRole('button', { name: '내 지표', exact: true }).click();
  await editor.getByRole('button', { name: '일목균형표 2 숨기기', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as ChartWindow).__ichimokuProbes.filter(p => p.snapshot).length)).toBe(1);
  await editor.getByRole('button', { name: '일목균형표 2 표시', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as ChartWindow).__ichimokuProbes.filter(p => p.snapshot).length)).toBe(2);
  await editor.getByRole('button', { name: '일목균형표 2 설정', exact: true }).click();
  await editor.getByRole('button', { name: '일목균형표 초기화', exact: true }).click();
  await expect(editor.getByRole('spinbutton', { name: '일목 기준 기간' })).toHaveValue('26');
  await expect(editor.getByRole('switch', { name: '일목 구름 표시', exact: true })).toHaveAttribute('aria-checked', 'true');
  expect((await settings(page, id)).ichimokuConversionPeriod).toBe(7);
  await editor.getByRole('button', { name: '일목균형표 2 삭제', exact: true }).click();
  await expect.poll(async () => (await settings(page, id)).indicatorInstances.length).toBe(0);
  await editor.getByRole('button', { name: '되돌리기', exact: true }).click();
  await expect.poll(async () => (await settings(page, id)).indicatorInstances[0].id).toBe(extra.id);
  await page.keyboard.press('Escape');
  await page.evaluate(() => history.replaceState(null, '', '/live')); await page.reload();
  await expect.poll(async () => (await settings(page, id)).indicatorInstances[0].id).toBe(extra.id);
  expect(await settings(page, id)).toMatchObject({ ichimokuEnabled: true, ichimokuConversionPeriod: 7, ichimokuLineWidth: 3, indicatorLineVisibility: { ichimokuLeadingA: false } });
});
test('forward-most native viewport, strict future autoscale interval and inverted log chart preserve observed cursor source', async ({ page }) => {
  test.setTimeout(60000);
  const id = await setup(page);
  await page.getByTestId('live-indicators-button').click(); const editor = page.getByTestId('indicator-panel-shell');
  await editor.getByRole('button', { name: '지표 추가', exact: true }).click();
  await editor.getByRole('button', { name: '일목균형표', exact: true }).click();
  await editor.getByRole('button', { name: '설정대로 추가', exact: true }).click(); await page.keyboard.press('Escape');
  const request = await page.evaluate(id => {
    const ts = (window as unknown as ChartWindow).__liveCharts.get(id)!.timeScale();
    const model = (window as unknown as ChartWindow).__ichimokuProbes.find(p => p.snapshot)!.snapshot!.model;
    const last = ts.timeToIndex(model.bars.at(-1)!.virtualSecond as never, false)!;
    (window as unknown as ChartWindow).__ichimokuAutoscaleCalls = [];
    const requested = { from: last + 1, to: last + 27 };
    ts.setVisibleLogicalRange(requested);
    return { lastActualLogical: Number(last), requested };
  }, id);
  const scaleState = () => page.evaluate(id => {
    const chart = (window as unknown as ChartWindow).__liveCharts.get(id)!, candle = chart.panes()[0].getSeries().find(s => s.seriesType() === 'Candlestick')!;
    const model = (window as unknown as ChartWindow).__ichimokuProbes.find(p => p.snapshot)!.snapshot!.model;
    const values = [...model.lines.leadingA.values.slice(-26), ...model.lines.leadingB.values.slice(-26)].filter((v): v is number => v !== null);
    const min = Math.min(...values), max = Math.max(...values), height = chart.panes()[0].getHeight();
    return { min, max, yMin: candle.priceToCoordinate(min), yMax: candle.priceToCoordinate(max), height, mode: candle.priceScale().options().mode, invert: candle.priceScale().options().invertScale };
  }, id);
  await expect.poll(async () => { const s = await scaleState(); return s.yMin !== null && s.yMax !== null && s.yMin > 0 && s.yMax > 0 && s.yMin < s.height && s.yMax < s.height; }).toBe(true);
  const appliedFrom = request.lastActualLogical - 1;
  const appliedTo = appliedFrom + request.requested.to - request.requested.from;
  await expect.poll(() => page.evaluate(({ id, from, to }) => {
    const win = window as unknown as ChartWindow;
    const observed = win.__liveCharts.get(id)!.timeScale().getVisibleLogicalRange();
    return observed?.from === from && observed.to === to
      && win.__ichimokuAutoscaleCalls.some(call => call.from === from && call.to === to);
  }, { id, from: appliedFrom, to: appliedTo })).toBe(true);
  const viewportEvidence = await page.evaluate(({ id, request }) => {
    const win = window as unknown as ChartWindow, chart = win.__liveCharts.get(id)!, ts = chart.timeScale();
    const observed = ts.getVisibleLogicalRange()!, primitive = win.__ichimokuProbes.find(p => p.snapshot)!;
    const nativeAutoscaleRanges = [...win.__ichimokuAutoscaleCalls];
    const strictFutureBounds = primitive.autoscaleInfo(request.requested.from as Logical, request.requested.to as Logical);
    const last = primitive.snapshot!.model.bars.at(-1)!;
    return { ...request, observed, latestRealCandleX: ts.timeToCoordinate(last.virtualSecond as never), nativeAutoscaleRanges, strictFutureBounds,
      visibleRealCandles: primitive.snapshot!.model.bars.filter(bar => { const logical = ts.timeToIndex(bar.virtualSecond as never, false); return logical !== null && logical >= observed.from && logical <= observed.to; }).length };
  }, { id, request });
  expect(viewportEvidence.requested.from).toBeGreaterThan(viewportEvidence.lastActualLogical);
  expect(viewportEvidence.strictFutureBounds?.priceRange?.minValue).toBeCloseTo((await scaleState()).min);
  expect(viewportEvidence.strictFutureBounds?.priceRange?.maxValue).toBeCloseTo((await scaleState()).max);
  expect(viewportEvidence.nativeAutoscaleRanges.length).toBeGreaterThan(0);
  expect(viewportEvidence.visibleRealCandles).toBeGreaterThan(0);
  const normal = await scaleState(); expect(normal.yMin!).toBeGreaterThan(normal.yMax!);
  expect(Math.abs(normal.yMin! - normal.yMax!) / normal.height).toBeGreaterThan(.5);
  const frame = page.locator(`[data-win="${id}"]`);
  await frame.getByRole('button', { name: '차트 설정', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '차트 설정', exact: true });
  await dialog.getByRole('switch', { name: '로그 스케일', exact: true }).click();
  await dialog.getByRole('switch', { name: '차트 거꾸로 보기', exact: true }).click(); await page.keyboard.press('Escape');
  await expect.poll(async () => (await scaleState()).invert).toBe(true);
  const inverted = await scaleState(); expect(inverted.mode).toBe(1); expect(inverted.yMin!).toBeLessThan(inverted.yMax!);
  const canvas = frame.locator('.live-chart-canvas canvas').first(), box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const cursor = await page.evaluate(async () => {
    const modulePath = '/src/live/useLiveCursorStore.ts'; const { useLiveCursorStore } = await import(modulePath); const s = useLiveCursorStore.getState();
    return { sidebar: s.sidebarCursorMs, sync: s.syncCursorMs, source: s.sidebarCursorOrigin?.barStartMs };
  });
  const lastSource = Date.parse('2026-05-27T12:59:00+09:00');
  for (const value of Object.values(cursor)) if (typeof value === 'number') expect(value).toBeLessThanOrEqual(lastSource);
  await page.mouse.move(10, 10);
  await page.screenshot({ path: path.join(evidence, 'ichimoku-forward-most-inverted-log.png') });
  writeFileSync(path.join(evidence, 'forward-most-scale.json'), JSON.stringify({ nativeConstraint: 'lightweight-charts retains at least two union-grid points; requested range is not necessarily observed range', viewportEvidence, normal, inverted, cursor, lastSource }, null, 2));
});
