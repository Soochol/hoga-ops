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
  await panel.getByLabel('차트 거꾸로 보기 세부 설정').click();
  await panel.getByLabel('고저 극값 라벨 세부 설정').click();
  const volumeDetails = panel.getByLabel('거래량을 캔들에 겹쳐 표시 세부 설정');
  if (await volumeDetails.isVisible()) await volumeDetails.click();
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
  const header = page.locator(`[data-win="${id}"] .live-window-titlebar`);
  await expect(header.getByText('로그', { exact: true })).toHaveCount(log ? 1 : 0);
  await expect(header.getByText('반전', { exact: true })).toHaveCount(invert ? 1 : 0);
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
      low: price - 500, close: price + (i % 2 ? -200 : 200), volume: 1000 + i,
    })), cached_dates: ['20260527'], fresh_dates: [], data_warnings: [],
  } }));
}

test('잔량 히트맵 앞뒤 전환이 실제 겹친 픽셀에 반영되고 캔들 우선 설정·다른 창과 독립적이다', async ({ page }, info) => {
  await setup(page);
  await scaleFixtures(page);
  const start = Date.UTC(2026, 4, 27, 0);
  const candles = Array.from({ length: 5 }, (_, i) => ({
    t_ms: start + i * 60_000, open: 35_000, high: 35_150, low: 34_950, close: 35_100, volume: 1000,
  }));
  await page.route(apiExact('live/past-candles'), route => route.fulfill({ json: {
    code: '098460', from: '20260527', to: '20260528', candles,
    cached_dates: ['20260527'], fresh_dates: [], data_warnings: [],
  } }));
  await page.route(apiExact('range'), route => route.fulfill({ json: {
    code: '098460', from_date: '20260527', to_date: '20260527', bucket_ms: 60_000,
    segments: [{ date: '20260527', session_open_ms: start, session_close_ms: start + 23_400_000, source: 'hogaplay' }],
    candles: [], quote_ratio: { bucket_ms: 60_000, points: [] }, fill_strength: { bucket_ms: 60_000, points: [] },
    volume_profile_range: { bin_count: 0, price_min: 0, price_max: 0, bin_width: 0, bins: [] },
    volume_profile_by_day: [], excluded_dates: [], data_warnings: [],
    depth_heatmap: candles.map(c => ({ t_ms: c.t_ms, asks: [[35_050, 900]], bids: [[35_000, 500]] })),
  } }));
  await page.goto('/live');
  await expect.poll(() => page.evaluate(() => (window as ChartsWindow).__liveCharts?.size)).toBe(2);
  await page.evaluate(async () => {
    const path = '/src/state/livePage.ts';
    const { useLivePageStore } = await import(path);
    for (const id of ['a', 'b']) useLivePageStore.getState().patchIndicatorsScoped({ windowKey: `live:${id}` }, '1m', {
      depthHeatmapEnabled: true, depthHeatmapHidden: false, depthHeatmapMaxOpacity: 1,
      depthHeatmapAskColor: '#3485FA', depthHeatmapBidColor: '#F04452',
    });
  });

  const pixel = (id: string) => page.evaluate(id => {
    const chart = (window as ChartsWindow).__liveCharts?.get(id);
    const candle = chart?.panes()[0]?.getSeries().find(s => s.seriesType() === 'Candlestick');
    const row = candle?.data()[2];
    if (!chart || !candle || !row) return null;
    const x = chart.timeScale().timeToCoordinate(row.time), y = candle.priceToCoordinate(35_050);
    if (x === null || y === null) return null;
    const canvas = chart.takeScreenshot();
    const rect = chart.chartElement().getBoundingClientRect();
    return [...canvas.getContext('2d')!.getImageData(
      Math.round(x * canvas.width / rect.width), Math.round(y * canvas.height / rect.height), 1, 1,
    ).data].slice(0, 3);
  }, id);
  const blue = [52, 133, 250];
  for (const onTop of [false, true]) {
    let panel = await open(page, 'a');
    const candleToggle = panel.getByRole('switch', { name: '캔들이 항상 위', exact: true });
    if (await candleToggle.getAttribute('aria-checked') !== String(onTop)) await candleToggle.click();
    await page.keyboard.press('Escape');
    await expect.poll(() => page.evaluate(() => (window as ChartsWindow).__liveCharts?.get('a')?.panes()[0]?.getSeries()
      .find(s => s.seriesType() === 'Candlestick')?.data().length)).toBe(5);
    await page.evaluate(() => {
      for (const chart of (window as ChartsWindow).__liveCharts!.values()) chart.timeScale().setVisibleLogicalRange({ from: -2, to: 7 });
    });
    await expect.poll(() => pixel('a')).not.toEqual(blue);
    panel = await open(page, 'a');
    const heatmap = panel.getByRole('switch', { name: '잔량 히트맵을 캔들 위에', exact: true });
    await expect(heatmap).toHaveAttribute('aria-checked', 'false');
    await heatmap.click();
    await expect.poll(() => pixel('a')).toEqual(blue);
    await expect.poll(() => pixel('b')).not.toEqual(blue);
    if (onTop) await page.screenshot({ path: info.outputPath('heatmap-above-candles-settings.png') });
    await panel.getByRole('button', { name: '되돌리기', exact: true }).click();
    await expect(heatmap).toHaveAttribute('aria-checked', 'false');
    await expect.poll(() => pixel('a')).not.toEqual(blue);
    await page.keyboard.press('Escape');
  }
});

