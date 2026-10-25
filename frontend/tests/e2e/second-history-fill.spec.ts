import { expect, test, type Page } from '@playwright/test';
import { installLiveMocks } from './helpers/liveMocks';

async function setup(page: Page) {
  await installLiveMocks(page);
  const today = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
  const dates = [2, 1].map(offset => new Date(Date.parse(`${today}T12:00:00Z`) - offset * 86400000).toISOString().slice(0, 10).replaceAll('-', ''));
  const requests: URL[] = [];
  let hold = false;
  let fail = false;
  const releases: (() => void)[] = [];
  const open = (date: string) => Date.parse(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}T09:00:00+09:00`);
  await page.route('**/api/live/second-trade-dates?**', r => r.fulfill({ json: { dates } }));
  await page.route('**/api/live/second-aggregates?**', async r => {
    const url = new URL(r.request().url()), p = url.searchParams;
    const date = p.get('date')!, seconds = Number(p.get('seconds')), step = seconds * 1000;
    if (dates.includes(date)) requests.push(url);
    if (fail && dates.includes(date)) { await r.fulfill({ status: 503, json: { detail: 'test history unavailable' } }); return; }
    if (hold && dates.includes(date)) await new Promise<void>(resolve => releases.push(resolve));
    const start = open(date), day = dates.indexOf(date);
    const all = day < 0 ? [] : Array.from({ length: day === 0 ? 720 : 480 }, (_, i) => ({ t_ms: start + i * step,
      open: 35000 + day * 1000 + i, high: 35010 + day * 1000 + i, low: 34990 + day * 1000 + i,
      close: 35000 + day * 1000 + i, volume: 100, count: 1, trade_value: 3500000 }));
    const from = Number(p.get('from_ms')), to = Number(p.get('to_ms'));
    await r.fulfill({ json: { code: '098460', venue: p.get('venue'), date, seconds,
      source: 'second_trades', status: all.length ? 'observed' : 'unavailable', coverage: 'unverified', storage_error: null,
      first_observed_ms: all[0]?.t_ms ?? null, last_observed_ms: all.at(-1)?.t_ms ?? null,
      bars: all.filter(b => b.t_ms >= from && b.t_ms < to), prices: [] } });
  });
  await page.goto('/live?code=098460');
  const id = await page.evaluate(async () => {
    const path = '/src/state/workspace.ts';
    const { useWorkspaceStore: store } = await import(path);
    const win = store.getState().windows.find((w: any) => w.kind === 'chart');
    store.setState({ windows: [{ ...win, chart: { timeframe: '10s' }, rect: { x: 0, y: 0, w: 1, h: 1 } }],
      zOrder: [win.id], maximizedId: null, chartRuntime: {} });
    return win.id as string;
  });
  const chart = page.getByTestId('second-chart');
  await expect(chart).toHaveAttribute('data-bar-count', '240');
  return { id, chart, dates, open, requests, pending: () => releases.length,
    fail: () => { fail = true; }, resume: () => { fail = false; },
    hold: () => { hold = true; }, release: () => { hold = false; releases.splice(0).forEach(fn => fn()); } };
}

async function range(page: Page, id: string, from: number, to: number) {
  await page.evaluate(({ id, from, to }) => {
    ((window as any).__liveCharts as Map<string, any>).get(id).timeScale().setVisibleLogicalRange({ from, to });
  }, { id, from, to });
}

async function snapshot(page: Page, id: string) {
  // close=36400 identifies yesterday's actual 09:00 + 400*10s candle,
  // independent of prepended logical indices and compressed overnight axes.
  return page.evaluate(id => {
    const c = ((window as any).__liveCharts as Map<string, any>).get(id), ts = c.timeScale();
    const candles = c.panes()[0].getSeries().find((s: any) => s.seriesType() === 'Candlestick').data();
    const index = candles.findIndex((b: any) => b.close === 36400), anchor = candles[index];
    const x = ts.timeToCoordinate(anchor.time), nextX = ts.timeToCoordinate(candles[index + 1].time);
    const logical = ts.getVisibleLogicalRange();
    return { x, distance: nextX - x, spacing: ts.options().barSpacing, span: logical.to - logical.from, from: logical.from };
  }, id);
}

for (const movePending of [false, true]) {
  test(`one seconds gesture fills across days and preserves the ${movePending ? 'viewport changed during HTTP' : 'original viewport'}`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    const s = await setup(page);
    await range(page, s.id, -600, 239);
    const plot = await s.chart.locator('canvas').first().boundingBox();
    s.hold();
    // One actual pointer gesture arms the already-panned viewport. No second
    // wheel/click is needed to fetch the following pages.
    await page.mouse.click(plot!.x + plot!.width * 0.8, plot!.y + plot!.height * 0.4);
    await expect.poll(s.pending).toBe(1);
    if (movePending) await range(page, s.id, -800.5, 199.25);
    const before = await snapshot(page, s.id);
    s.release();
    await expect(s.chart).toHaveAttribute('data-bar-count', '960');
    await expect(s.chart).toHaveAttribute('data-day-count', '2');
    await expect.poll(async () => (await snapshot(page, s.id)).x).toBeCloseTo(before.x, 5);
    const after = await snapshot(page, s.id);
    expect(after.span).toBeCloseTo(before.span, 5);
    expect(after.spacing).toBeCloseTo(before.spacing, 5);
    expect(after.distance).toBeCloseTo(before.distance, 5);
    if (movePending) expect(after.from).toBeLessThan(0); // the frozen goal did not grow
    const count = s.requests.length;
    await page.waitForTimeout(600); // prove automatic paging has settled
    expect(s.requests).toHaveLength(count);
    await expect(s.chart).toHaveAttribute('data-bar-count', '960');
    // A fresh gesture can fill the remaining deficit, stopping at real data end.
    if (movePending) {
      await page.mouse.click(plot!.x + plot!.width * 0.8, plot!.y + plot!.height * 0.4);
      await expect(s.chart).toHaveAttribute('data-bar-count', '1200');
      await expect(s.chart.getByText(/저장된 과거 데이터 끝/)).toBeVisible();
    }
    expect(errors).toEqual([]);
  });
}

test('seconds autofill stops at an explicit range floor', async ({ page }) => {
  const s = await setup(page), floor = s.open(s.dates[1]) + 100 * 10000;
  await page.evaluate(async ({ id, floor }) => {
    const path = '/src/state/workspace.ts';
    const { useWorkspaceStore } = await import(path);
    useWorkspaceStore.getState().setSecondChartRange(id, { fromMs: floor, toMs: floor + 359 * 10000 });
  }, { id: s.id, floor });
  await expect(s.chart).toHaveAttribute('data-bar-count', '360');
  await expect(s.chart.getByText(/선택 구간 시작/)).toBeVisible();
  const before = s.requests.length;
  await range(page, s.id, -600, 239);
  const plot = await s.chart.locator('canvas').first().boundingBox();
  await page.mouse.click(plot!.x + 100, plot!.y + 100);
  await page.waitForTimeout(500);
  expect(s.requests).toHaveLength(before);
  await expect(s.chart.getByRole('button', { name: '이전 구간 불러오기', exact: true })).toHaveCount(0);
});

test('a failed seconds fill stops and retries its failed page without moving the viewport', async ({ page }) => {
  const s = await setup(page);
  await range(page, s.id, -600, 239);
  const before = await snapshot(page, s.id);
  s.fail();
  const plot = await s.chart.locator('canvas').first().boundingBox();
  await page.mouse.click(plot!.x + 100, plot!.y + 100);
  const retry = s.chart.getByRole('button', { name: '초봉 조회 실패 · 다시 조회', exact: true });
  await expect(retry).toBeVisible();
  const count = s.requests.length;
  await page.waitForTimeout(500);
  expect(s.requests).toHaveLength(count);
  await expect(s.chart).toHaveAttribute('data-bar-count', '240');
  s.resume();
  await retry.click();
  await expect(s.chart).toHaveAttribute('data-bar-count', '480');
  await expect(retry).toHaveCount(0);
  expect((await snapshot(page, s.id)).spacing).toBeCloseTo(before.spacing, 5);
  expect((await snapshot(page, s.id)).x).toBeCloseTo(before.x, 5);
  await expect(s.chart.getByRole('button', { name: '이전 구간 불러오기', exact: true })).toBeVisible();
});
