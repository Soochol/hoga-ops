import { readFileSync } from 'node:fs';
import { expect, type Page } from '@playwright/test';
import type { IChartApi } from 'lightweight-charts';
import { installLiveMocks } from './liveMocks';
import type { LiveTimeframe } from '../../../src/state/livePage';

export const CODE = '098460';
export const DATE = '20260930';
export const START = Date.parse('2026-09-30T09:00:00+09:00');
const driver = readFileSync(new URL('../../../../docs/agents/chart-sync-qa.driver.js', import.meta.url), 'utf8');
type DriverWindow = Window & { __qa: {
  chart: (id: string) => IChartApi;
  hit: (id: string, fraction: number) => { x: number; y: number };
} };

export async function setup(page: Page, timeframe: LiveTimeframe, book = false, secondCount = 240, boundedSeconds = false) {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.clock.setFixedTime(new Date('2026-10-01T10:00:00+09:00'));
  await page.addInitScript(({ timeframe, book }) => {
    localStorage.setItem('live.venue.v1', JSON.stringify({ venue: 'KRX' }));
    const workspace = { schema_version: 2,
      windows: [
        { id: 'cursor-chart', kind: 'chart', group: 1, chart: { timeframe, hoverLinked: true }, rect: { x: 0, y: 0, w: 0.65, h: 1 } },
        { id: 'cursor-trade', kind: 'trade', group: 1, rect: { x: 0.65, y: 0, w: 0.35, h: 0.6 } },
        { id: 'other-trade', kind: 'trade', group: 2, rect: { x: 0.65, y: 0.6, w: 0.35, h: 0.4 } },
        ...(book ? [{ id: 'cursor-book', kind: 'book', group: 1, rect: { x: 0.65, y: 0.6, w: 0.35, h: 0.4 } }] : []),
      ], zOrder: ['cursor-chart', 'cursor-trade', 'other-trade', ...(book ? ['cursor-book'] : [])],
      groupSymbols: { 1: { code: '098460', name: '고영' }, 2: { code: '098460', name: '고영' } } };
    sessionStorage.setItem('live.workspace.v1', JSON.stringify(workspace));
    localStorage.setItem('live.workspace.v1', JSON.stringify(workspace));
  }, { timeframe, book });
  await installLiveMocks(page);
  await page.routeWebSocket(/\/api\/ws/, () => {});
  let settings = { schema_version: 1, rest_bypass_enabled: false, screener_depth_autocollect: false, krx_prefer_hogaplay: true };
  await page.route('**/api/live/settings', async route => {
    if (route.request().method() === 'PATCH') settings = { ...settings, ...route.request().postDataJSON() };
    await route.fulfill({ json: settings });
  });
  await page.route('**/api/live/trades/history?**', route => route.fulfill({ json: {
    code: CODE, date: '20261001', venue: 'KRX', rows: [], next_key: null, latest_at_ms: null, latest_volume: null, prev_close: null,
  } }));
  await page.route('**/api/live/past-candles?**', route => {
    const params = new URL(route.request().url()).searchParams;
    const step = Number(params.get('bucket_ms') ?? 60000);
    return route.fulfill({ json: { code: CODE, from: params.get('from'), to: params.get('to'), bucket_ms: step,
      candles: Array.from({ length: 60 }, (_, i) => ({ t_ms: START + i * step, open: 35000, high: 35200, low: 34900, close: 35100, volume: 100 })),
      cached_dates: [DATE], fresh_dates: [], data_warnings: [] } });
  });
  await page.route('**/api/live/second-trade-dates?**', route => route.fulfill({ json: { dates: [DATE] } }));
  const secondRequests: URL[] = [];
  await page.route('**/api/live/second-aggregates?**', route => {
    secondRequests.push(new URL(route.request().url()));
    const params = new URL(route.request().url()).searchParams;
    const date = params.get('date');
    const seconds = Number(params.get('seconds'));
    const all = date === DATE ? Array.from({ length: secondCount }, (_, i) => ({ t_ms: START + i * seconds * 1000,
      open: 35000, high: 35200, low: 34900, close: 35100, volume: 100, count: 5, trade_value: 3500000 })) : [];
    const bars = boundedSeconds ? all.filter(b => b.t_ms >= Number(params.get('from_ms') ?? 0) && b.t_ms < Number(params.get('to_ms') ?? Infinity)) : all;
    return route.fulfill({ json: { code: CODE, venue: 'KRX', date, seconds, source: all.length ? 'hogaplay' : null,
      status: all.length ? 'observed' : 'unavailable', coverage: 'unverified', storage_error: null,
      bars, prices: [], first_observed_ms: all[0]?.t_ms ?? null, last_observed_ms: all.at(-1)?.t_ms ?? null } });
  });
  const requests: URL[] = [];
  await page.route('**/api/trades/spot?**', route => {
    const url = new URL(route.request().url()); requests.push(url);
    const p = url.searchParams;
    const aggregate = p.get('source_pref') !== 'hogaplay';
    return route.fulfill({ json: { code: p.get('code'), date: p.get('date'), venue: p.get('venue'),
      source_pref: p.get('source_pref'), from_ms: Number(p.get('from_ms')), to_ms: Number(p.get('to_ms')),
      source: aggregate ? 'kiwoom_live' : 'hogaplay', representation: aggregate ? 'second_price_aggregate' : 'ticks',
      status: 'observed', coverage: 'unverified', storage_error: null, revision: 'r1', has_more: false, next_cursor: null, prev_close: 35000,
      rows: [{ event_id: 'fixture', t_ms: Number(p.get('from_ms')), price: 35100, qty: 25, side: 1, count: aggregate ? 3 : 1 }] } });
  });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/live?code=098460');
  await expect(page.locator('[data-win="cursor-trade"] [data-testid="trade-window"]')).toBeVisible();
  await page.addScriptTag({ content: driver });
  return { requests, errors, secondRequests };
}

export async function hoverCandle(page: Page, seconds: boolean) {
  if (seconds) {
    const chart = page.getByTestId('second-chart');
    await expect(chart).toHaveAttribute('data-bar-count', '240');
    await page.evaluate(() => (window as unknown as DriverWindow).__qa.chart('cursor-chart').timeScale().setVisibleLogicalRange({ from: 10, to: 40 }));
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const box = await chart.locator('canvas').first().boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.move(box!.x + box!.width * 0.5, box!.y + box!.height * 0.4);
  } else {
    await expect.poll(() => page.evaluate(() => {
      const registry = (window as unknown as { __liveCharts?: Map<string, IChartApi> }).__liveCharts;
      return registry?.get('cursor-chart')?.panes()[0].getSeries().some(s => s.seriesType() === 'Candlestick' && s.data().length > 0) ?? false;
    })).toBe(true);
    await page.evaluate(() => (window as unknown as DriverWindow).__qa.chart('cursor-chart').timeScale().setVisibleLogicalRange({ from: 10, to: 40 }));
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const point = await page.evaluate(() => {
      const { x, y } = (window as unknown as DriverWindow).__qa.hit('cursor-chart', 0.5);
      return { x, y };
    });
    await page.mouse.move(point.x, point.y);
  }
}