for (const timeframe of ['1m', 'D', 'W', 'M']) {
  test(`${timeframe}: 로그·반전·색상 교환 조합의 좌표, 가격 지표·드로잉, 하단 축과 가로 범위를 보존한다`, async ({ page }, info) => {
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
      const volume = chart.panes()[1].getSeries().find(s => s.seriesType() === 'Histogram')!;
      const other = (window as ChartsWindow).__liveCharts!.get('b')!;
      chart.timeScale().setVisibleLogicalRange({ from: -1, to: candle.data().length + 2 });
      // LWC applies setVisibleLogicalRange during paint; capture the rendered range.
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      Object.assign(window, { __scaleBefore: { chart, candle, data: candle.data(), volume, volumeData: volume.data(),
        otherData: other.panes().flatMap(p => p.getSeries()).filter(s => ['Candlestick', 'Histogram'].includes(s.seriesType())).map(s => s.data()),
        range: chart.timeScale().getVisibleLogicalRange(), spacing: chart.timeScale().options().barSpacing,
        width: chart.timeScale().width(), scroll: chart.timeScale().scrollPosition() } });
    });
    for (const [log, invert, swapColors] of [
      [false, false, true], [false, true, false], [false, true, true], [false, false, false],
      [true, false, false], [true, true, false], [true, true, true], [true, false, true],
    ]) {
      const panel = await open(page, 'a');
      const colorToggle = panel.getByRole('switch', { name: '반전 시 캔들·거래량 색상 교환', exact: true });
      if (await colorToggle.getAttribute('aria-checked') !== String(swapColors)) {
        const invertToggle = panel.getByRole('switch', { name: '차트 거꾸로 보기', exact: true });
        if (await invertToggle.getAttribute('aria-checked') === 'false') await invertToggle.click();
        await colorToggle.click();
      }
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
      const state = await page.evaluate(({ log, invert, swapColors }) => {
        const chart = (window as ChartsWindow).__liveCharts!.get('a')!;
        const candle = chart.panes()[0].getSeries().find(s => s.seriesType() === 'Candlestick') as ISeriesApi<'Candlestick'>;
        const volume = chart.panes()[1].getSeries().find(s => s.seriesType() === 'Histogram') as ISeriesApi<'Histogram'>;
        const rows = candle.data().filter(r => 'close' in r);
        const low = Math.min(...rows.map(r => r.low)), high = Math.max(...rows.map(r => r.high));
        const mid = log ? Math.sqrt(low * high) : (low + high) / 2;
        const yLow = candle.priceToCoordinate(low)!, yHigh = candle.priceToCoordinate(high)!;
        const yMid = candle.priceToCoordinate(mid)!;
        const before = (window as unknown as { __scaleBefore: { chart: IChartApi; candle: ISeriesApi<'Candlestick'>;
          data: unknown; volume: ISeriesApi<'Histogram'>; volumeData: unknown; otherData: unknown;
          range: { from: number; to: number }; spacing: number; width: number; scroll: number } }).__scaleBefore;
        const beforeCandles = (before.data as ReturnType<typeof candle.data>).filter(r => 'close' in r);
        const { upColor: up, downColor: down } = candle.options();
        const flip = (color: string | undefined) => invert && swapColors
          ? color === up ? down : color === down ? up : color : color;
        const expectedCandles = beforeCandles.map(row => ({ ...row,
          color: flip(row.color), borderColor: flip(row.borderColor), wickColor: flip(row.wickColor) }));
        const expectedVolume = (before.volumeData as ReturnType<typeof volume.data>).map(row =>
          'value' in row ? { ...row, color: flip(row.color) } : row);
        const other = (window as ChartsWindow).__liveCharts!.get('b')!;
        const bounds = chart.chartElement().getBoundingClientRect();
        return {
          sameChart: chart === before.chart, sameSeries: candle === before.candle,
          sameColors: JSON.stringify(rows) === JSON.stringify(expectedCandles),
          sameVolume: volume === before.volume && JSON.stringify(volume.data()) === JSON.stringify(expectedVolume),
          otherUnchanged: JSON.stringify(other.panes().flatMap(p => p.getSeries())
            .filter(s => ['Candlestick', 'Histogram'].includes(s.seriesType())).map(s => s.data())) === JSON.stringify(before.otherData),
          sameData: JSON.stringify(rows.map(({ color, borderColor, wickColor, ...row }) => row))
            === JSON.stringify(beforeCandles.map(({ color, borderColor, wickColor, ...row }) => row)),
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
      }, { log, invert, swapColors });
      expect(state).toMatchObject({ sameChart: true, sameSeries: true, sameData: true,
        sameColors: true, sameVolume: true, otherUnchanged: true, sameSpacing: true, inverted: invert });
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
      if (log && invert && swapColors) await page.screenshot({ path: info.outputPath(`${timeframe}-log-inverted.png`) });
    }
    expect(errors).toEqual([]);
  });
}

