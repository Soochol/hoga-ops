import { expect, test, type Page } from '@playwright/test';
import type { IChartApi, ISeriesApi } from 'lightweight-charts';
import { installLiveMocks } from './helpers/liveMocks';
import { apiExact } from './helpers/apiRoutes';

type ChartWindow = Window & { __liveCharts?: Map<string, IChartApi> };
const themes = [
  { id: 'obsidian-pro', label: 'Obsidian Pro', bg: '#171a20', accent: '#e9b44c', up: '#ff747f', down: '#7aafff', scheme: 'dark' },
  { id: 'ledger-studio', label: 'Ledger Studio', bg: '#fffefa', accent: '#28664d', up: '#ba3a47', down: '#285eb3', scheme: 'light' },
  { id: 'trading-desk', label: 'Trading Desk', bg: '#121811', accent: '#c7fa79', up: '#f47f89', down: '#82b1fa', scheme: 'dark' },
] as const;

async function installMocks(page: Page) {
  await page.clock.setFixedTime(new Date('2026-05-28T17:00:00+09:00'));
  await installLiveMocks(page);
  await page.route(apiExact('symbols/info'), route => route.fulfill({ json: {
    count: 1, fetched_at_ms: Date.now(), status: 'fresh', reason: null,
  } }));
  await page.route(apiExact('live/settings'), route => route.fulfill({ json: {
    schema_version: 1, rest_bypass_enabled: false, screener_depth_autocollect: false, krx_prefer_hogaplay: false,
  } }));
}

