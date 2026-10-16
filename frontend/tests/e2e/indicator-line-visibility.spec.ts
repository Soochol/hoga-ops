import { test, expect, type Page } from '@playwright/test';
import type { IChartApi, ISeriesApi } from 'lightweight-charts';
import type { WorkspaceWindow } from '../../src/state/workspace';
import { installLiveMocks } from './helpers/liveMocks';
import { apiExact } from './helpers/apiRoutes';

type ChartWindow = Window & { __liveCharts: Map<string, IChartApi> };

async function setup(page: Page) {
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.clock.setFixedTime(new Date('2026-05-28T17:00:00+09:00'));
  await installLiveMocks(page);
  await page.route(apiExact('live/settings'), r => r.fulfill({ json: {
    schema_version: 1, rest_bypass_enabled: false, screener_depth_autocollect: false, krx_prefer_hogaplay: false,
  } }));
  const start = Date.parse('2026-05-27T09:00:00+09:00');
  const candles = Array.from({ length: 130 }, (_, i) => {
    const close = 35000 + Math.sin(i * .3) * 400;
    return { t_ms: start + i * 60_000, open: close - 10, high: close + 40, low: close - 40, close, volume: 100 };
  });
  await page.route(apiExact('live/past-candles'), r => r.fulfill({ json: {
    code: '098460', from: '20260527', to: '20260528', candles, cached_dates: ['20260527'], fresh_dates: [], data_warnings: [],
  } }));
  await page.route(apiExact('live/past-daily-candles'), r => r.fulfill({ json: {
    code: '098460', from: '20260501', to: '20260528', venue: 'KRX', source: 'screener_daily',
    cached_batches: [], fresh_batches: [], data_warnings: [],
    candles: Array.from({ length: 27 }, (_, i) => ({ ...candles[i], t_ms: Date.parse('2026-05-01T09:00:00+09:00') + i * 86_400_000 })),
  } }));
  await page.route(apiExact('range'), r => r.fulfill({ json: {
    code: '098460', from_date: '20260527', to_date: '20260527', bucket_ms: 60_000,
    segments: [{ date: '20260527', session_open_ms: start, session_close_ms: start + 6.5 * 3_600_000, source: 'hogaplay' }],
    candles: [], quote_ratio: { bucket_ms: 60_000, points: candles.map((c, i) => ({
      t: c.t_ms, bid_total: 200 + i, ask_total: 100 + i, bid_max: 210 + i, ask_max: 110 + i,
      imb_max_bid: 200, imb_max_ask: 100, band_pct: 1, tick: 50,
    })) },
    fill_strength: { bucket_ms: 60_000, points: candles.map(c => ({ t: c.t_ms, buy_qty: 20, sell_qty: 10 })) },
    volume_profile_range: { bin_count: 0, price_min: 0, price_max: 0, bin_width: 0, bins: [] },
    volume_profile_by_day: [], excluded_dates: [], data_warnings: [],
  } }));
  await page.goto('/live?code=098460');
  await expect(page.getByTestId('chart-window-header').first()).toBeVisible();
  const id = await page.evaluate(async () => {
    const workspacePath = '/src/state/workspace.ts', pagePath = '/src/state/livePage.ts';
    const { useWorkspaceStore: ws } = await import(workspacePath);
    const { useLivePageStore: store } = await import(pagePath);
    const scopePath = '/src/live/workspace/windowViewContext.ts';
    const { windowScopeKey } = await import(scopePath);
    const win = ws.getState().windows.find((w: WorkspaceWindow) => w.kind === 'chart');
    ws.getState().applyWorkspaceSnapshot({ windows: [{ ...win, group: 1, rect: { x: 0, y: 0, w: 1, h: 1 },
      chart: { ...win.chart, timeframe: '1m' } }], zOrder: [win.id], maximizedId: null });
    store.getState().patchIndicatorsScoped({ windowKey: windowScopeKey(win.id) }, '1m', {
      bollingerEnabled: true, supertrendEnabled: true, supertrendPeriod: 2,
      dailyMovingAverages: [{ id: 'dma-1', enabled: true, period: 2, source: 'close', color: '#06B6D4', lineWidth: 2 }],
      quoteTotalsEnabled: true, fillStrengthEnabled: true,
      quoteTotalsLevelLineEnabled: true, quoteTotalsDayMaxLineEnabled: true,
    });
    return win.id as string;
  });
  await page.getByTestId('live-indicators-button').click();
  return id;
}

