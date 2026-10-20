import { test, expect, type Page } from '@playwright/test';
import type { IChartApi, ISeriesApi } from 'lightweight-charts';
import { installLiveMocks } from './helpers/liveMocks';
import { apiExact } from './helpers/apiRoutes';
import { CHART_DISPLAY_TOGGLES, DEFAULT_CHART_DISPLAY_PREFS } from '../../src/state/chartDisplayPrefs';
import type { LiveLayoutPreset, LiveLayoutPresetPayload } from '../../src/api/liveLayoutPresets';

type ChartsWindow = Window & { __liveCharts?: Map<string, IChartApi> };
const initial = { ...DEFAULT_CHART_DISPLAY_PREFS, candlePaneCandleOnlyScale: true, auctionWindowMask: false };

async function setup(page: Page, timeframe = '1m') {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.addInitScript(({ initial, timeframe }) => {
    if (sessionStorage.getItem('window-settings-fixture')) return;
    sessionStorage.setItem('window-settings-fixture', '1');
    localStorage.setItem('hoga.chart.prefs.v1', JSON.stringify(initial));
    sessionStorage.setItem('live.workspace.v1', JSON.stringify({ schema_version: 2,
      windows: ['a', 'b'].map((id, i) => ({ id, kind: 'chart', group: 1, chart: { timeframe },
        rect: { x: i * .5, y: 0, w: .49, h: .8 } })),
      zOrder: ['a', 'b'], groupSymbols: { 1: { code: '098460', name: '고영' } },
    }));
  }, { initial, timeframe });
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

async function expectPriceScale(page: Page, id: string, log: boolean, invert: boolean) {
  await expect.poll(() => page.evaluate(id => {
    const candle = (window as ChartsWindow).__liveCharts?.get(id)?.panes()
      .flatMap(p => p.getSeries()).find(s => s.seriesType() === 'Candlestick');
    const opts = candle?.priceScale().options();
    return opts ? [opts.mode, opts.invertScale] : null;
  }, id)).toEqual([log ? 1 : 0, invert]);
}

async function scaleFixtures(page: Page) {
  await page.clock.setFixedTime(new Date('2026-05-28T18:00:00+09:00'));
  await page.routeWebSocket(/\/api\/ws/, () => {});
  const daily = Array.from({ length: 143 }, (_, i) => {
    const t_ms = Date.UTC(2026, 0, 5 + i);
    const price = Math.round(10_000 * 1.015 ** i);
    return { t_ms, open: price, high: price + 500, low: price - 500, close: price + 200, volume: 1000 + i };
  }).filter(c => ![0, 6].includes(new Date(c.t_ms).getUTCDay()));
  await page.route(apiExact('live/past-daily-candles'), route => route.fulfill({ json: {
    code: new URL(route.request().url()).searchParams.get('code'), from: '20260105', to: '20260527', candles: daily,
    cached_batches: [], fresh_batches: [], data_warnings: [],
  } }));
  await page.route(apiExact('live/past-candles'), route => route.fulfill({ json: {
    code: new URL(route.request().url()).searchParams.get('code'), from: '20260527', to: '20260528',
    candles: [10_000, 20_000, 40_000, 60_000, 80_000].map((price, i) => ({
      t_ms: Date.UTC(2026, 4, 27, 0, i), open: price, high: price + 500,
      low: price - 500, close: price + 200, volume: 1000 + i,
    })), cached_dates: ['20260527'], fresh_dates: [], data_warnings: [],
  } }));
}

for (const timeframe of ['1m', 'D', 'W', 'M']) {
  test(`${timeframe}: 로그·반전 네 조합의 좌표, 가격 지표·드로잉, 하단 축과 가로 범위를 보존한다`, async ({ page }, info) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await setup(page, timeframe);
    await scaleFixtures(page);
    await page.goto('/live');
    await expect.poll(() => page.evaluate(() => {
      const c = (window as ChartsWindow).__liveCharts?.get('a')?.panes()[0]?.getSeries()
        .find(s => s.seriesType() === 'Candlestick');
      return c?.data().length ?? 0;
    })).toBeGreaterThan(3);
    await page.evaluate(async timeframe => {
      const path = '/src/state/drawings.ts';
      const { useDrawingsStore, drawingScopeFor } = await import(path);
      const store = useDrawingsStore.getState(), scope = drawingScopeFor('098460', timeframe);
      store.add(scope, { id: 'scale-hline', kind: 'hline', price: 35_000, paneId: 'candle',
        color: '#14B8A6', width: 2, lineStyle: 'solid' });
      store.setActiveTool('select');
    }, timeframe);
    // Keep the actual chart and candle identities, data, zoom and pan for comparison.
    await page.evaluate(async () => {
      const chart = (window as ChartsWindow).__liveCharts!.get('a')!;
      const candle = chart.panes()[0].getSeries().find(s => s.seriesType() === 'Candlestick')!;
      chart.timeScale().setVisibleLogicalRange({ from: -1, to: candle.data().length + 2 });
      // LWC applies setVisibleLogicalRange during paint; capture the rendered range.
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      Object.assign(window, { __scaleBefore: { chart, candle, data: candle.data(),
        range: chart.timeScale().getVisibleLogicalRange(), spacing: chart.timeScale().options().barSpacing,
        width: chart.timeScale().width(), scroll: chart.timeScale().scrollPosition() } });
    });
    for (const [log, invert] of [[false, false], [true, false], [true, true], [false, true]]) {
      const panel = await open(page, 'a');
      for (const [name, value] of [['로그 스케일', log], ['차트 거꾸로 보기', invert]] as const) {
        const toggle = panel.getByRole('switch', { name, exact: true });
        if (await toggle.getAttribute('aria-checked') !== String(value)) await toggle.click();
        await expect(toggle).toHaveAttribute('aria-checked', String(value));
      }
      if (timeframe === 'D' && log && invert) {
        await expectPriceScale(page, 'a', true, true);
        await page.screenshot({ path: info.outputPath('scale-settings.png'), animations: 'disabled' });
      }
      await page.keyboard.press('Escape');
      await expectPriceScale(page, 'a', log, invert);
      await expectPriceScale(page, 'b', false, false);
      const state = await page.evaluate(({ log }) => {
        const chart = (window as ChartsWindow).__liveCharts!.get('a')!;
        const candle = chart.panes()[0].getSeries().find(s => s.seriesType() === 'Candlestick') as ISeriesApi<'Candlestick'>;
        const rows = candle.data().filter(r => 'close' in r);
        const low = Math.min(...rows.map(r => r.low)), high = Math.max(...rows.map(r => r.high));
        const mid = log ? Math.sqrt(low * high) : (low + high) / 2;
        const yLow = candle.priceToCoordinate(low)!, yHigh = candle.priceToCoordinate(high)!;
        const yMid = candle.priceToCoordinate(mid)!;
        const before = (window as unknown as { __scaleBefore: { chart: IChartApi; candle: ISeriesApi<'Candlestick'>;
          data: unknown; range: { from: number; to: number }; spacing: number; width: number; scroll: number } }).__scaleBefore;
        const bounds = chart.chartElement().getBoundingClientRect();
        return {
          sameChart: chart === before.chart, sameSeries: candle === before.candle,
          sameData: JSON.stringify(candle.data()) === JSON.stringify(before.data),
          range: chart.timeScale().getVisibleLogicalRange(), beforeRange: before.range,
          // Longer log-axis tick labels may grow the gutter. Preserve bar pitch
          // and the right anchor; the left edge then follows the plot width.
          expectedFrom: before.range.from - (chart.timeScale().width() - before.width) / before.spacing,
          scroll: chart.timeScale().scrollPosition(), beforeScroll: before.scroll,
          sameSpacing: chart.timeScale().options().barSpacing === before.spacing,
          inverted: yHigh > yLow, middle: (yMid - yLow) / (yHigh - yLow),
          roundtrip: Number(candle.coordinateToPrice(yMid)), mid,
          lower: chart.panes().slice(1).flatMap(p => p.getSeries()).map(s => {
            const o = s.priceScale().options(); return [o.mode, o.invertScale];
          }),
          overlays: chart.panes()[0].getSeries().filter(s => s.seriesType() === 'Line' && s.data().length)
            .map(s => { const o = s.priceScale().options(); return [o.mode, o.invertScale]; }),
          hit: { x: bounds.x + 75, y: bounds.y + candle.priceToCoordinate(35_000)! },
        };
      }, { log });
      expect(state).toMatchObject({ sameChart: true, sameSeries: true, sameData: true,
        sameSpacing: true, inverted: invert });
      expect(state.range!.from).toBeCloseTo(state.expectedFrom, 6);
      expect(state.range!.to).toBeCloseTo(state.beforeRange.to, 6);
      expect(state.scroll).toBeCloseTo(state.beforeScroll, 6);
      expect(state.middle).toBeCloseTo(.5, 3);
      expect(state.roundtrip).toBeCloseTo(state.mid, 5);
      expect(state.lower.length).toBeGreaterThan(0);
      for (const opts of state.lower) expect(opts).toEqual([0, false]);
      expect(state.overlays.length).toBeGreaterThan(0);
      for (const opts of state.overlays) expect(opts).toEqual([log ? 1 : 0, invert]);
      await page.mouse.move(state.hit.x, state.hit.y);
      // The drawing overlay enables hit capture on the next animation frame.
      await expect(page.locator('[data-win="a"] [data-drawing-overlay]')).toHaveCSS('pointer-events', 'auto');
      await page.mouse.down();
      await page.mouse.up();
      await expect(page.locator('[data-win="a"]').getByTestId('drawing-property-panel')).toBeVisible();
      await page.keyboard.press('Escape');
      if (log && invert) await page.screenshot({ path: info.outputPath(`${timeframe}-log-inverted.png`) });
    }
    expect(errors).toEqual([]);
  });
}