for (const initial of themes) {
  test(`${initial.label}: first paint, selection, chart colors, reload and cross-tab sync`, async ({ page, context }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await installMocks(page);
    // Seed once, so a reload exercises the preference written by the UI.
    await page.addInitScript(id => {
      if (!localStorage.getItem('ui.themePreference.v1')) {
        localStorage.setItem('ui.themePreference.v1', JSON.stringify({ themePreference: id }));
      }
    }, initial.id);
    await page.goto('/live?code=098460');
    await expect(page.locator('html')).toHaveAttribute('data-theme', initial.id);
    const chartHeader = page.getByTestId('chart-window-header').first();
    await expect(chartHeader).toBeVisible();
    const windowId = await chartHeader.evaluate(el => el.closest('.live-window')!.getAttribute('data-win'));

    const otherTab = await context.newPage();
    await installMocks(otherTab);
    await otherTab.goto('/live?code=098460');
    await expect(otherTab.locator('html')).toHaveAttribute('data-theme', initial.id);

    await page.getByRole('button', { name: '설정', exact: true }).first().click();
    const editor = page.getByTestId('settings-shell');
    await editor.getByTestId('settings-nav-theme').click();
    const picker = editor.getByRole('group', { name: '테마 선택', exact: true });
    await expect(picker.getByRole('button')).toHaveCount(7);
    await expect(picker.getByRole('button', { name: initial.label, exact: true })).toHaveAttribute('aria-pressed', 'true');

    const next = themes.find(theme => theme.id !== initial.id)!;
    await picker.getByRole('button', { name: next.label, exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', next.id);
    await expect(otherTab.locator('html')).toHaveAttribute('data-theme', next.id);
    await expect.poll(() => page.evaluate(() => {
      const style = getComputedStyle(document.documentElement);
      return ['--bg-card', '--accent', '--price-up', '--price-down', '--color-scheme']
        .map(token => style.getPropertyValue(token).trim());
    })).toEqual([next.bg, next.accent, next.up, next.down, next.scheme]);

    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      await expect(picker.getByRole('button', { name: next.label, exact: true })).toBeVisible();
      expect(await picker.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await editor.screenshot({ path: testInfo.outputPath(`${next.id}-settings.png`) });
    await editor.getByRole('button', { name: '닫기', exact: true }).click();
    await expect.poll(() => page.evaluate(id => {
      const charts = (window as ChartWindow).__liveCharts;
      const chart = id ? charts?.get(id) : undefined;
      if (!chart) return null;
      const candle = chart.panes().flatMap(pane => pane.getSeries()).find(series => series.seriesType() === 'Candlestick') as ISeriesApi<'Candlestick'> | undefined;
      return {
        background: chart.options().layout.background,
        crosshairLabel: chart.options().crosshair.vertLine.labelBackgroundColor,
        up: candle?.options().upColor, down: candle?.options().downColor,
      };
    }, windowId)).toEqual({ background: { type: 'solid', color: next.bg }, crosshairLabel: next.accent, up: next.up, down: next.down });
    await page.screenshot({ path: testInfo.outputPath(`${next.id}-workspace.png`) });

    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', next.id);
    await page.getByRole('button', { name: '설정', exact: true }).first().click();
    await editor.getByTestId('settings-nav-theme').click();
    await expect(picker.getByRole('button', { name: next.label, exact: true })).toHaveAttribute('aria-pressed', 'true');
    await otherTab.close();
  });
}

test('Trading Desk changes presentation while retaining saved windows, groups and pins', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1600, height: 1100 });
  await installMocks(page);
  await page.route(/^https?:\/\/[^/]+\/api\/live\/quotes\?/, route => route.fulfill({ json: {
    phase: 'open', quotes: [{ code: '098460', price: 35250, baseline_price: 35000, change_pct: 0.71, change_won: 250 }],
  } }));
  await page.addInitScript(() => {
    if (sessionStorage.getItem('live.workspace.v1')) return;
    localStorage.setItem('ui.themePreference.v1', JSON.stringify({ themePreference: 'ledger' }));
    sessionStorage.setItem('live.workspace.v1', JSON.stringify({ schema_version: 2,
      windows: [
        { id: 'desk-chart', kind: 'chart', group: 1, rect: { x: 0, y: 0, w: 0.62, h: 0.62 }, chart: { timeframe: '1m' } },
        { id: 'desk-book', kind: 'book', group: 1, rect: { x: 0, y: 0.62, w: 0.4, h: 0.38 }, pinned: { code: '098460', name: '고영' } },
        { id: 'desk-tape', kind: 'trade', group: 1, rect: { x: 0.4, y: 0.62, w: 0.22, h: 0.38 } },
        { id: 'desk-order', kind: 'order', group: 1, rect: { x: 0.62, y: 0, w: 0.38, h: 1 } },
      ],
      zOrder: ['desk-book', 'desk-tape', 'desk-order', 'desk-chart'],
      groupSymbols: { 1: { code: '098460', name: '고영' } },
    }));
  });
  await page.goto('/live');
  const chart = page.locator('[data-win="desk-chart"]');
  await expect(chart.getByTestId('titlebar-current-price')).toHaveText('35,250');
  const readLayout = () => page.evaluate(() => {
    const stored = JSON.parse(sessionStorage.getItem('live.workspace.v1')!);
    return {
      windows: stored.windows.map(({ id, kind, group, rect, pinned }: {
        id: string; kind: string; group: number; rect: unknown; pinned?: unknown;
      }) => ({ id, kind, group, rect, pinned })),
      groupSymbols: stored.groupSymbols,
    };
  });
  const before = await readLayout();
  await page.getByRole('button', { name: '설정', exact: true }).first().click();
  const editor = page.getByTestId('settings-shell');
  await editor.getByTestId('settings-nav-theme').click();
  await editor.getByRole('button', { name: 'Trading Desk', exact: true }).click();
  await editor.getByRole('button', { name: '닫기', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'trading-desk');
  await expect(chart.getByTestId('titlebar-current-price')).toHaveCSS('font-size', '11.5px');
  await expect(chart.getByTestId('titlebar-current-price')).toHaveCSS('color', 'rgb(244, 127, 137)');
  // The whole titlebar, including its action buttons, stays on one row.
  const titlebar = chart.locator('.live-window-titlebar');
  const rowParts = [
    chart.locator('.live-symbol-name'),
    chart.getByTestId('titlebar-current-price'),
    chart.getByTestId('titlebar-change'),
    chart.getByRole('button', { name: '창 최대화', exact: true }),
    chart.getByRole('button', { name: '종목 고정', exact: true }),
  ];
  await expect.poll(async () => {
    const boxes = await Promise.all(rowParts.map(part => part.boundingBox()));
    if (boxes.some(box => box === null)) return Infinity;
    const centers = boxes.map(box => box!.y + box!.height / 2);
    return Math.max(...centers) - Math.min(...centers);
  }).toBeLessThanOrEqual(1);
  expect((await titlebar.boundingBox())!.height).toBeLessThanOrEqual(36);
  await expect(page.locator('[data-win="desk-book"]').getByRole('button', { name: '종목 고정', exact: true }))
    .toHaveAttribute('aria-pressed', 'true');
  expect(await readLayout()).toEqual(before);
  await page.screenshot({ path: testInfo.outputPath('trading-desk-saved-workspace.png') });

  await chart.getByRole('button', { name: '창 최대화', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(chart.getByRole('button', { name: '창 최대화', exact: true })).toBeVisible();
  expect(await readLayout()).toEqual(before);
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'trading-desk');
  await expect(chart.getByTestId('titlebar-current-price')).toHaveText('35,250');
  expect(await readLayout()).toEqual(before);
});
