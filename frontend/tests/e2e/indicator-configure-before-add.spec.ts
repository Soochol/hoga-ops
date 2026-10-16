import { expect, test, type Page } from '@playwright/test';
import type { IChartApi, ISeriesApi } from 'lightweight-charts';
import { installLiveMocks } from './helpers/liveMocks';
import { apiExact } from './helpers/apiRoutes';

type ChartWindow = Window & { __liveCharts: Map<string, IChartApi> };
async function setup(page: Page) {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.clock.setFixedTime(new Date('2026-05-28T17:00:00+09:00'));
  await installLiveMocks(page);
  await page.route(apiExact('live/settings'), r => r.fulfill({ json: {
    schema_version: 1, rest_bypass_enabled: false, screener_depth_autocollect: false, krx_prefer_hogaplay: false,
  } }));
  const start = Date.parse('2026-05-27T09:00:00+09:00');
  await page.route(apiExact('live/past-candles'), r => r.fulfill({ json: {
    code: '098460', from: '20260527', to: '20260528', cached_dates: ['20260527'], fresh_dates: [], data_warnings: [],
    candles: Array.from({ length: 130 }, (_, i) => ({
      t_ms: start + i * 60_000, open: 35000 + i, close: 35000 + i + Math.sin(i / 3) * 20,
      high: 35100 + i, low: 34900 + i, volume: 100,
    })),
  } }));
  await page.goto('/live?code=098460');
  await expect.poll(() => page.evaluate(() => (window as unknown as ChartWindow).__liveCharts?.size ?? 0)).toBe(1);
  const id = await page.evaluate(() => [...(window as unknown as ChartWindow).__liveCharts.keys()][0]);
  await page.getByTestId('live-indicators-button').click();
  await page.getByRole('button', { name: '지표 추가', exact: true }).click();
  return id;
}
async function snapshot(page: Page, id: string) {
  return page.evaluate(async id => {
    const snapshotsPath = '/src/live/settings/editorSnapshots.ts';
    const scopePath = '/src/live/workspace/windowViewContext.ts';
    const { readIndicatorEditor } = await import(snapshotsPath);
    const { windowScopeKey } = await import(scopePath);
    return readIndicatorEditor({ windowKey: windowScopeKey(id) }, '1m', false);
  }, id);
}
async function bands(page: Page, id: string) {
  return page.evaluate(id => (window as unknown as ChartWindow).__liveCharts.get(id)?.panes()[0].getSeries()
    .filter(s => s.seriesType() === 'Line' && (s as ISeriesApi<'Line'>).options().color === '#3B82F6').map(s => ({ visible: s.options().visible, points: s.data().length })), id);
}

