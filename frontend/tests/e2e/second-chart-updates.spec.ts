import { test, expect } from '@playwright/test';
import { installLiveMocks } from './helpers/liveMocks';

test('초봉 공통 렌더러는 10000봉의 지연 체결·새 봉·과거 추가 후에도 MA와 배율을 유지한다', async ({ page }) => {
  await installLiveMocks(page);
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  let stage = 0;
  const date = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
  const open = Date.parse(`${date}T09:00:00+09:00`);
  const base = Array.from({ length: 10000 }, (_, i) => ({ t_ms: open + i * 1000,
    open: 100, high: 110, low: 90, close: 100 + i % 7, volume: 10, count: 1, trade_value: 1000 }));
  await page.route('**/api/live/second-trade-dates?**', r => r.fulfill({ json: { dates: [] } }));
  await page.route('**/api/live/second-aggregates?**', r => {
    const params = new URL(r.request().url()).searchParams;
    let bars = stage ? base.map((bar, i) => i === 30 || i === 9999 ? { ...bar, close: 95 } : bar) : base;
    if (stage >= 2) bars = [...bars, { ...base.at(-1)!, t_ms: open + 10000 * 1000, close: 102 }];
    if (stage >= 3) bars = [{ ...base[0], t_ms: open - 1000 }, ...bars];
    return r.fulfill({ json: { code: '098460', venue: 'KRX', date: params.get('date'), seconds: Number(params.get('seconds')),
      source: 'second_trades', status: 'observed', coverage: 'unverified', storage_error: null,
      first_observed_ms: bars[0].t_ms, last_observed_ms: bars.at(-1)!.t_ms, bars, prices: [] } });
  });
  await page.goto('/live?code=098460');
  await page.evaluate(async () => {
    const path = '/src/state/workspace.ts';
    const { useWorkspaceStore: store } = await import(path);
    const win = store.getState().windows.find((w: { kind: string }) => w.kind === 'chart');
    store.setState({ windows: [{ ...win, rect: { x: 0, y: 0, w: 1, h: 1 }, chart: { timeframe: '1s' } }], zOrder: [win.id], maximizedId: null });
  });
  const chart = page.getByTestId('second-chart');
  await expect(chart).toHaveAttribute('data-bar-count', '10000');
  await expect(chart.locator('.legend-row-ma').first()).toBeVisible();
  const snapshot = () => page.evaluate(() => {
    const charts = (window as any).__liveCharts as Map<string, any>;
    const c = [...charts.values()][0];
    const candles = c.panes()[0].getSeries().find((s: any) => s.seriesType() === 'Candlestick');
    const data = candles.data();
    const range = c.timeScale().getVisibleLogicalRange();
    const ma = c.panes()[0].getSeries().filter((s: any) => s.seriesType() === 'Line').find((s: any) => s.data().some((p: any) => typeof p.value === 'number'));
    return { count: data.length, close: data.at(-1).close, spacing: c.timeScale().options().barSpacing,
      anchor: data[Math.floor(range.to)]?.time, ma: ma?.data().filter((p: any) => typeof p.value === 'number').at(-1)?.value };
  });
  await page.evaluate(() => {
    const c = [...((window as any).__liveCharts as Map<string, any>).values()][0];
    c.timeScale().setVisibleLogicalRange({ from: 9900, to: 9950 });
  });
  const before = await snapshot();
  stage = 1;
  await expect.poll(async () => (await snapshot()).close).toBe(95);
  expect((await snapshot()).spacing).toBeCloseTo(before.spacing, 6);
  stage = 2;
  await expect(chart).toHaveAttribute('data-bar-count', '10001');
  stage = 3;
  await expect(chart).toHaveAttribute('data-bar-count', '10002');
  await expect.poll(async () => (await snapshot()).anchor).toBe(before.anchor);
  expect((await snapshot()).spacing).toBeCloseTo(before.spacing, 6);
  const expectedMa = [...base.slice(-4).map((b, i) => i === 3 ? 95 : b.close), 102].reduce((a, b) => a + b, 0) / 5;
  await expect.poll(async () => (await snapshot()).ma).toBeCloseTo(expectedMa, 6);
  expect(errors).toEqual([]);
});
