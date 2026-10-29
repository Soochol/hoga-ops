import { expect, test, type Page } from '@playwright/test';
import type { IChartApi, ISeriesApi } from 'lightweight-charts';
import { installLiveMocks } from './helpers/liveMocks';
import { apiExact } from './helpers/apiRoutes';

type Charts = Window & { __liveCharts: Map<string, IChartApi> };
async function state(page: Page, id: string) {
  return page.evaluate(async id => {
    const path = '/src/state/livePage.ts', scopePath = '/src/state/indicatorSettingsV2.ts';
    const { useLivePageStore } = await import(path); const { resolveIndicatorSettings, bucketsForScope } = await import(scopePath);
    const s = useLivePageStore.getState();
    return resolveIndicatorSettings(bucketsForScope(s.indicatorsByTimeframe, s.indicatorsByWindow, { windowKey: `live:${id}` }), '1m');
  }, id);
}
for (const theme of ['toss-light', 'toss-dark']) {
  test(`${theme}: 선택 항목 초기화·숨김 유지·되돌리기·재시작 복원`, async ({ page }, info) => {
    const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.clock.setFixedTime(new Date('2026-05-28T17:00:00+09:00'));
    await page.addInitScript(theme => localStorage.setItem('ui.themePreference.v1', JSON.stringify({ themePreference: theme })), theme);
    await installLiveMocks(page);
    const start = Date.parse('2026-05-27T09:00:00+09:00');
    await page.route(apiExact('live/past-candles'), r => r.fulfill({ json: {
      code: '098460', from: '20260527', to: '20260528', cached_dates: ['20260527'], fresh_dates: [], data_warnings: [],
      candles: Array.from({ length: 130 }, (_, i) => ({ t_ms: start + i * 60000, open: 35000 + i,
        close: 35000 + i + Math.sin(i / 3) * 20, high: 35100 + i, low: 34900 + i, volume: 100 })),
    } }));
    await page.goto('/live?code=098460');
    await expect.poll(() => page.evaluate(() => (window as unknown as Charts).__liveCharts?.size ?? 0)).toBe(1);
    const id = await page.evaluate(() => [...(window as unknown as Charts).__liveCharts.keys()][0]);
    const editor = page.getByTestId('indicator-panel-shell');
    await page.getByTestId('live-indicators-button').click();
    await editor.getByRole('button', { name: '지표 추가', exact: true }).click();
    await editor.getByRole('button', { name: '볼린저 밴드', exact: true }).click();
    const period = editor.getByRole('spinbutton', { name: '볼린저 기간' });
    await period.fill('30'); await period.press('Enter');
    await editor.getByRole('button', { name: '설정대로 추가', exact: true }).click();
    await editor.getByRole('button', { name: '하나 더 추가', exact: true }).click();
    await period.fill('60'); await period.press('Enter');
    await editor.getByRole('switch', { name: '볼린저 하단선 표시', exact: true }).click();
    await editor.getByRole('button', { name: '설정대로 추가', exact: true }).click();
    await editor.getByRole('button', { name: '내 지표', exact: true }).click();
    await editor.getByRole('button', { name: '볼린저 밴드 2 설정', exact: true }).click();
    await editor.getByRole('button', { name: '볼린저 밴드 2 숨기기', exact: true }).click();
    const before = (await state(page, id)).indicatorInstances[0];
    const reset = editor.getByRole('button', { name: '볼린저 밴드 초기화', exact: true });
    const copy = editor.getByRole('button', { name: '설정 복사해서 추가', exact: true });
    expect((await reset.boundingBox())!.x).toBeGreaterThan((await copy.boundingBox())!.x);
    await reset.click();
    await expect(period).toHaveValue('20');
    await expect.poll(async () => (await state(page, id)).indicatorInstances[0]).toMatchObject({ id: before.id, hidden: true,
      settings: { bollingerPeriod: 20, bollingerMultiplier: 2, indicatorLineVisibility: {} } });
    expect((await state(page, id)).bollingerPeriod).toBe(30);
    const undo = editor.getByRole('button', { name: '되돌리기', exact: true });
    await expect(undo).toBeEnabled(); await undo.click();
    await expect(period).toHaveValue('60');
    await expect.poll(async () => (await state(page, id)).indicatorInstances[0]).toEqual(before);
    await reset.click(); await expect(period).toHaveValue('20');
    await editor.getByRole('button', { name: '볼린저 밴드 2 표시', exact: true }).click();
    await expect.poll(() => page.evaluate(id => (window as unknown as Charts).__liveCharts.get(id)!.panes()[0].getSeries()
      .filter(s => s.seriesType() === 'Line' && (s as ISeriesApi<'Line'>).options().color === '#3B82F6' && s.options().visible).length, id)).toBe(4);
    await page.getByRole('dialog', { name: '지표', exact: true }).getByRole('button', { name: '닫기', exact: true }).click();
    await page.evaluate(() => history.replaceState(null, '', '/live')); await page.reload();
    await expect.poll(async () => (await state(page, id)).indicatorInstances[0]?.settings.bollingerPeriod).toBe(20);
    expect((await state(page, id)).bollingerPeriod).toBe(30);
    await page.getByTestId('live-indicators-button').click();
    await editor.getByRole('button', { name: '볼린저 밴드 2 설정', exact: true }).click();
    await editor.screenshot({ path: info.outputPath(`reset-${theme}.png`) });
    await page.setViewportSize({ width: 390, height: 844 });
    const width = await editor.evaluate(el => ({ client: el.clientWidth, scroll: el.scrollWidth }));
    expect(width.scroll).toBeLessThanOrEqual(width.client + 1);
    await editor.screenshot({ path: info.outputPath(`reset-${theme}-390.png`) });
    expect(errors.filter(e => !e.startsWith('ResizeObserver loop'))).toEqual([]);
  });
}