test('표시 옵션이 같은 종목·그룹의 두 차트에서 독립 적용되고 새로고침 후 복원된다', async ({ page }) => {
  await setup(page);
  await scaleFixtures(page);
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
  await expectPriceScale(page, 'a', true, true);
  await expectPriceScale(page, 'b', false, false);
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
  await expectPriceScale(page, 'a', true, true);
  // Same window keeps its display choices when switching timeframe.
  await page.locator('[data-win="a"]').getByTestId('chart-window-header').getByRole('button', { name: '일', exact: true }).click();
  const calendar = await open(page, 'a');
  for (const def of CHART_DISPLAY_TOGGLES) await expect(calendar.getByRole('switch', { name: def.label, exact: true })).toHaveAttribute('aria-checked', String(!initial[def.key]));
  await page.keyboard.press('Escape');
  await expectPriceScale(page, 'a', true, true);
  for (const name of ['주', '월']) {
    await page.locator('[data-win="a"]').getByTestId('chart-window-header').getByRole('button', { name, exact: true }).click();
    await expectPriceScale(page, 'a', true, true);
  }
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
  await scaleFixtures(otherTab);
  await otherTab.goto('/live');
  const inherited = await open(otherTab, 'a');
  for (const def of CHART_DISPLAY_TOGGLES) await expect(inherited.getByRole('switch', { name: def.label, exact: true })).toHaveAttribute('aria-checked', String(!initial[def.key]));
  await expectPriceScale(otherTab, 'a', true, true);
  await otherTab.close();
  await page.evaluate(async () => {
    const path = '/src/state/workspace.ts';
    const { useWorkspaceStore } = await import(path);
    useWorkspaceStore.getState().setWindowSymbol('a', { code: '005930', name: '삼성전자', kind: 'stock' });
  });
  await expect(page.locator('[data-win="a"] .live-symbol-name')).toHaveText('삼성전자');
  await expectPriceScale(page, 'a', true, true);
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
  await panel.getByRole('switch', { name: '로그 스케일', exact: true }).click();
  await panel.getByRole('switch', { name: '차트 거꾸로 보기', exact: true }).click();
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
  expect(stored.find(win => win.id === 'a')!.windowSettings.chart.candleLogScale).toBe(true);
  expect(stored.find(win => win.id === 'a')!.windowSettings.chart.candleInvertScale).toBe(true);
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
  await expectPriceScale(page, 'a', true, true);
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
