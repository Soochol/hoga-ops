import { expect, test, type Page } from '@playwright/test';
import type { IChartApi, ISeriesApi } from 'lightweight-charts';
import { installLiveMocks } from './helpers/liveMocks';
import { apiExact } from './helpers/apiRoutes';

type ChartWindow = Window & { __liveCharts: Map<string, IChartApi> };
async function setup(page: Page) {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.clock.setFixedTime(new Date('2026-05-28T17:00:00+09:00'));
  await installLiveMocks(page);
  await page.route(apiExact('live/settings'), r => r.fulfill({ json: { schema_version: 1, rest_bypass_enabled: false, screener_depth_autocollect: false, krx_prefer_hogaplay: false } }));
  const start = Date.parse('2026-05-27T09:00:00+09:00');
  await page.route(apiExact('live/past-candles'), r => r.fulfill({ json: {
    code: '098460', from: '20260527', to: '20260528', cached_dates: ['20260527'], fresh_dates: [], data_warnings: [],
    candles: Array.from({ length: 130 }, (_, i) => ({ t_ms: start + i * 60_000, open: 35000 + i, close: 35000 + i + Math.sin(i / 3) * 20, high: 35100 + i, low: 34900 + i, volume: 100 })),
  } }));
  await page.goto('/live?code=098460');
  await expect.poll(() => page.evaluate(() => (window as unknown as ChartWindow).__liveCharts?.size ?? 0)).toBe(1);
  const id = await page.evaluate(() => [...(window as unknown as ChartWindow).__liveCharts.keys()][0]);
  await page.getByTestId('live-indicators-button').click();
  return id;
}
async function state(page: Page, id: string) {
  return page.evaluate(async id => {
    const path = '/src/state/livePage.ts'; const scopes = '/src/state/indicatorSettingsV2.ts';
    const { useLivePageStore } = await import(path); const { resolveIndicatorSettings, bucketsForScope } = await import(scopes);
    const s = useLivePageStore.getState();
    return resolveIndicatorSettings(bucketsForScope(s.indicatorsByTimeframe, s.indicatorsByWindow, { windowKey: `live:${id}` }), '1m');
  }, id);
}
for (const theme of ['toss-light', 'toss-dark']) {
  test(`${theme}: independent Bollingers and total panes survive editing, hiding, delete, undo and reload`, async ({ page }, info) => {
    const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(theme => localStorage.setItem('ui.themePreference.v1', JSON.stringify({ themePreference: theme })), theme);
    const id = await setup(page); const editor = page.getByTestId('indicator-panel-shell');
    const catalog = async (label: string) => { await editor.getByRole('button', { name: '지표 추가', exact: true }).click(); await editor.getByRole('button', { name: label, exact: true }).click(); };
    await catalog('볼린저 밴드');
    await editor.getByRole('button', { name: '설정대로 추가', exact: true }).click();
    await editor.getByRole('button', { name: '하나 더 추가', exact: true }).click();
    await editor.getByRole('spinbutton', { name: '볼린저 기간' }).fill('60');
    await editor.getByRole('switch', { name: '볼린저 하단선 표시' }).click();
    await editor.getByRole('button', { name: '설정대로 추가', exact: true }).click();
    const extra = (await state(page, id)).indicatorInstances[0];
    const bands = () => page.evaluate(id => (window as unknown as ChartWindow).__liveCharts.get(id)!.panes()[0].getSeries().filter(s => s.seriesType() === 'Line' && (s as ISeriesApi<'Line'>).options().color === '#3B82F6').map(s => ({ visible: s.options().visible, values: s.data().slice(-3) })), id);
    await expect.poll(async () => (await bands()).length).toBe(4);
    const lines = await bands(); expect(lines.filter(l => l.visible)).toHaveLength(3); expect(lines[0].values).not.toEqual(lines[2].values);
    await editor.getByRole('button', { name: '내 지표', exact: true }).click();
    await editor.getByRole('button', { name: '볼린저 밴드 1 설정', exact: true }).click();
    await expect(editor.getByRole('spinbutton', { name: '볼린저 기간' })).toHaveValue('20');
    await editor.getByRole('button', { name: '볼린저 밴드 2 설정', exact: true }).click();
    await expect(editor.getByRole('spinbutton', { name: '볼린저 기간' })).toHaveValue('60');
    await editor.getByRole('spinbutton', { name: '볼린저 기간' }).fill('80'); await editor.getByRole('spinbutton', { name: '볼린저 기간' }).press('Enter');
    await expect.poll(async () => (await state(page, id)).indicatorInstances[0].settings.bollingerPeriod).toBe(80);
    expect((await state(page, id)).bollingerPeriod).toBe(20);
    await editor.getByRole('button', { name: '볼린저 밴드 2 숨기기', exact: true }).click();
    await expect.poll(async () => (await bands()).filter(l => l.visible).length).toBe(2);
    await editor.getByRole('button', { name: '볼린저 밴드 2 표시', exact: true }).click();
    await catalog('총잔량'); await editor.getByRole('button', { name: '설정대로 추가', exact: true }).click();
    await editor.getByRole('button', { name: '하나 더 추가', exact: true }).click();
    await editor.getByRole('switch', { name: '매도 총잔량 표시', exact: true }).click();
    await editor.getByRole('button', { name: '설정대로 추가', exact: true }).click();
    await expect.poll(() => page.evaluate(id => (window as unknown as ChartWindow).__liveCharts.get(id)!.panes().length, id)).toBe(4); // candle + volume + two totals
    await editor.getByRole('button', { name: '내 지표', exact: true }).click();
    await editor.getByRole('button', { name: '총잔량 2 설정', exact: true }).click();
    await expect(editor.getByRole('switch', { name: '매도 총잔량 표시', exact: true })).toHaveAttribute('aria-checked', 'false');
    await editor.getByRole('button', { name: '총잔량 1 설정', exact: true }).click();
    await expect(editor.getByRole('switch', { name: '매도 총잔량 표시', exact: true })).toHaveAttribute('aria-checked', 'true');
    await editor.getByRole('button', { name: '볼린저 밴드', exact: true }).click();
    await editor.screenshot({ path: info.outputPath(`indicator-instances-${theme}.png`) });
    await page.setViewportSize({ width: 390, height: 844 });
    await editor.screenshot({ path: info.outputPath(`indicator-instances-${theme}-390.png`) });
    const width = await editor.evaluate(el => ({ width: el.clientWidth, scroll: el.scrollWidth })); expect(width.scroll).toBeLessThanOrEqual(width.width + 1);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await editor.getByRole('button', { name: '볼린저 밴드 2 삭제', exact: true }).click();
    await expect.poll(async () => (await state(page, id)).indicatorInstances.some((r: { id: string }) => r.id === extra.id)).toBe(false);
    await editor.getByRole('button', { name: '되돌리기', exact: true }).click();
    await expect.poll(async () => (await state(page, id)).indicatorInstances.some((r: { id: string }) => r.id === extra.id)).toBe(true);
    await page.keyboard.press('Escape'); await page.evaluate(() => history.replaceState(null, '', '/live')); await page.reload();
    await expect.poll(async () => (await state(page, id)).indicatorInstances.find((r: { id: string }) => r.id === extra.id)?.settings.bollingerPeriod).toBe(80);
    // Chrome can emit its bounded ResizeObserver delivery notification on pane resizing.
    expect(errors.filter(message => !message.startsWith('ResizeObserver loop'))).toEqual([]);
  });
}

