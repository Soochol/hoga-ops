import { expect, test, type Page } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import type { IChartApi } from 'lightweight-charts';
import type { IchimokuSnapshot } from '../../src/chart/IchimokuPrimitive';
import { installLiveMocks } from './helpers/liveMocks';
import { apiExact } from './helpers/apiRoutes';
type BrowserChart = Window & { __liveCharts: Map<string, IChartApi>; __ichimokuMatrix: { snapshot: IchimokuSnapshot | null }[] };
const daily = Array.from({ length: 160 }, (_, i) => {
  const t_ms = Date.UTC(2026, 3, 1 + i);
  return { trading_date: new Date(t_ms).toISOString().slice(0, 10).replaceAll('-', ''), t_ms,
    open: 100 + i / 10, high: 103 + i / 10, low: 98 + i / 10, close: 101.25 + i / 10, volume: 1000 + i, volume_available: true };
});
const metadata = { market: 'US', market_timezone: 'America/New_York', source: 'kiwoom', price_basis: 'adjusted', adjusted_as_of: '20260907', currency: 'USD', session_scope: 'vendor_daily_unverified', history_start: null,
  latest_bar_date: daily.at(-1)!.trading_date, last_successful_check_at_ms: 1792100000000, completed: [], missing: [], truncated: false, refresh_status: 'normal', messages: [] };
