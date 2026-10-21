import { test, expect } from '@playwright/test';
import type { IChartApi } from 'lightweight-charts';
import { installLiveMocks } from './helpers/liveMocks';
import { apiExact } from './helpers/apiRoutes';

test('히트맵에서 빠르게 위아래 전환해도 연결된 차트의 가격축이 살아 있다', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error' && /Value is (null|undefined)|The above error occurred/.test(message.text())) {
      errors.push(message.text());
    }
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.clock.setFixedTime(new Date('2026-05-28T18:00:00+09:00'));
  await page.routeWebSocket(/\/api\/ws/, () => {});
  await page.addInitScript(() => {
    sessionStorage.setItem('live.workspace.v1', JSON.stringify({ schema_version: 2,
      windows: ['1m', 'D'].map((timeframe, i) => ({ id: `chart-${i}`, kind: 'chart', group: 1,
        chart: { timeframe }, rect: { x: i * .5, y: 0, w: .49, h: .8 } })),
      zOrder: ['chart-0', 'chart-1'], groupSymbols: { 1: { code: '005930', name: '삼성전자' } },
    }));
    localStorage.setItem('hoga.chart.prefs.v1', JSON.stringify({ candleLogScale: true, candleInvertScale: true }));
  });
  await installLiveMocks(page);
  const entries = [
    { code: '005930', name: '삼성전자' }, { code: '000660', name: 'SK하이닉스' }, { code: '035420', name: 'NAVER' },
  ];
  await page.route(apiExact('heatmap'), route => route.fulfill({ json: {
    folders: [{ id: 'f_0000000a', name: '전환 검증', order: 0 }],
    entries: entries.map((entry, order) => ({ ...entry, folder_id: 'f_0000000a', order })), capture_markers: {},
  } }));
  for (const endpoint of ['live/past-candles', 'live/past-daily-candles']) {
    await page.route(apiExact(endpoint), route => {
      const code = new URL(route.request().url()).searchParams.get('code')!;
      const price = code === '005930' ? 10000 : code === '000660' ? 20000 : 30000;
      return route.fulfill({ json: { code, from: '20260527', to: '20260528',
        candles: [0, 1, 2, 3].map(i => ({ t_ms: endpoint.endsWith('daily-candles')
          ? Date.UTC(2026, 4, 25 + i) : Date.UTC(2026, 4, 27, 0, i),
          open: price, high: price + 100, low: price - 100, close: price + 50, volume: 1000 })),
        cached_dates: ['20260527'], fresh_dates: [], cached_batches: [], fresh_batches: [], data_warnings: [],
      } });
    });
  }
  await page.goto('/live');
  const panel = page.getByTestId('heatmap-panel');
  if (!(await panel.isVisible())) await page.getByRole('button', { name: /히트맵 패널 토글/ }).click();
  const first = panel.getByTestId('heatmap-drawer-row-005930');
  await first.click();
  const chartState = () => page.evaluate(() => {
    const charts = (window as Window & { __liveCharts?: Map<string, IChartApi> }).__liveCharts;
    return ['chart-0', 'chart-1'].map(id => {
      const candle = charts?.get(id)?.panes()[0]?.getSeries().find(s => s.seriesType() === 'Candlestick');
      const last = candle?.data().at(-1);
      const scale = candle?.priceScale().options();
      return last && 'close' in last ? [last.close, scale?.mode, scale?.invertScale] : null;
    });
  });
  await expect.poll(chartState).toEqual([[10050, 1, true], [10050, 1, true]]);
  for (let cycle = 0; cycle < 15; cycle++) {
    for (const key of ['ArrowDown', 'ArrowDown', 'ArrowUp', 'ArrowUp']) await page.keyboard.press(key);
  }
  await expect(first).toHaveAttribute('aria-current', 'true');
  await page.keyboard.press('ArrowDown');
  await expect(panel.getByTestId('heatmap-drawer-row-000660')).toHaveAttribute('aria-current', 'true');
  await expect.poll(chartState).toEqual([[20050, 1, true], [20050, 1, true]]);
  await expect(page.getByText('차트 렌더링에 실패했습니다', { exact: true })).toHaveCount(0);
  expect(errors).toEqual([]);
});