test('all indicator kinds mount as independent instances, including daily trade-side sources', async ({ page }) => {
  test.setTimeout(60_000);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const id = await setup(page);
  const t = Date.parse('2026-05-27T09:00:00+09:00');
  await page.route(apiExact('live/past-daily-candles'), route => route.fulfill({ json: {
    code: '098460', from: '20260527', to: '20260528', cached_batches: [], fresh_batches: [], data_warnings: [],
    candles: [0, 1].map(i => ({ t_ms: t + i * 86400000, open: 35000, close: 35100, high: 35200, low: 34900, volume: 100 })),
  } }));
  await page.route(apiExact('live/past-investor-net'), route => {
    const side = new URL(route.request().url()).searchParams.get('trade_side') ?? 'net';
    const value = { net: 10, buy: 200, sell: 190 }[side] ?? 0;
    return route.fulfill({ json: { code: '098460', from: '20260527', to: '20260528', trade_side: side,
      points: [0, 1].map(i => ({ t_ms: t + i * 86400000, foreign_net: value, institution_net: value * 2 })),
      cached_batches: [], fresh_batches: [], data_warnings: [] } });
  });
  await page.route(apiExact('live/daily-program-trade'), route => route.fulfill({ json: {
    code: '098460', from: '20260527', to: '20260528', points: [0, 1].map(i => ({ t_ms: t + i * 86400000, net_qty: 10, buy_qty: 100, sell_qty: 90 })),
    cached_batches: [], fresh_batches: [], data_warnings: [],
  } }));
  const inserted = await page.evaluate(async id => {
    const catalogPath = '/src/live/indicators/indicatorCatalogDraft.ts';
    const instancesPath = '/src/state/indicatorInstances.ts'; const settingsPath = '/src/state/indicatorSettingsV2.ts';
    const prefsPath = '/src/state/chartPrefs.ts'; const storePath = '/src/state/livePage.ts';
    const { createCatalogDraft } = await import(catalogPath); const { INDICATOR_CATEGORIES, makeIndicatorInstance } = await import(instancesPath);
    const { FACTORY_INDICATOR_SETTINGS } = await import(settingsPath); const { DEFAULT_PREFS } = await import(prefsPath);
    const { useLivePageStore } = await import(storePath);
    const rows = INDICATOR_CATEGORIES.map((category: string) => {
      const draft = createCatalogDraft(category, FACTORY_INDICATOR_SETTINGS, DEFAULT_PREFS).store.getState();
      if (category === 'foreign-net') draft.settings = { ...draft.settings, foreignTradeSide: 'buy' };
      if (category === 'institution-net') draft.settings = { ...draft.settings, institutionTradeSide: 'sell' };
      if (category === 'program-daily') draft.settings = { ...draft.settings, dailyProgramTradeSide: 'sell' };
      if (category === 'peak-walls') draft.settings = { ...draft.settings, peakWallPaneEnabled: true, askPeakTradedPaneEnabled: true };
      return makeIndicatorInstance(category, draft.settings, draft.prefs);
    });
    // Extra daily program net mode must share raw data and select its own column.
    const daily = rows.find((row: { category: string }) => row.category === 'program-daily');
    rows.push({ ...daily, id: crypto.randomUUID(), settings: { ...daily.settings, dailyProgramTradeSide: 'net' } });
    for (const tf of ['1m', 'D']) useLivePageStore.getState().patchIndicatorsScoped({ windowKey: `live:${id}` }, tf, { indicatorInstances: rows });
    return rows.map((row: { id: string; category: string }) => ({ id: row.id, category: row.category }));
  }, id);
  await page.getByRole('button', { name: '닫기', exact: true }).click();
  const count = () => page.evaluate(id => (window as unknown as ChartWindow).__liveCharts.get(id)?.panes().length ?? 0, id);
  await expect.poll(count).toBeGreaterThanOrEqual(9); // existing panes plus all minute pane instances
  for (const category of ['bollinger', 'supertrend', 'moving-average', 'depth-heatmap', 'trade-volume-poc', 'peak-walls']) {
    const row = inserted.find((row: { category: string }) => row.category === category)!;
    await expect(page.getByTestId('pane-legend-rows-candle').getByTestId(`indicator-instance-legend-${row.id}`)).toBeVisible();
  }
  await expect(page.getByRole('region', { name: '연속체결 매물대 분포 10구간' })).toHaveCount(1);
  await page.evaluate(async id => {
    const workspacePath = '/src/state/workspace.ts'; const { useWorkspaceStore } = await import(workspacePath);
    useWorkspaceStore.getState().setChartTimeframe(id, 'D');
  }, id);
  await expect.poll(count).toBe(8); // candle + original volume + six additional daily panels
  const paneValues = () => page.evaluate(id => (window as unknown as ChartWindow).__liveCharts.get(id)!.panes().map(pane => pane.getSeries().filter(series => series.seriesType() === 'Histogram').map(series => series.data().map(point => 'value' in point ? point.value : null))), id);
  await expect.poll(async () => (await paneValues()).flat(2)).toEqual(expect.arrayContaining([200, 380, 90, 10]));
  expect(errors.filter(message => !message.startsWith('ResizeObserver loop'))).toEqual([]);
});