test('표시 옵션이 같은 종목·그룹의 두 차트에서 독립 적용되고 새로고침 후 복원된다', async ({ page }) => {
  await setup(page);
  await scaleFixtures(page);
  await page.goto('/live');
  const a = await open(page, 'a');
  const editOrder = [...CHART_DISPLAY_TOGGLES.filter(def => def.key !== 'highLowLabelsEnabled'),
    ...CHART_DISPLAY_TOGGLES.filter(def => def.key === 'highLowLabelsEnabled')];
  for (const def of editOrder) {
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
  // Scale options update before LWC paints its new axis width and coordinates.
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
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
  await expect(page.locator('[data-win="a"]').getByTestId('candle-tooltip')).toHaveClass(/tooltip-surface/);
  await expect(page.locator('[data-win="a"]').getByTestId('candle-tooltip')).toHaveCSS('padding', '6px 10px');
  await expect(page.locator('[data-win="a"]').getByTestId('candle-tooltip')).toHaveCSS('font-size', '11.5px');
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

for (const timeframe of ['1m', 'D', 'W', 'M', '5s']) {
  test(`${timeframe}: 거래량 겹치기는 별도 pane을 없애고 창별 축·스타일·뷰포트를 보존한다`, async ({ page }, info) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await setup(page, timeframe);
    await scaleFixtures(page);
    if (timeframe === '5s') {
      await page.route(apiExact('live/second-trade-dates'), r => r.fulfill({ json: { dates: [] } }));
      await page.route(apiExact('live/second-aggregates'), r => {
        const p = new URL(r.request().url()).searchParams;
        const date = p.get('date')!, seconds = Number(p.get('seconds'));
        const start = Date.parse(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}T09:00:00+09:00`);
        const from = Number(p.get('from_ms') ?? 0), to = Number(p.get('to_ms') ?? Infinity);
        const bars = Array.from({ length: 30 }, (_, i) => ({ t_ms: start + i * seconds * 1000,
          open: 35000, high: 35200, low: 34800, close: i % 2 ? 34900 : 35100,
          volume: 100 + i, count: 3, trade_value: 3500000 }));
        return r.fulfill({ json: { code: '098460', venue: 'KRX', date, seconds, source: 'second_trades',
          status: 'observed', coverage: 'unverified', storage_error: null,
          first_observed_ms: start, last_observed_ms: bars.at(-1)!.t_ms,
          bars: bars.filter(b => b.t_ms >= from && b.t_ms < to), prices: [] } });
      });
    }
    await page.goto('/live');
    await expect.poll(() => page.evaluate(() => (window as ChartsWindow).__liveCharts?.get('a')?.panes()[0]
      ?.getSeries().find(s => s.seriesType() === 'Candlestick')?.data().length ?? 0)).toBeGreaterThan(3);
    await page.evaluate(async () => {
      const chart = (window as ChartsWindow).__liveCharts!.get('a')!;
      const candle = chart.panes()[0].getSeries().find(s => s.seriesType() === 'Candlestick')!;
      const volume = chart.panes()[1].getSeries().find(s => s.seriesType() === 'Histogram')!;
      chart.timeScale().setVisibleLogicalRange({ from: -1, to: candle.data().length + 2 });
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      Object.assign(window, { __volumeBefore: { chart, candle, rows: volume.data(),
        paneCount: chart.panes().length, range: chart.timeScale().getVisibleLogicalRange(), spacing: chart.timeScale().options().barSpacing } });
    });
    let panel = await open(page, 'a');
    await panel.getByRole('switch', { name: '거래량을 캔들에 겹쳐 표시', exact: true }).click();
    await expect(panel.getByRole('slider', { name: '거래량 투명도' })).not.toBeVisible();
    await panel.getByLabel('거래량을 캔들에 겹쳐 표시 세부 설정').press('Enter');
    await expect(page.locator('[data-win="a"]').getByTestId('pane-legend-rows-volume')).toHaveCount(0);
    await expect(page.locator('[data-win="a"]').getByTestId('pane-legend-rows-candle')).toContainText('거래량');
    const overlayState = () => page.evaluate(() => {
      const chart = (window as ChartsWindow).__liveCharts!.get('a')!;
      const candle = chart.panes()[0].getSeries().find(s => s.seriesType() === 'Candlestick')!;
      const histogram = chart.panes()[0].getSeries().find(s => s.seriesType() === 'Histogram')!;
      const other = (window as ChartsWindow).__liveCharts!.get('b')!;
      const before = (window as unknown as { __volumeBefore: { chart: IChartApi; candle: ISeriesApi<'Candlestick'>;
        rows: { time: unknown; value?: number }[]; paneCount: number; range: { from: number; to: number }; spacing: number } }).__volumeBefore;
      return { paneCount: chart.panes().length, expectedPaneCount: before.paneCount - 1,
        otherPaneCount: other.panes().length, originalPaneCount: before.paneCount,
        lowerHistograms: chart.panes().slice(1).flatMap(p => p.getSeries()).filter(s => s.seriesType() === 'Histogram').length,
        sameChart: chart === before.chart, sameCandle: candle === before.candle,
        sameVolume: JSON.stringify(histogram?.data().map(({ time, ...r }) => ({ time, value: 'value' in r ? r.value : undefined })))
          === JSON.stringify(before.rows.map(({ time, value }) => ({ time, value }))),
        spacing: chart.timeScale().options().barSpacing, oldSpacing: before.spacing,
        right: chart.timeScale().getVisibleLogicalRange()?.to, oldRight: before.range.to,
        scale: histogram?.priceScale().options(), behindCandle: histogram && histogram.seriesOrder() < candle.seriesOrder(),
        colors: histogram?.data().map(row => 'color' in row ? row.color : null),
      };
    });
    await expect.poll(async () => (await overlayState()).sameVolume).toBe(true);
    let state = await overlayState();
    expect(state.paneCount).toBe(state.expectedPaneCount);
    expect(state.otherPaneCount).toBe(state.originalPaneCount);
    expect(state).toMatchObject({ sameChart: true, sameCandle: true, behindCandle: true, lowerHistograms: 0 });
    expect(state.spacing).toBe(state.oldSpacing);
    expect(state.right).toBeCloseTo(state.oldRight, 6);
    expect(state.scale).toMatchObject({ mode: 0, invertScale: false, scaleMargins: { top: .75, bottom: 0 } });
    if (timeframe === 'D') {
      await page.keyboard.press('Escape');
      await expect(page.locator('[data-win="a"]').getByTestId('chart-reveal-cover')).toHaveCSS('opacity', '0');
      await page.screenshot({ path: info.outputPath('volume-overlay-default.png'), animations: 'disabled' });
      panel = await open(page, 'a');
    }
    await panel.getByRole('slider', { name: '거래량 표시 높이' }).press('End');
    await panel.getByRole('slider', { name: '거래량 투명도' }).press('Home');
    await panel.getByRole('button', { name: '상승봉 거래량 색상 선택', exact: true }).click();
    await page.getByRole('button', { name: '상승봉 거래량 색상 #22C55E', exact: true }).click();
    await expect(panel).toBeVisible();
    await expect.poll(async () => (await overlayState()).colors?.includes('#22C55Eff')).toBe(true);
    await expect.poll(async () => (await overlayState()).scale?.scaleMargins.top).toBe(.6);
    // Palette Escape closes only its own layer.
    await panel.getByRole('button', { name: '하락봉 거래량 색상 선택', exact: true }).click();
    await page.keyboard.press('Escape');
    await expect(panel).toBeVisible();
    await panel.getByRole('switch', { name: '로그 스케일', exact: true }).click();
    await panel.getByRole('switch', { name: '차트 거꾸로 보기', exact: true }).click();
    await expectPriceScale(page, 'a', true, true);
    await expect.poll(() => page.evaluate(() => {
      const candle = (window as ChartsWindow).__liveCharts!.get('a')!.panes()[0].getSeries()
        .find(s => s.seriesType() === 'Candlestick') as ISeriesApi<'Candlestick'>;
      const rows = candle.data().filter(r => 'high' in r);
      return candle.priceToCoordinate(Math.max(...rows.map(r => r.high)))! > candle.priceToCoordinate(Math.min(...rows.map(r => r.low)))!;
    })).toBe(true);
    state = await overlayState();
    expect(state.scale).toMatchObject({ mode: 0, invertScale: false });
    expect(state.sameCandle).toBe(true);
    await page.keyboard.press('Escape');
    if (timeframe === 'D') {
      await page.screenshot({ path: info.outputPath('volume-overlay-comparison.png'), animations: 'disabled' });
      await page.reload();
      panel = await open(page, 'a');
      await expect(panel.getByRole('slider', { name: '거래량 표시 높이' })).toHaveValue('40');
      await expect(panel.getByRole('slider', { name: '거래량 투명도' })).toHaveValue('0');
      await expect(page.locator('[data-win="a"]').getByTestId('chart-reveal-cover')).toHaveCSS('opacity', '0');
      await page.screenshot({ path: info.outputPath('volume-overlay-settings.png'), animations: 'disabled' });
    } else panel = await open(page, 'a');
    await panel.getByRole('switch', { name: '거래량을 캔들에 겹쳐 표시', exact: true }).click();
    await expect(page.locator('[data-win="a"]').getByTestId('pane-legend-rows-volume')).toBeVisible();
    await expect.poll(() => page.evaluate(() => (window as ChartsWindow).__liveCharts!.get('a')!.panes()[0]
      .getSeries().filter(s => s.seriesType() === 'Histogram').length)).toBe(0);
    await panel.getByRole('button', { name: '되돌리기', exact: true }).click();
    await panel.getByLabel('거래량을 캔들에 겹쳐 표시 세부 설정').click();
    await expect(panel.getByRole('slider', { name: '거래량 표시 높이' })).toHaveValue('40');
    await expect(page.locator('[data-win="a"]').getByTestId('pane-legend-rows-volume')).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}

test('고저 라벨과 가격선 스타일은 실제 캔버스·되돌리기·저장에서 차트별로 독립적이다', async ({ page }, info) => {
  await setup(page, 'D');
  await scaleFixtures(page);
  await page.goto('/live');
  await expect.poll(() => page.evaluate(() => (window as ChartsWindow).__liveCharts?.get('b')?.panes()[0]
    .getSeries().find(s => s.seriesType() === 'Candlestick')?.data().length ?? 0)).toBeGreaterThan(3);
  await page.evaluate(async () => {
    for (const chart of (window as ChartsWindow).__liveCharts!.values()) {
      const candle = chart.panes()[0].getSeries().find(s => s.seriesType() === 'Candlestick')!;
      chart.timeScale().setVisibleLogicalRange({ from: -1, to: candle.data().length + 2 });
    }
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
  const pixels = (id: string) => page.evaluate(id => {
    const chart = (window as ChartsWindow).__liveCharts!.get(id)!;
    const candle = chart.panes()[0].getSeries().find(s => s.seriesType() === 'Candlestick') as ISeriesApi<'Candlestick'>;
    const low = Math.min(...candle.data().filter(r => 'low' in r).map(r => r.low));
    const canvas = chart.takeScreenshot(), box = chart.chartElement().getBoundingClientRect();
    const sx = canvas.width / box.width, sy = canvas.height / box.height;
    const x = Math.round(chart.timeScale().width() * .35 * sx);
    const y = Math.max(0, Math.round(candle.priceToCoordinate(low)! * sy) - 6);
    const bytes = canvas.getContext('2d')!.getImageData(x, y, Math.round(chart.timeScale().width() * .4 * sx), 12).data;
    let hash = 2166136261;
    for (const byte of bytes) hash = Math.imul(hash ^ byte, 16777619);
    return hash >>> 0;
  }, id);
  const before = { a: await pixels('a'), b: await pixels('b') };
  let panel = await open(page, 'a');
  await expect(panel.getByRole('heading', { name: '가격 표시', exact: true })).toBeVisible();
  await panel.getByRole('switch', { name: '저가 가격선', exact: true }).click();
  await expect.poll(() => pixels('a')).not.toBe(before.a);
  expect(await pixels('b')).toBe(before.b);
  await panel.getByRole('button', { name: '저가 가격선 스타일 선택', exact: true }).click();
  await page.getByRole('button', { name: '저가 가격선 색상 #22C55E', exact: true }).click();
  const colored = await pixels('a');
  await panel.getByRole('button', { name: '저가 가격선 스타일 선택', exact: true }).click();
  await page.getByRole('button', { name: '저가 가격선 굵기 4px', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(panel).toBeVisible();
  await expect.poll(() => pixels('a')).not.toBe(colored);
  expect(await pixels('b')).toBe(before.b);
  await panel.getByRole('button', { name: '되돌리기', exact: true }).click();
  await expect.poll(() => pixels('a')).toBe(colored);
  await panel.getByRole('button', { name: '저가 가격선 스타일 선택', exact: true }).click();
  await page.getByRole('button', { name: '저가 가격선 굵기 3px', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem('hoga.window.settings.v1')!).byWindow;
    return [saved.a.chart.highLowLowLineColor, saved.a.chart.highLowLowLineWidth,
      saved.b.chart.highLowLowLineColor, saved.b.chart.highLowLowLineWidth];
  })).toEqual(['#22C55E', 3, '', 1]);
  await panel.getByRole('switch', { name: '고저 극값 라벨', exact: true }).click();
  await expect.poll(() => pixels('a')).toBe(before.a);
  expect(await pixels('b')).toBe(before.b);
  await page.keyboard.press('Escape');
  await page.reload();
  panel = await open(page, 'a');
  await expect(panel.getByRole('switch', { name: '고저 극값 라벨', exact: true })).toHaveAttribute('aria-checked', 'false');
  await expect(panel.getByRole('switch', { name: '저가 가격선', exact: true })).toHaveAttribute('aria-checked', 'true');
  await panel.getByRole('switch', { name: '고저 극값 라벨', exact: true }).click();
  await panel.getByRole('button', { name: '저가 가격선 스타일 선택', exact: true }).click();
  await expect(page.getByRole('button', { name: '저가 가격선 색상 #22C55E', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: '저가 가격선 굵기 3px', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape');
  await page.screenshot({ path: info.outputPath('per-chart-high-low-settings.png') });
  const legacy = await page.evaluate(() => JSON.parse(localStorage.getItem('hoga.chart.prefs.v1')!));
  expect(legacy.highLowLabelsEnabled).toBe(true);
  expect(legacy.highLowLowLineEnabled).toBe(false);
});

test('기존 차트 설정에 없던 고저 필드는 전역값을 한 번만 이관한다', async ({ page }) => {
  await setup(page);
  await scaleFixtures(page);
  await page.addInitScript(() => {
    if (sessionStorage.getItem('highlow-migration-fixture')) return;
    sessionStorage.setItem('highlow-migration-fixture', '1');
    const legacy = JSON.parse(localStorage.getItem('hoga.chart.prefs.v1')!);
    Object.assign(legacy, { highLowLabelsEnabled: false, highLowLowLineEnabled: true,
      highLowLowLineColor: '#22C55E', highLowLowLineWidth: 3 });
    localStorage.setItem('hoga.chart.prefs.v1', JSON.stringify(legacy));
    const chart = Object.fromEntries(Object.entries(legacy).filter(([key]) => !key.startsWith('highLow')));
    localStorage.setItem('hoga.window.settings.v1', JSON.stringify({ schema_version: 1, byWindow: { a: { chart }, b: { chart } } }));
  });
  await page.goto('/live');
  const panel = await open(page, 'a');
  await expect(panel.getByRole('switch', { name: '고저 극값 라벨', exact: true })).toHaveAttribute('aria-checked', 'false');
  await expect(panel.getByRole('switch', { name: '저가 가격선', exact: true })).toHaveAttribute('aria-checked', 'true');
  await panel.getByRole('switch', { name: '고저 극값 라벨', exact: true }).click();
  await page.keyboard.press('Escape');
  await page.reload();
  let restored = await open(page, 'a');
  await expect(restored.getByRole('switch', { name: '고저 극값 라벨', exact: true })).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');
  restored = await open(page, 'b');
  await expect(restored.getByRole('switch', { name: '고저 극값 라벨', exact: true })).toHaveAttribute('aria-checked', 'false');
  await expect.poll(() => page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem('hoga.window.settings.v1')!).byWindow;
    return ['a', 'b'].map(id => [saved[id].chart.highLowLowLineColor, saved[id].chart.highLowLowLineWidth]);
  })).toEqual([['#22C55E', 3], ['#22C55E', 3]]);
});

test('캔들 차트 설정 설명은 공통 툴팁으로 호버·키보드 포커스에서 표시된다', async ({ page }, info) => {
  await setup(page);
  await scaleFixtures(page);
  await page.goto('/live');
  const panel = await open(page, 'a');
  await expect(panel.locator('.settings-row-description')).toHaveCount(0);
  const label = panel.getByText('캔들 기준 Y축', { exact: true });
  const description = '캔들 고가·저가에 맞춰 가격축을 조절합니다. 보조지표는 제외합니다.';
  await expect(label).toHaveAttribute('data-tooltip', description);
  await expect(label).not.toHaveAttribute('title');
  await label.hover();
  const tooltip = page.getByRole('tooltip');
  await expect(tooltip).toHaveText(description);
  await expect(tooltip).toHaveClass(/tooltip-surface/);
  await expect(label).toHaveAttribute('aria-describedby', await tooltip.getAttribute('id') as string);
  await page.screenshot({ path: info.outputPath('chart-settings-description-tooltip.png') });
  await page.mouse.move(0, 0);
  await expect(tooltip).toHaveCount(0);
  await panel.getByRole('switch', { name: '캔들 기준 Y축', exact: true }).focus();
  await page.keyboard.press('Shift+Tab');
  await expect(label).toBeFocused();
  await expect(tooltip).toHaveText(description);
  await panel.getByRole('switch', { name: '캔들 기준 Y축', exact: true }).click();
  await expect(tooltip).toHaveCount(0);
  await panel.getByText('반전 시 캔들·거래량 색상 교환', { exact: true }).hover();
  await expect(tooltip).toHaveText('거꾸로 볼 때 캔들 몸통·꼬리와 거래량 봉의 상승·하락 색상을 서로 바꿉니다. 실제 가격·등락률은 유지합니다.');
});