for (const theme of ['toss-light', 'toss-dark']) {
  test(`${theme}: configure in catalog, commit once, stay in catalog, undo and reload`, async ({ page }, testInfo) => {
    await page.addInitScript(theme => localStorage.setItem('ui.themePreference.v1', JSON.stringify({ themePreference: theme })), theme);
    const id = await setup(page);
    const editor = page.getByTestId('indicator-panel-shell');
    const before = await snapshot(page, id);
    await editor.getByRole('button', { name: '볼린저 밴드', exact: true }).click();
    await editor.getByRole('spinbutton', { name: '볼린저 기간', exact: true }).fill('35');
    await editor.getByRole('spinbutton', { name: '볼린저 기간', exact: true }).press('Enter');
    await editor.getByRole('switch', { name: '볼린저 하단선 표시', exact: true }).click();
    await expect(editor.locator('[data-preview-line="하단선"]')).toHaveCount(0);
    await expect.poll(() => bands(page, id)).toEqual([]);
    expect(await snapshot(page, id)).toEqual(before);
    await editor.getByRole('button', { name: '슈퍼트렌드', exact: true }).click();
    await editor.getByRole('spinbutton', { name: '슈퍼트렌드 ATR 배수' }).fill('4.5');
    await editor.getByRole('spinbutton', { name: '슈퍼트렌드 ATR 배수' }).press('Enter');
    await editor.getByRole('button', { name: '볼린저 밴드', exact: true }).click();
    await expect(editor.getByRole('spinbutton', { name: '볼린저 기간' })).toHaveValue('35');
    // Clicking directly after typing must commit the focused field's final value too.
    await editor.getByRole('spinbutton', { name: '볼린저 표준편차 배수' }).fill('2.5');
    await editor.getByRole('button', { name: '설정대로 추가', exact: true }).click();
    await expect(editor.getByRole('button', { name: '지표 추가', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(editor.getByRole('button', { name: '추가됨', exact: true })).toBeDisabled();
    await expect.poll(() => bands(page, id)).toEqual([{ visible: true, points: 130 }, { visible: false, points: 130 }]);
    const added = await snapshot(page, id);
    expect(added).toMatchObject({ 'indicator:bollingerEnabled': true, 'indicator:bollingerPeriod': 35,
      'indicator:bollingerMultiplier': 2.5, 'indicator:supertrendEnabled': false });
    await editor.screenshot({ path: testInfo.outputPath(`configured-add-${theme}.png`) });
    await editor.getByRole('button', { name: '되돌리기', exact: true }).click();
    await expect.poll(() => snapshot(page, id)).toEqual(before);
    await expect(editor.getByRole('spinbutton', { name: '볼린저 기간' })).toHaveValue('35');
    await editor.getByRole('button', { name: '설정대로 추가', exact: true }).click();
    await page.keyboard.press('Escape');
    await page.evaluate(() => history.replaceState(null, '', '/live'));
    await page.reload();
    await page.getByTestId('live-indicators-button').click();
    await editor.getByRole('button', { name: '볼린저 밴드', exact: true }).click();
    await expect(editor.getByRole('spinbutton', { name: '볼린저 기간' })).toHaveValue('35');
    await expect(editor.getByRole('spinbutton', { name: '볼린저 표준편차 배수' })).toHaveValue('2.5');
    // The unadded Supertrend draft must be discarded with the previous dialog.
    await editor.getByRole('button', { name: '지표 추가', exact: true }).click();
    await editor.getByRole('button', { name: '슈퍼트렌드', exact: true }).click();
    await expect(editor.getByRole('spinbutton', { name: '슈퍼트렌드 ATR 배수' })).toHaveValue('3');
  });
}

test('catalog forms never mutate the chart while browsing and the add footer fits narrow screens', async ({ page }, testInfo) => {
  const id = await setup(page);
  const editor = page.getByTestId('indicator-panel-shell');
  const before = await snapshot(page, id);
  const names = await editor.locator('.indicator-nav-row > button:first-child').evaluateAll(buttons => buttons.map(b => b.getAttribute('aria-label')!));
  for (const name of names) {
    await editor.getByRole('button', { name, exact: true }).click();
    expect(await snapshot(page, id)).toEqual(before);
  }
  for (const width of [1440, 640, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    const maLabel = editor.getByRole('button', { name: '이동평균선', exact: true }).locator('.indicator-nav-label');
    await expect(maLabel).toHaveText('이동평균선 #1');
    const maGeometry = await maLabel.evaluate(el => {
      const name = el.querySelector('.indicator-nav-name')!, count = el.querySelector('.indicator-nav-summary')!;
      const nameRect = name.getBoundingClientRect(), countRect = count.getBoundingClientRect();
      return { nameHeight: nameRect.height, lineHeight: parseFloat(getComputedStyle(name).lineHeight), topDifference: Math.abs(nameRect.top - countRect.top), countRight: countRect.right, labelRight: el.getBoundingClientRect().right };
    });
    expect(maGeometry.nameHeight).toBeLessThanOrEqual(maGeometry.lineHeight + 1);
    expect(maGeometry.topDifference).toBeLessThan(4);
    expect(maGeometry.countRight).toBeLessThanOrEqual(maGeometry.labelRight + 1);
    await editor.getByRole('button', { name: '볼린저 밴드', exact: true }).click();
    await expect(editor.getByRole('spinbutton', { name: '볼린저 기간' })).toBeVisible();
    await expect(editor.getByRole('button', { name: '설정대로 추가', exact: true })).toBeVisible();
    await expect(editor.getByRole('button', { name: '되돌리기', exact: true })).toBeVisible();
    await expect(async () => {
      expect(await editor.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
      expect(await editor.locator('.settings-editor-main').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
      expect(await editor.locator('.settings-editor-footer').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    }).toPass();
    await editor.screenshot({ path: testInfo.outputPath(`catalog-configure-${width}.png`) });
  }
});