for (const theme of ['toss-light', 'toss-dark']) {
  test(`${theme}: volume color mode updates bars, stays independent per instance and survives undo, reload and overlay`, async ({ page }, info) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(theme => localStorage.setItem('ui.themePreference.v1', JSON.stringify({ themePreference: theme })), theme);
    const id = await setup(page);
    const editor = page.getByTestId('indicator-panel-shell');
    const histogramColors = () => page.evaluate(id => (window as unknown as ChartWindow).__liveCharts.get(id)!.panes()
      .flatMap(pane => pane.getSeries().filter(series => series.seriesType() === 'Histogram')
        .map(series => (series as ISeriesApi<'Histogram'>).data().filter(row => 'value' in row && row.value === 100).slice(1, 100).map(row => 'color' in row ? row.color : undefined))), id);
    await editor.getByRole('button', { name: '내 지표', exact: true }).click();
    await editor.getByRole('button', { name: '거래량', exact: true }).click();
    await expect(editor.getByRole('radio', { name: '캔들 색상과 동일', exact: true })).toBeChecked();
    await expect.poll(async () => new Set((await histogramColors())[0]).size).toBe(2);
    await editor.getByRole('radio', { name: '이전 거래량과 비교', exact: true }).check();
    await expect.poll(async () => new Set((await histogramColors())[0]).size).toBe(1);
    await expect(editor.getByText('거래량 증가 빨강', { exact: true })).toBeVisible();
    await editor.getByRole('button', { name: '되돌리기', exact: true }).click();
    await expect(editor.getByRole('radio', { name: '캔들 색상과 동일', exact: true })).toBeChecked();
    await expect.poll(async () => new Set((await histogramColors())[0]).size).toBe(2);
    await editor.getByRole('radio', { name: '이전 거래량과 비교', exact: true }).check();
    await editor.getByRole('button', { name: '지표 추가', exact: true }).click();
    await editor.getByRole('button', { name: '거래량', exact: true }).click();
    await editor.getByRole('radio', { name: '캔들 색상과 동일', exact: true }).check();
    await editor.getByRole('button', { name: '설정대로 추가', exact: true }).click();
    await editor.getByRole('button', { name: '내 지표', exact: true }).click();
    await editor.getByRole('button', { name: '거래량 1 설정', exact: true }).click();
    await expect(editor.getByRole('radio', { name: '이전 거래량과 비교', exact: true })).toBeChecked();
    await expect.poll(async () => (await histogramColors()).map(rows => new Set(rows).size)).toEqual([1, 2]);
    await editor.screenshot({ path: info.outputPath(`volume-color-${theme}.png`) });
    await page.setViewportSize({ width: 390, height: 844 });
    await editor.screenshot({ path: info.outputPath(`volume-color-${theme}-390.png`) });
    const width = await editor.evaluate(el => ({ width: el.clientWidth, scroll: el.scrollWidth }));
    expect(width.scroll).toBeLessThanOrEqual(width.width + 1);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.keyboard.press('Escape');
    await page.evaluate(() => history.replaceState(null, '', '/live'));
    await page.reload();
    await expect.poll(async () => (await state(page, id)).volumeColorMode).toBe('previous-volume');
    expect((await state(page, id)).indicatorInstances[0].settings.volumeColorMode).toBe('candle');
    await expect.poll(async () => (await histogramColors()).map(rows => new Set(rows).size)).toEqual([1, 2]);
    await page.locator(`[data-win="${id}"]`).getByRole('button', { name: '차트 설정', exact: true }).click();
    await page.getByRole('switch', { name: '거래량을 캔들에 겹쳐 표시', exact: true }).click();
    await expect.poll(() => page.evaluate(id => {
      const series = (window as unknown as ChartWindow).__liveCharts.get(id)!.panes()[0].getSeries()
        .find(series => series.seriesType() === 'Histogram') as ISeriesApi<'Histogram'> | undefined;
      if (!series) return null;
      return new Set(series.data().filter(row => 'value' in row && row.value === 100).slice(1, 100).map(row => 'color' in row ? row.color : undefined)).size;
    }, id)).toBe(1);
    expect(errors.filter(message => !message.startsWith('ResizeObserver loop'))).toEqual([]);
  });
}
