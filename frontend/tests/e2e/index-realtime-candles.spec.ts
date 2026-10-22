import { expect, test, type Page, type Route } from '@playwright/test';
import type { IChartApi } from 'lightweight-charts';
import { installLiveMocks } from './helpers/liveMocks';
import { installLiveWs } from './helpers/liveWs';
import { apiExact } from './helpers/apiRoutes';

const at = (clock: string) => Date.parse(`2026-10-22T${clock}+09:00`);
const open = at('09:00:00');
type ChartWindow = Window & { __liveCharts?: Map<string, IChartApi> };
async function chartState(page: Page, id: string) {
  return page.evaluate(id => {
    const chart = (window as ChartWindow).__liveCharts?.get(id);
    const series = chart?.panes().flatMap(p => p.getSeries()).find(s => s.seriesType() === 'Candlestick');
    const rows = series?.data().filter(r => 'close' in r) as { time: number; open: number; high: number; low: number; close: number }[] | undefined;
    return { count: rows?.length ?? 0, last: rows?.at(-1), previous: rows?.at(-2),
      range: chart?.timeScale().getVisibleLogicalRange(), spacing: chart?.timeScale().options().barSpacing,
      width: chart?.timeScale().width() };
  }, id);
}

test('국내 지수의 마지막 봉·새 분봉·다른 주기가 같은 WS로 갱신되고 REST가 누락 구간을 보정한다', async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.clock.setFixedTime(at('10:00:10'));
  await installLiveMocks(page);
  const ws = await installLiveWs(page);
  await page.addInitScript(() => {
    sessionStorage.setItem('live.workspace.v1', JSON.stringify({ schema_version: 2,
      windows: [
        { id: 'kospi-minute', group: 1, timeframe: '1m' },
        { id: 'kospi-five', group: 1, timeframe: '5m' },
        { id: 'kosdaq-minute', group: 2, timeframe: '1m' },
        { id: 'krx100-minute', group: 3, timeframe: '1m' },
      ].map((w, i) => ({ id: w.id, group: w.group, kind: 'chart', chart: { timeframe: w.timeframe },
        rect: { x: i % 2 * .5, y: Math.floor(i / 2) * .5, w: .495, h: .49 } })),
      zOrder: ['kospi-minute', 'kospi-five', 'kosdaq-minute', 'krx100-minute'],
      groupSymbols: { 1: { code: 'KOSPI', name: 'KOSPI', kind: 'index' },
        2: { code: 'KOSDAQ', name: 'KOSDAQ', kind: 'index' }, 3: { code: 'KRX100', name: 'KRX100', kind: 'index' } },
    }));
  });
  await page.route(apiExact('live/index-quotes'), route => route.fulfill({ json: { quotes:
    ['KOSPI', 'KOSDAQ', 'KRX100'].map((id, i) => ({ id, label: id, value: (i + 1) * 100 + 1,
      change: 1, change_rate: 1, t_ms: at('10:00:00') })),
  } }));
  await page.route(apiExact('live/index-header-quote'), route => {
    const id = new URL(route.request().url()).searchParams.get('index_id');
    const value = id === 'KOSDAQ' ? 201 : id === 'KRX100' ? 301 : 101;
    return route.fulfill({ json: {
      index_id: id, value, change: 1, change_rate: 1,
      previous_close: value - 1, trading_date: '20261022', observed_at_ms: at('10:00:00'), checked_at_ms: at('10:00:00'),
      market_timezone: 'Asia/Seoul', session_status: 'open', refresh_status: 'normal', source: 'kiwoom', delay_unverified: false,
    } });
  });
  const counts: Record<string, number> = {};
  let pending: Route | undefined;
  await page.route(apiExact('live/index-candles'), async route => {
    const p = new URL(route.request().url()).searchParams;
    const id = p.get('index_id')!, tf = p.get('timeframe')!, key = `${id}:${tf}`;
    counts[key] = (counts[key] ?? 0) + 1;
    if (key === 'KOSPI:1m' && counts[key] === 2) { pending = route; return; }
    const value = id === 'KOSDAQ' ? 200 : id === 'KRX100' ? 300 : 100;
    const step = Number(tf.slice(0, -1)) * 60000;
    const candles = Array.from({ length: Math.floor(3600000 / step) + 1 }, (_, i) => ({
      t_ms: open + i * step, open: value, high: value + 5, low: value - 5, close: value + 1, volume: 321,
    }));
    await route.fulfill({ json: { index_id: id, timeframe: tf, from: p.get('from'), to: p.get('to'), candles, data_warnings: [] } });
  });
  await page.goto('/live');
  await expect.poll(() => ws.connectionCount()).toBe(1);
  await expect.poll(async () => (await chartState(page, 'kospi-minute')).count).toBe(61);
  await expect.poll(async () => (await chartState(page, 'kospi-five')).count).toBe(13);
  await page.evaluate(() => {
    (window as ChartWindow).__liveCharts?.get('kospi-minute')?.timeScale().setVisibleLogicalRange({ from: 5, to: 25 });
  });
  await expect.poll(async () => (await chartState(page, 'kospi-minute')).range?.to).toBe(25);
  const before = await chartState(page, 'kospi-minute');
  ws.pushEvent({ type: 'market_sector_tick', sectors: { '001': { value: 110, change: 10, change_pct: 10, t_ms: at('10:00:11') } } });
  await expect.poll(async () => (await chartState(page, 'kospi-minute')).last?.close).toBe(110);
  await expect.poll(async () => (await chartState(page, 'kospi-five')).last?.close).toBe(110);
  await expect(page.locator('[data-win="kospi-minute"]').getByTestId('titlebar-current-price')).toHaveText('110.00');
  expect((await chartState(page, 'kosdaq-minute')).last?.close).toBe(201);
  expect((await chartState(page, 'krx100-minute')).last?.close).toBe(301);
  const afterTick = await chartState(page, 'kospi-minute');
  expect(afterTick.range?.to).toBe(before.range?.to);
  expect(afterTick.spacing).toBe(before.spacing);
  // A wider price-axis label may consume pixels; that is not a zoom/pan reset.
  expect(afterTick.range!.from - before.range!.from).toBeCloseTo((before.width! - afterTick.width!) / before.spacing!, 3);
  expect(counts['KOSPI:1m']).toBe(1); // no REST required to move the price
  ws.pushEvent({ type: 'market_sector_tick', sectors: { '001': { value: 90, t_ms: at('10:00:12') } } });
  await expect.poll(async () => (await chartState(page, 'kospi-minute')).last?.close).toBe(90);
  expect((await chartState(page, 'kospi-minute')).last).toMatchObject({ open: 100, high: 110, low: 90 });

  // A focus refresh exercises the same REST correction path as the retained
  // 60-second interval, while allowing a deterministic delayed HTTP response.
  await page.clock.setFixedTime(at('10:01:10'));
  await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')));
  await expect.poll(() => !!pending).toBe(true);
  ws.pushEvent({ type: 'market_sector_tick', sectors: { '001': { value: 120, t_ms: at('10:01:11') } } });
  await expect.poll(async () => (await chartState(page, 'kospi-minute')).count).toBe(62);
  await expect.poll(async () => (await chartState(page, 'kospi-minute')).last?.close).toBe(120);
  await expect.poll(async () => (await chartState(page, 'kospi-five')).last?.close).toBe(120);
  const corrected = Array.from({ length: 62 }, (_, i) => ({ t_ms: open + i * 60000,
    open: 100, high: 108, low: 94, close: 103, volume: 500 }));
  await pending!.fulfill({ json: { index_id: 'KOSPI', timeframe: '1m', from: '20261001', to: '20261022',
    candles: corrected, data_warnings: [] } });
  await expect.poll(async () => (await chartState(page, 'kospi-minute')).previous?.close).toBe(103);
  expect((await chartState(page, 'kospi-minute')).last?.close).toBe(120);
  expect((await chartState(page, 'kospi-minute')).previous?.high).toBe(108);
  const afterCorrection = await chartState(page, 'kospi-minute');
  expect(afterCorrection.range?.to).toBe(before.range?.to);
  expect(afterCorrection.spacing).toBe(before.spacing);
  expect(afterCorrection.range!.from - before.range!.from).toBeCloseTo((before.width! - afterCorrection.width!) / before.spacing!, 3);
  expect(ws.connectionCount()).toBe(1);
  await expect(page.locator('[data-win="kospi-minute"]').getByTestId('titlebar-current-price')).toHaveText('120.00');
  await page.screenshot({ path: info.outputPath('index-realtime-candles.png') });
});