async function observe(page: Page) {
  await page.evaluate(async () => {
    const modulePath = '/src/chart/IchimokuPrimitive.ts', { IchimokuPrimitive } = await import(modulePath);
    const attached = IchimokuPrimitive.prototype.attached; (window as unknown as BrowserChart).__ichimokuMatrix = [];
    IchimokuPrimitive.prototype.attached = function (...args: unknown[]) { (window as unknown as BrowserChart).__ichimokuMatrix.push(this); return attached.apply(this, args); };
  });
}
async function add(page: Page, small = true) {
  const editor = page.getByTestId('indicator-panel-shell');
  await editor.getByRole('button', { name: '지표 추가', exact: true }).click();
  await editor.getByRole('button', { name: '일목균형표', exact: true }).click();
  if (small) for (const [label, value] of [['전환 기간', '2'], ['기준 기간', '3'], ['선행 B 기간', '4'], ['이동 봉 수', '2']]) {
    const input = editor.getByRole('spinbutton', { name: `일목 ${label}`, exact: true }); await input.fill(value); await input.press('Enter');
  }
  await editor.getByRole('button', { name: '설정대로 추가', exact: true }).click();
}
async function candleCount(page: Page) {
  return page.evaluate(() => [...(window as unknown as BrowserChart).__liveCharts.values()][0]?.panes()[0].getSeries().find(s => s.seriesType() === 'Candlestick')?.data().filter(p => 'close' in p).length ?? 0);
}
for (const subject of ['stock', 'index']) {
  test(`${subject}: real catalog primary and repeat on D/W/M/minute with decimal values`, async ({ page }) => {
    test.setTimeout(60000);
    await page.setViewportSize({ width: 1440, height: 1000 }); await page.clock.setFixedTime(new Date('2026-09-07T20:00:00Z')); await installLiveMocks(page);
    await page.addInitScript(() => sessionStorage.setItem('live.workspace.v1', JSON.stringify({ schema_version: 2,
      windows: [{ id: 'ichimoku-overseas', kind: 'chart', group: 1, rect: { x: 0, y: 0, w: .95, h: .9 }, chart: { timeframe: 'D' } }], zOrder: ['ichimoku-overseas'], groupSymbols: {} })));
    await page.route(/\/api\/live\/(us-stock-daily-candles|index-candles)\?/, route => {
      const p = new URL(route.request().url()).searchParams, tf = p.get('timeframe') ?? 'D', rows = tf === 'D' ? daily : daily.filter((_, i) => i % (tf === 'W' ? 7 : 30) === 0);
      return route.fulfill({ json: { instrument_key: 'us-stock:NASDAQ:NVDA', exchange: 'NASDAQ', symbol: 'NVDA', index_id: p.get('index_id'), from: p.get('from'), to: p.get('to'), timeframe: tf, candles: rows, daily_metadata: metadata, data_warnings: [] } });
    });
    await page.route(/\/api\/live\/(us-stock-minute-candles|index-candles)\?[^#]*timeframe=1m/, route => {
      const rows = Array.from({ length: 130 }, (_, i) => ({ ...daily.at(-1)!, t_ms: Date.UTC(2026, 8, 7, 13, 30 + i), trading_date: '20260907', close: 116.37 + Math.sin(i / 5), volume: 250 + i }));
      return route.fulfill({ json: { instrument_key: 'us-stock:NASDAQ:NVDA', exchange: 'NASDAQ', symbol: 'NVDA', index_id: new URL(route.request().url()).searchParams.get('index_id'), timeframe: '1m', from: '20260907', to: '20260907', candles: rows, data_warnings: [],
        minute_metadata: { market_timezone: 'America/New_York', source: 'kiwoom', history_scope: 'bounded', delay_status: 'unknown', session_scope: 'vendor', refresh_status: 'normal', messages: [], refresh_interval_ms: 60000, available_from_ms: rows[0].t_ms, available_to_ms: rows.at(-1)!.t_ms, price_basis: 'adjusted', adjusted_as_of: '20260907', currency: 'USD', bar_limit: 900, pages_fetched: 1, more_available: false, next_cursor: null } } });
    });
    await page.goto(subject === 'stock' ? '/live?market=US&exchange=NASDAQ&symbol=NVDA' : '/live?index=SP500');
    await expect.poll(() => candleCount(page)).toBe(160); await observe(page);
    const frame = page.locator('.live-window-chart'), results = [];
    for (const [label, count] of [['일', 160], ['주', 23], ['월', 6], ['1m', 130]] as const) {
      if (label === '1m') await frame.getByRole('button', { name: /분봉으로 전환/ }).click();
      else await frame.getByRole('group', { name: 'LiveTimeframe' }).getByRole('button', { name: label, exact: true }).click();
      await expect.poll(() => candleCount(page)).toBe(count);
      await frame.getByTestId('live-indicators-button').click(); await add(page);
      const editor = page.getByTestId('indicator-panel-shell'); await editor.getByRole('button', { name: '하나 더 추가', exact: true }).click(); await editor.getByRole('button', { name: '설정대로 추가', exact: true }).click();
      await expect.poll(() => page.evaluate(() => (window as unknown as BrowserChart).__ichimokuMatrix.filter(p => p.snapshot).length)).toBe(2);
      const result = await page.evaluate(async () => {
        const snapshots = (window as unknown as BrowserChart).__ichimokuMatrix.filter(p => p.snapshot).map(p => p.snapshot!);
        const modulePath = '/src/live/indicators/flagLegendValueRegistry.ts'; const { readFlagLegendValues } = await import(modulePath);
        return { bars: snapshots.map(s => s.model.bars.length), warm: snapshots.every(s => s.model.lines.leadingB.values.at(-1) !== null), values: readFlagLegendValues('ichimoku-overseas', 'ichimoku', 'main', null) };
      });
      expect(result.bars).toEqual([count, count]); expect(result.warm).toBe(true); expect(result.values.find((v: { key: string }) => v.key === 'conversion')?.value).toMatch(/\d+\.\d{2}$/);
      results.push({ timeframe: label, ...result }); await page.keyboard.press('Escape');
    }
    await page.screenshot({ path: path.resolve(`../.audit/preview/ichimoku-${subject}-minute.png`) });
    writeFileSync(path.resolve(`../.audit/preview/applicability-${subject}.json`), JSON.stringify({ fixture: 'Synthetic API boundary fixtures derived from existing overseas-indicators.spec.ts', results }, null, 2));
  });
}
test('domestic observed seconds adds primary and repeat through the toolbar', async ({ page }) => {
  test.setTimeout(60000); await page.setViewportSize({ width: 1440, height: 1000 }); await installLiveMocks(page);
  await page.route(apiExact('live/second-trade-dates'), route => route.fulfill({ json: { dates: [] } }));
  await page.route(apiExact('live/second-aggregates'), route => {
    const p = new URL(route.request().url()).searchParams, date = p.get('date')!, seconds = Number(p.get('seconds'));
    const start = Date.parse(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}T09:00:00+09:00`);
    const bars = Array.from({ length: 300 }, (_, i) => ({ t_ms: start + i * seconds * 1000, open: 35000 + i * 10, high: 35100 + i * 10, low: 34900 + i * 10, close: 35050 + i * 10, volume: 100 + i, count: 3, trade_value: 3500000 }));
    const from = Number(p.get('from_ms') ?? 0), to = Number(p.get('to_ms') ?? Infinity);
    return route.fulfill({ json: { code: '098460', venue: 'KRX', date, seconds, source: 'second_trades', status: 'observed', coverage: 'unverified', storage_error: null, first_observed_ms: start, last_observed_ms: bars.at(-1)!.t_ms, bars: bars.filter(b => b.t_ms >= from && b.t_ms < to), prices: [] } });
  });
  await page.goto('/live?code=098460');
  await page.getByRole('button', { name: '분봉 선택 열기: 1분', exact: true }).first().click(); await page.getByRole('menuitemradio', { name: '5초', exact: true }).click();
  const chart = page.getByTestId('second-chart'); await expect(chart.locator('canvas').first()).toBeVisible(); await expect.poll(() => candleCount(page)).toBeGreaterThan(50); await observe(page);
  await chart.getByRole('button', { name: '보조지표', exact: true }).click(); await add(page, false);
  const editor = page.getByTestId('indicator-panel-shell'); await editor.getByRole('button', { name: '하나 더 추가', exact: true }).click(); await editor.getByRole('button', { name: '설정대로 추가', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as BrowserChart).__ichimokuMatrix.filter(p => p.snapshot).length)).toBe(2); await page.keyboard.press('Escape');
  const before = await candleCount(page); await chart.getByRole('button', { name: '초봉 선택 열기: 5초', exact: true }).click(); await page.getByRole('menuitemradio', { name: '10초', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as BrowserChart).__ichimokuMatrix.filter(p => p.snapshot).length)).toBe(2);
  await page.screenshot({ path: path.resolve('../.audit/preview/ichimoku-seconds.png') });
  writeFileSync(path.resolve('../.audit/preview/applicability-seconds.json'), JSON.stringify({ fixture: 'Observed synthetic second-aggregates API fixture derived from second-chart-tools.spec.ts', before, after: await candleCount(page), seconds: [5, 10], instances: 2 }, null, 2));
});
