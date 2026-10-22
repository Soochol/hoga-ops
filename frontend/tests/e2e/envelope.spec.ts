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
async function envelopeLines(page: Page, id: string) {
  return page.evaluate(id => (window as unknown as ChartWindow).__liveCharts.get(id)!.panes()[0].getSeries()
    .filter(s => s.seriesType() === 'Line' && s.options().title.startsWith('엔벨로프 '))
    .map(s => ({ visible: s.options().visible, values: (s as ISeriesApi<'Line'>).data() })), id);
}

for (const theme of ['toss-light', 'toss-dark']) {
  test(`${theme}: Envelope bands, independent instances, display, undo and persistence`, async ({ page }, info) => {
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(theme => localStorage.setItem('ui.themePreference.v1', JSON.stringify({ themePreference: theme })), theme);
    const id = await setup(page);
    const editor = page.getByTestId('indicator-panel-shell');
    await editor.getByRole('button', { name: '지표 추가', exact: true }).click();
    await editor.getByRole('button', { name: '엔벨로프', exact: true }).click();
    await expect(editor.getByRole('spinbutton', { name: '엔벨로프 기간' })).toHaveValue('20');
    await expect(editor.getByRole('spinbutton', { name: '엔벨로프 이격률 (%)' })).toHaveValue('2');
    expect((await state(page, id)).envelopeEnabled).toBe(false);
    await editor.getByRole('button', { name: '설정대로 추가', exact: true }).click();
    await expect.poll(async () => (await envelopeLines(page, id)).length).toBe(3);
    await expect.poll(async () => (await envelopeLines(page, id))[0].values.filter(p => 'value' in p).length).toBeGreaterThan(0);
    const values = (await envelopeLines(page, id)).map(line => line.values.at(-1)!);
    if (!values.every(p => 'value' in p)) throw new Error('Envelope bands have no values');
    expect(values[0].value).toBeCloseTo(values[1].value * 1.02, 7);
    expect(values[2].value).toBeCloseTo(values[1].value * .98, 7);
    await editor.getByRole('button', { name: '하나 더 추가', exact: true }).click();
    const period = editor.getByRole('spinbutton', { name: '엔벨로프 기간' });
    await period.fill('60'); await period.press('Enter');
    const percent = editor.getByRole('spinbutton', { name: '엔벨로프 이격률 (%)' });
    await percent.fill('5'); await percent.press('Enter');
    await editor.getByRole('switch', { name: '엔벨로프 하단선 표시' }).click();
    await editor.getByRole('button', { name: '설정대로 추가', exact: true }).click();
    await expect.poll(async () => (await envelopeLines(page, id)).length).toBe(6);
    const extra = (await state(page, id)).indicatorInstances[0];
    expect(extra.settings).toMatchObject({ envelopePeriod: 60, envelopePercent: 5, indicatorLineVisibility: { envelopeLower: false } });
    expect((await state(page, id)).envelopePeriod).toBe(20);
    await editor.getByRole('button', { name: '내 지표', exact: true }).click();
    await editor.getByRole('button', { name: '엔벨로프 2 설정', exact: true }).click();
    await expect.poll(async () => (await envelopeLines(page, id)).filter(s => s.visible).length).toBe(5);
    await editor.getByRole('button', { name: '엔벨로프 2 숨기기', exact: true }).click();
    await expect.poll(async () => (await envelopeLines(page, id)).filter(s => s.visible).length).toBe(3);
    await editor.getByRole('button', { name: '엔벨로프 2 표시', exact: true }).click();
    await editor.screenshot({ path: info.outputPath(`envelope-${theme}.png`) });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await editor.locator('.settings-editor-main').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await editor.screenshot({ path: info.outputPath(`envelope-${theme}-390.png`) });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await editor.getByRole('button', { name: '엔벨로프 2 삭제', exact: true }).click();
    await expect.poll(async () => (await envelopeLines(page, id)).length).toBe(3);
    await editor.getByRole('button', { name: '되돌리기', exact: true }).click();
    await expect.poll(async () => (await envelopeLines(page, id)).length).toBe(6);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('pane-legend-rows-candle').getByTestId(`indicator-instance-legend-${extra.id}`)).toBeVisible();
    await page.evaluate(() => history.replaceState(null, '', '/live')); await page.reload();
    await expect.poll(async () => (await state(page, id)).indicatorInstances[0]?.settings.envelopePercent).toBe(5);
    await expect.poll(async () => (await envelopeLines(page, id)).filter(s => s.visible).length).toBe(5);
    expect(errors.filter(message => !message.startsWith('ResizeObserver loop'))).toEqual([]);
  });
}
