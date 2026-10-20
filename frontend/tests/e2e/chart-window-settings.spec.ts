import { test, expect, type Page } from '@playwright/test';
import type { IChartApi, ISeriesApi } from 'lightweight-charts';
import { installLiveMocks } from './helpers/liveMocks';
import { apiExact } from './helpers/apiRoutes';
import { CHART_DISPLAY_TOGGLES, DEFAULT_CHART_DISPLAY_PREFS } from '../../src/state/chartDisplayPrefs';
import type { LiveLayoutPreset, LiveLayoutPresetPayload } from '../../src/api/liveLayoutPresets';

type ChartsWindow = Window & { __liveCharts?: Map<string, IChartApi> };
const initial = { ...DEFAULT_CHART_DISPLAY_PREFS, candlePaneCandleOnlyScale: true, auctionWindowMask: false };

async function setup(page: Page) {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.addInitScript(initial => {
    if (sessionStorage.getItem('window-settings-fixture')) return;
    sessionStorage.setItem('window-settings-fixture', '1');
    localStorage.setItem('hoga.chart.prefs.v1', JSON.stringify(initial));
    sessionStorage.setItem('live.workspace.v1', JSON.stringify({ schema_version: 2,
      windows: ['a', 'b'].map((id, i) => ({ id, kind: 'chart', group: 1, chart: { timeframe: '1m' },
        rect: { x: i * .5, y: 0, w: .49, h: .8 } })),
      zOrder: ['a', 'b'], groupSymbols: { 1: { code: '098460', name: '고영' } },
    }));
  }, initial);
  await installLiveMocks(page);
}

async function open(page: Page, id: string) {
  await page.locator(`[data-win="${id}"]`).getByRole('button', { name: '차트 설정', exact: true }).click();
  const panel = page.getByRole('dialog', { name: '차트 설정', exact: true });
  await expect(panel.getByText('이 차트에 적용', { exact: true })).toBeVisible();
  return panel;
}

async function expectGrid(page: Page, id: string, horizontal: boolean, vertical: boolean) {
  await expect.poll(() => page.evaluate(id => {
    const options = (window as ChartsWindow).__liveCharts?.get(id)?.options().grid;
    return options ? [options.horzLines.visible, options.vertLines.visible] : null;
  }, id)).toEqual([horizontal, vertical]);
}

test('6개 옵션이 같은 종목·그룹의 두 차트에서 독립 적용되고 새로고침 후 복원된다', async ({ page }) => {
  await setup(page);
  await page.goto('/live');
  const a = await open(page, 'a');
  for (const def of CHART_DISPLAY_TOGGLES) {
    const toggle = a.getByRole('switch', { name: def.label, exact: true });
    await expect(toggle).toHaveAttribute('aria-checked', String(initial[def.key]));
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', String(!initial[def.key]));
  }
  await page.keyboard.press('Escape');
  await expectGrid(page, 'a', false, false);
  await expectGrid(page, 'b', true, true);
  const hover = await page.evaluate(() => {
    const chart = (window as ChartsWindow).__liveCharts!.get('a')!;
    const candle = chart.panes()[0].getSeries().find(series => series.seriesType() === 'Candlestick') as ISeriesApi<'Candlestick'>;
    const point = candle.data().at(-1);
    if (!point || !('close' in point)) return null;
    const x = chart.timeScale().timeToCoordinate(point.time), y = candle.priceToCoordinate(point.close);
    const rect = chart.chartElement().getBoundingClientRect();
    return x === null || y === null ? null : { x: rect.x + x, y: rect.y + y,
      onTop: candle.seriesOrder() === chart.panes()[0].getSeries().length - 1 };
  });
  expect(hover).not.toBeNull();
  expect(hover!.onTop).toBe(true);
  await page.mouse.move(hover!.x, hover!.y);
  await expect(page.locator('[data-win="a"]').getByTestId('candle-tooltip')).toBeVisible();
  await expect(page.locator('[data-win="b"]').getByTestId('candle-tooltip')).toHaveCount(0);
  const b = await open(page, 'b');
  for (const def of CHART_DISPLAY_TOGGLES) await expect(b.getByRole('switch', { name: def.label, exact: true })).toHaveAttribute('aria-checked', String(initial[def.key]));
  await page.keyboard.press('Escape');
  await page.reload();
  const restored = await open(page, 'a');
  for (const def of CHART_DISPLAY_TOGGLES) await expect(restored.getByRole('switch', { name: def.label, exact: true })).toHaveAttribute('aria-checked', String(!initial[def.key]));
  await page.keyboard.press('Escape');
  await expectGrid(page, 'a', false, false);
  await expectGrid(page, 'b', true, true);
  // Same window keeps its display choices when switching timeframe.
  await page.locator('[data-win="a"]').getByTestId('chart-window-header').getByRole('button', { name: '일', exact: true }).click();
  const calendar = await open(page, 'a');
  for (const def of CHART_DISPLAY_TOGGLES) await expect(calendar.getByRole('switch', { name: def.label, exact: true })).toHaveAttribute('aria-checked', String(!initial[def.key]));
  await page.keyboard.press('Escape');
  // The production Add Window flow copies the focused chart, then edits independently.
  await page.locator('[data-win="a"]').locator('.live-symbol-name').click();
  await page.getByRole('button', { name: '창 추가', exact: true }).click();
  await page.getByTestId('workspace-add-chart').click();
  const added = page.locator('.live-window-chart:not([data-win="a"]):not([data-win="b"])');
  await expect(added).toHaveCount(1);
  const addedId = (await added.getAttribute('data-win'))!;
  const copied = await open(page, addedId);
  for (const def of CHART_DISPLAY_TOGGLES) await expect(copied.getByRole('switch', { name: def.label, exact: true })).toHaveAttribute('aria-checked', String(!initial[def.key]));
  await copied.getByRole('switch', { name: '가로 구분선', exact: true }).click();
  await page.keyboard.press('Escape');
  await added.getByRole('button', { name: /창 닫기$/ }).click();
  const parent = await open(page, 'a');
  await expect(parent.getByRole('switch', { name: '가로 구분선', exact: true })).toHaveAttribute('aria-checked', 'false');
  await page.keyboard.press('Escape');
  const otherTab = await page.context().newPage();
  await installLiveMocks(otherTab);
  await otherTab.goto('/live');
  const inherited = await open(otherTab, 'a');
  for (const def of CHART_DISPLAY_TOGGLES) await expect(inherited.getByRole('switch', { name: def.label, exact: true })).toHaveAttribute('aria-checked', String(!initial[def.key]));
  await otherTab.close();
});