async function chartState(page: Page, id: string) {
  return page.evaluate(id => {
    const chart = (window as unknown as ChartWindow).__liveCharts?.get(id);
    const panes = chart?.panes().map(p => p.getSeries()) ?? [];
    const quote = panes.find(p => p.length === 2 && p.every(s => s.seriesType() === 'Line'));
    const fill = panes.find(p => p.filter(s => s.seriesType() === 'Histogram').length === 2);
    const candle = panes.find(p => p.some(s => s.seriesType() === 'Candlestick'));
    const bands = candle?.filter(s => s.seriesType() === 'Line' && (s as ISeriesApi<'Line'>).options().color === '#3B82F6');
    return {
      quote: quote?.map(s => ({ lineVisible: (s as ISeriesApi<'Line'>).options().lineVisible, points: s.data().length })),
      guides: quote?.[0].priceLines().map(l => l.options().lineVisible),
      fill: fill?.map(s => ({ visible: s.options().visible, points: s.data().length })),
      bands: bands?.map(s => s.options().visible),
    };
  }, id);
}

test('six indicator types keep hidden lines in My Indicators, undo and persist display choices', async ({ page }, testInfo) => {
  const id = await setup(page);
  const editor = page.getByTestId('indicator-panel-shell');
  await editor.getByRole('button', { name: '이동평균선', exact: true }).click();
  const ma = editor.getByRole('switch', { name: '기간1 표시', exact: true });
  await ma.click();
  await expect(editor.locator('[data-preview-line="5봉"]')).toHaveCount(0);
  await editor.getByRole('button', { name: '되돌리기', exact: true }).click();
  await expect(ma).toHaveAttribute('aria-checked', 'true');
  for (const sw of await editor.locator('.ma-config-row').getByRole('switch').all()) await sw.click();
  await expect(editor.getByRole('button', { name: '이동평균선', exact: true })).toBeVisible();
  await expect(editor.getByText('표시 중인 선이 없습니다.')).toBeVisible();

  await editor.getByRole('button', { name: '일봉 이동평균선', exact: true }).click();
  await editor.getByRole('switch', { name: '기간1 표시', exact: true }).click();
  await expect(editor.getByRole('button', { name: '일봉 이동평균선', exact: true })).toBeVisible();

  await editor.getByRole('button', { name: '볼린저 밴드', exact: true }).click();
  await editor.getByRole('switch', { name: '볼린저 상단선 표시', exact: true }).click();
  await expect.poll(async () => (await chartState(page, id)).bands).toEqual([false, true]);
  await expect(editor.locator('[data-preview-line="상단선"]')).toHaveCount(0);

  await editor.getByRole('button', { name: '슈퍼트렌드', exact: true }).click();
  await editor.getByRole('switch', { name: '슈퍼트렌드 하락 추세 표시', exact: true }).click();
  await expect.poll(() => page.evaluate(id => {
    const chart = (window as unknown as ChartWindow).__liveCharts.get(id);
    if (!chart) return null;
    const series = chart.panes()[0].getSeries().find(s => s.options().title === '슈퍼트렌드') as ISeriesApi<'Line'>;
    const colors = series?.data().flatMap(p => 'color' in p ? [p.color] : []);
    return { hasUp: colors?.includes('#F04452'), hasDown: colors?.includes('#3485FA') };
  }, id)).toEqual({ hasUp: true, hasDown: false });

  await editor.getByRole('button', { name: '총잔량', exact: true }).click();
  await editor.getByRole('switch', { name: '매수 총잔량 표시', exact: true }).click();
  await editor.getByRole('switch', { name: '매수 수평선 표시', exact: true }).click();
  await expect.poll(async () => (await chartState(page, id)).quote?.map(s => s.lineVisible)).toEqual([false, true]);
  // Hiding the primary trace must not hide the independent ask/current and maximum guides.
  await expect.poll(async () => (await chartState(page, id)).guides).toEqual([false, true, true, true]);
  await editor.getByRole('switch', { name: '매도 총잔량 표시', exact: true }).click();
  await expect.poll(async () => (await chartState(page, id)).quote?.map(s => s.lineVisible)).toEqual([false, false]);
  await expect.poll(async () => (await chartState(page, id)).guides).toEqual([false, true, true, true]);
  await editor.screenshot({ path: testInfo.outputPath('quote-individual-lines.png') });

  await editor.getByRole('button', { name: '체결강도', exact: true }).click();
  await editor.getByRole('switch', { name: '매수 체결 표시', exact: true }).click();
  await expect.poll(async () => (await chartState(page, id)).fill?.map(s => s.visible)).toEqual([false, true, true]);
  await editor.getByRole('switch', { name: '매도 체결 표시', exact: true }).click();
  await editor.getByRole('switch', { name: '당일 누적선 표시', exact: true }).click();
  await expect(editor.getByRole('button', { name: '체결강도', exact: true })).toBeVisible();
  await expect(editor.getByText('표시 중인 선이 없습니다.')).toBeVisible();
  await page.keyboard.press('Escape');
  // chartPrefs uses the shared 250 ms debounce; verify the write before reload.
  await expect.poll(() => page.evaluate(id => {
    const saved = JSON.parse(localStorage.getItem('hoga.chart.prefs.v1') ?? '{}');
    return saved.indicatorModalByWindow?.[`live:${id}`]?.minute?.fillStrengthCumulative;
  }, id)).toBe(false);
  await page.evaluate(() => history.replaceState(null, '', '/live'));
  await page.reload();
  await page.getByTestId('live-indicators-button').click();
  await editor.getByRole('button', { name: '총잔량', exact: true }).click();
  await expect(editor.getByRole('switch', { name: '매수 총잔량 표시', exact: true })).toHaveAttribute('aria-checked', 'false');
  await expect(editor.getByRole('switch', { name: '매도 총잔량 표시', exact: true })).toHaveAttribute('aria-checked', 'false');
  await expect(editor.getByRole('switch', { name: '매수 최고선 표시', exact: true })).toHaveAttribute('aria-checked', 'true');
  await editor.getByRole('button', { name: '체결강도', exact: true }).click();
  await expect(editor.getByRole('switch', { name: '당일 누적선 표시', exact: true })).toHaveAttribute('aria-checked', 'false');
});

test('line controls fit desktop, tablet and narrow mobile layouts', async ({ page }, testInfo) => {
  await setup(page);
  const editor = page.getByTestId('indicator-panel-shell');
  for (const width of [1440, 1024, 640, 480, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    for (const category of ['이동평균선', '볼린저 밴드', '총잔량', '체결강도']) {
      await editor.getByRole('button', { name: category, exact: true }).click();
      await expect(async () => {
        expect(await editor.locator('.settings-editor-main').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
        const overlaps = await editor.locator('.ma-config-row, .indicator-line-row').evaluateAll(rows => rows.filter(row => {
          const cells = [...row.children].map(c => c.getBoundingClientRect());
          return cells.some((a, i) => cells.slice(i + 1).some(b => a.width && b.width
            && Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1
            && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1));
        }).length);
        expect(overlaps).toBe(0);
      }).toPass();
    }
    await editor.screenshot({ path: testInfo.outputPath(`line-controls-${width}.png`) });
  }
});
