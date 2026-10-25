import { expect, test, type Page } from '@playwright/test';
import { installLiveMocks } from './helpers/liveMocks';

async function setup(page: Page) {
  await installLiveMocks(page);
  const today = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
  const first = Date.parse(`${today}T14:00:00+09:00`) - 86400000;
  const dates = [first, first + 86400000].map(ms => new Date(ms + 9 * 3600000).toISOString().slice(0, 10).replaceAll('-', ''));
  await page.route('**/api/live/second-trade-dates?**', r => r.fulfill({ json: { dates } }));
  await page.route('**/api/live/second-aggregates?**', r => {
    const p = new URL(r.request().url()).searchParams;
    const date = p.get('date')!, seconds = Number(p.get('seconds')), step = seconds * 1000;
    const start = Date.parse(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}T14:00:00+09:00`);
    const from = Number(p.get('from_ms') ?? 0), to = Number(p.get('to_ms') ?? Infinity);
    const bars = dates.includes(date) ? Array.from({ length: Math.ceil(450000 / step) }, (_, i) => {
      const t_ms = start + i * step, close = 35000 + (t_ms - first) / 1000;
      return { t_ms, open: close, high: close + 10, low: close - 10, close, volume: 100, count: 2, trade_value: close * 100 };
    }) : [];
    return r.fulfill({ json: { code: '098460', venue: p.get('venue'), date, seconds, source: 'second_trades',
      status: bars.length ? 'observed' : 'unavailable', coverage: 'unverified', storage_error: null,
      first_observed_ms: bars[0]?.t_ms ?? null, last_observed_ms: bars.at(-1)?.t_ms ?? null,
      bars: bars.filter(b => b.t_ms >= from && b.t_ms < to), prices: [] } });
  });
  await page.goto('/live?code=098460');
  const id = await page.evaluate(async () => {
    const path = '/src/state/workspace.ts';
    const { useWorkspaceStore: store } = await import(path);
    const win = store.getState().windows.find((w: any) => w.kind === 'chart');
    store.setState({ windows: [{ ...win, rect: { x: 0, y: 0, w: 1, h: 1 }, chart: { timeframe: '5s' } }],
      zOrder: [win.id], chartRuntime: {}, maximizedId: null });
    return win.id as string;
  });
  await expect(page.getByTestId('second-chart')).toHaveAttribute('data-bar-count', '180');
  return { id, first, dates };
}

async function visible(page: Page, id: string, origin: number) {
  return page.evaluate(({ id, origin }) => {
    const c = ((window as any).__liveCharts as Map<string, any>).get(id);
    const ts = c?.timeScale(), vr = ts?.getVisibleRange(), lr = ts?.getVisibleLogicalRange();
    const series = c?.panes()[0]?.getSeries().find((s: any) => s.seriesType() === 'Candlestick');
    const rows = series?.data().filter((p: any) => typeof p.close === 'number' && p.time >= vr?.from && p.time <= vr?.to);
    return rows?.length ? { left: origin + (rows[0].close - 35000) * 1000,
      right: origin + (rows.at(-1).close - 35000) * 1000, span: lr.to - lr.from } : null;
  }, { id, origin });
}

async function setRange(page: Page, id: string, from: number, to: number) {
  await page.evaluate(({ id, from, to }) => {
    ((window as any).__liveCharts as Map<string, any>).get(id).timeScale().setVisibleLogicalRange({ from, to });
  }, { id, from, to });
}

async function switchTo(page: Page, label: string) {
  await page.getByTestId('second-chart').getByRole('button', { name: /초봉 선택 열기:/ }).click();
  await page.getByRole('menuitemradio', { name: label, exact: true }).click();
  await expect(page.getByTestId('second-chart').getByRole('button', { name: `초봉 선택 열기: ${label}` })).toBeVisible();
}

test('past seconds viewport survives 5→10→30→1 seconds and can return to latest', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  const { id, first } = await setup(page);
  await setRange(page, id, 20, 50);
  await expect.poll(async () => (await visible(page, id, first))?.right).toBe(first + 250000);
  await switchTo(page, '10초');
  await expect.poll(() => visible(page, id, first)).toMatchObject({ left: first + 100000, right: first + 250000, span: 15 });
  // Keyboard/menu commands also pass through the store action.
  await page.evaluate(async id => {
    const path = '/src/state/workspace.ts';
    const { useWorkspaceStore } = await import(path);
    useWorkspaceStore.getState().setChartTimeframe(id, '30s');
  }, id);
  await expect.poll(() => visible(page, id, first)).toMatchObject({ left: first + 90000, right: first + 240000, span: 5 });
  await switchTo(page, '1초');
  await expect.poll(() => visible(page, id, first)).toMatchObject({ left: first + 90000, right: first + 240000, span: 150 });
  // Whitespace after the bounded historical edge is not permission to follow today.
  await page.evaluate(id => {
    const c = ((window as any).__liveCharts as Map<string, any>).get(id);
    const series = c.panes()[0].getSeries().find((s: any) => s.seriesType() === 'Candlestick');
    const last = c.timeScale().timeToIndex(series.data().at(-1).time);
    c.timeScale().setVisibleLogicalRange({ from: last - 100, to: last + 20 });
  }, id);
  await expect.poll(async () => (await visible(page, id, first))?.span).toBe(120);
  await switchTo(page, '5초');
  await expect.poll(() => visible(page, id, first)).toMatchObject({ left: first + 140000, right: first + 240000, span: 24 });
  await page.getByTestId('second-chart').getByRole('button', { name: '최근 시각으로 돌아가기', exact: true }).click();
  await expect.poll(async () => (await visible(page, id, first))?.right).toBe(first + 86400000 + 445000);
  expect(errors).toEqual([]);
});

test('seconds transition retains the observed interval across an overnight gap', async ({ page }) => {
  const { id, first } = await setup(page);
  await setRange(page, id, 80, 95);
  await expect.poll(async () => (await visible(page, id, first))?.right).toBe(first + 86400000 + 25000);
  await switchTo(page, '10초');
  await expect.poll(() => visible(page, id, first)).toMatchObject({ left: first + 400000, right: first + 86400000 + 20000, span: 7 });
});

test('a zoomed explicit seconds range keeps its view while changing resolution', async ({ page }) => {
  const { id, first } = await setup(page);
  await page.evaluate(async ({ id, first }) => {
    const path = '/src/state/workspace.ts';
    const { useWorkspaceStore } = await import(path);
    useWorkspaceStore.getState().setSecondChartRange(id, { fromMs: first, toMs: first + 449000 });
  }, { id, first });
  await expect(page.getByTestId('second-chart')).toHaveAttribute('data-bar-count', '90');
  await setRange(page, id, 20, 50);
  await expect.poll(async () => (await visible(page, id, first))?.right).toBe(first + 250000);
  await switchTo(page, '10초');
  await expect.poll(() => visible(page, id, first)).toMatchObject({ left: first + 100000, right: first + 250000, span: 15 });
  await expect(page.getByRole('button', { name: '초봉 구간 해제', exact: true })).toBeVisible();
  // A later minute→seconds command replaces the transferred viewport.
  await page.evaluate(async ({ id, first }) => {
    const path = '/src/state/workspace.ts';
    const { useWorkspaceStore } = await import(path);
    useWorkspaceStore.getState().setSecondChartRange(id, { fromMs: first + 86400000 + 200000, toMs: first + 86400000 + 300000 });
  }, { id, first });
  await expect.poll(async () => (await visible(page, id, first))?.right).toBe(first + 86400000 + 300000);
});

test('opening a different saved view of the same Code replaces the old seconds viewport', async ({ page }) => {
  const { id, first, dates } = await setup(page);
  await setRange(page, id, 20, 50);
  await expect.poll(async () => (await visible(page, id, first))?.right).toBe(first + 250000);
  await page.evaluate(async ({ first, dates }) => {
    const path = '/src/studyViews/openSavedRange.ts';
    const { openSavedRange } = await import(path);
    openSavedRange({ schema_version: 2, id: 'same-code-next-period', group_id: 'group', code: '098460', label: '고영',
      timeframe: '30s', name: '다른 구간', memo: '', tags: [],
      range: { from_date: dates[1], to_date: dates[1], from_ms: first + 86400000 + 200000, to_ms: first + 86400000 + 400000 },
      viewport: { right_edge_ms: first + 86400000 + 400000, bar_span: 4, at_live_edge: false }, created_at_ms: 1, updated_at_ms: 1 });
  }, { first, dates });
  await expect(page.getByTestId('second-chart').getByTestId('live-saved-range-chip')).toBeVisible();
  await expect.poll(() => visible(page, id, first)).toMatchObject({ right: first + 86400000 + 390000, span: 4 });
});