test('워크스페이스 메뉴 저장·다른 배치 적용·복원에 차트별 설정이 포함된다', async ({ page }, info) => {
  await setup(page);
  const presets: LiveLayoutPreset[] = [];
  await page.route(apiExact('live-layout-presets'), async route => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON() as { name: string; payload: LiveLayoutPresetPayload };
      const row: LiveLayoutPreset = { schema_version: 3, id: 'saved-a', name: body.name, payload: body.payload, created_at_ms: 1, updated_at_ms: 1 };
      presets.push(row);
      await route.fulfill({ json: row });
    } else await route.fulfill({ json: { schema_version: 3, presets } });
  });
  await page.goto('/live');
  const panel = await open(page, 'a');
  await panel.getByRole('switch', { name: '가로 구분선', exact: true }).click();
  await panel.getByRole('switch', { name: '캔들 정보 툴팁', exact: true }).click();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '레이아웃 프리셋', exact: true }).click();
  await page.getByRole('menuitem', { name: '새 프리셋으로 저장…', exact: true }).click();
  await page.getByPlaceholder('프리셋 이름').fill('창별 차트');
  await page.getByTestId('layout-preset-save-as-confirm').click();
  await expect.poll(() => presets.length).toBe(1);
  const stored = presets[0].payload.windows as { id: string; windowSettings: { chart: typeof initial } }[];
  expect(stored.find(win => win.id === 'a')!.windowSettings.chart.horizontalGridLinesEnabled).toBe(false);
  expect(stored.find(win => win.id === 'b')!.windowSettings.chart.horizontalGridLinesEnabled).toBe(true);
  expect(stored.find(win => win.id === 'a')!.windowSettings.chart.candleTooltipEnabled).toBe(true);
  // Apply another workspace through the same production entry point used by the menu.
  await page.evaluate(async () => {
    const path = '/src/live/presets/layoutPresetSnapshot.ts';
    const { applyPresetPayload } = await import(path);
    applyPresetPayload({ windows: [{ id: 'other', kind: 'chart', group: 1, chart: { timeframe: '5m' },
      rect: { x: 0, y: 0, w: .6, h: .8 } }], zOrder: ['other'], groupSymbols: {} }, null);
  });
  await expect(page.locator('[data-win="a"]')).toHaveCount(0);
  await page.getByRole('button', { name: '레이아웃 프리셋', exact: true }).click();
  await page.getByRole('menuitem', { name: '창별 차트', exact: true }).click();
  await expect(page.locator('[data-win="a"]')).toBeVisible();
  await expectGrid(page, 'a', false, true);
  await expectGrid(page, 'b', true, true);
  const restored = await open(page, 'a');
  await expect(restored.getByRole('switch', { name: '캔들 정보 툴팁', exact: true })).toHaveAttribute('aria-checked', 'true');
  await page.screenshot({ path: info.outputPath('per-window-settings-restored.png') });
  await page.keyboard.press('Escape');
  // Reapplying the same preset must overwrite edits, including when ids survive.
  const changed = await open(page, 'a');
  await changed.getByRole('switch', { name: '가로 구분선', exact: true }).click();
  await page.keyboard.press('Escape');
  await expectGrid(page, 'a', true, true);
  await page.getByRole('button', { name: '레이아웃 프리셋', exact: true }).click();
  await page.getByRole('menuitem', { name: '창별 차트', exact: true }).click();
  await expectGrid(page, 'a', false, true);
});
