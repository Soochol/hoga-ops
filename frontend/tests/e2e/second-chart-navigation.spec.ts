import { randomUUID } from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';
import { installLiveMocks } from './helpers/liveMocks';
import { apiPrefix } from './helpers/apiRoutes';
import { API_URL } from './worktreeEnv';

async function secondsMock(page: Page) {
  const calls: URL[] = [];
  await page.route('**/api/live/second-trade-dates?**', r => r.fulfill({ json: { dates: ['20260528'] } }));
  await page.route('**/api/live/second-aggregates?**', r => {
    const url = new URL(r.request().url()); calls.push(url);
    const p = url.searchParams, date = p.get('date')!, seconds = Number(p.get('seconds'));
    const midnight = Date.parse(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}T00:00:00+09:00`);
    const first = midnight + 9 * 3600000, last = first + 4 * 3600000;
    const from = Math.max(first, Number(p.get('from_ms') ?? 0)), to = Math.min(last, Number(p.get('to_ms') ?? Infinity));
    const bars = [];
    for (let t = Math.ceil(from / (seconds * 1000)) * seconds * 1000; t < to; t += seconds * 1000)
      bars.push({ t_ms: t, open: 35000, high: 35100, low: 34900, close: 35050, volume: seconds * 5, count: seconds * 2, trade_value: seconds * 175000 });
    const prices = [];
    if (p.get('include_prices') === 'true') for (let t = Math.ceil(from / 1000) * 1000; t < to; t += 1000)
      prices.push({ t_ms: t, price: 35000, side: 1, qty: 3, count: 1 }, { t_ms: t, price: 35000, side: -1, qty: 2, count: 1 });
    return r.fulfill({ json: { code: p.get('code'), venue: p.get('venue'), date, seconds, source: 'second_trades', coverage: 'unverified',
      status: bars.length ? 'observed' : 'unavailable', storage_error: null, first_observed_ms: first, last_observed_ms: last - 1000, bars, prices } });
  });
  return calls;
}

async function singleMinute(page: Page) {
  await page.evaluate(async () => {
    const path = '/src/state/workspace.ts';
    const { useWorkspaceStore: store } = await import(path);
    const win = store.getState().windows.find((w: any) => w.kind === 'chart');
    store.setState({ windows: [{ ...win, rect: { x: 0, y: 0, w: 1, h: 1 }, chart: { timeframe: '1m' } }], zOrder: [win.id], chartRuntime: {}, maximizedId: null });
  });
}

test('minute toolbar opens the exact past seconds interval, saves it, and deep-link restores it in KRX', async ({ page, request }, testInfo) => {
  const marker = randomUUID();
  const savedName = `초봉 저장 ${marker.slice(0, 8)}`;
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await installLiveMocks(page);
  const calls = await secondsMock(page);
  await page.goto('/live?code=098460');
  await singleMinute(page);
  await page.getByTestId('chart-window-header').getByRole('button', { name: '초봉으로 확대', exact: true }).click();
  const chart = page.getByTestId('second-chart');
  await expect(chart).toBeVisible();
  await expect(chart).toHaveAttribute('data-bar-count', '12');
  expect(calls[0].searchParams.get('date')).toBe('20260528');
  expect(Number(calls[0].searchParams.get('to_ms')) - Number(calls[0].searchParams.get('from_ms'))).toBe(60000);
  await expect(chart.getByText('초봉 구간 표시 중', { exact: false })).toBeVisible();
  await chart.getByRole('button', { name: '현재 뷰 저장', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '저장뷰 저장' });
  if (await dialog.getByRole('button', { name: '+ 새 그룹', exact: true }).isVisible())
    await dialog.getByRole('button', { name: '+ 새 그룹', exact: true }).click();
  await dialog.getByLabel('새 그룹 이름').fill(`초봉 복기 ${marker}`);
  await dialog.getByLabel('이름', { exact: true }).fill(savedName);
  await expect(dialog.getByRole('checkbox', { name: '빠진 기간 수집' })).toHaveCount(0);
  await dialog.getByRole('button', { name: '그룹 만들고 저장' }).click();
  await expect(dialog).toHaveCount(0);
  const file = await (await request.get(`${API_URL}/api/study-views/saves`)).json();
  const row = file.saves.find((v: any) => v.name === savedName);
  expect(row.timeframe).toBe('5s');
  expect(row.range.to_ms - row.range.from_ms).toBe(55000);
  await page.goto(`/live?view=${encodeURIComponent(row.id)}`);
  await expect(chart.getByRole('button', { name: '초봉 선택 열기: 5초' })).toBeVisible();
  await expect(chart).toHaveAttribute('data-bar-count', '12');
  await expect(chart.getByText('KRX', { exact: true })).toBeVisible();
  const count = calls.length;
  // Current settings re-analyze the same saved period; historical views do not poll.
  await page.evaluate(async () => {
    const path = '/src/state/liveVenue.ts';
    const { useLiveVenueStore } = await import(path);
    useLiveVenueStore.setState({ venue: 'NXT' });
  });
  await expect(chart.getByText('KRX', { exact: true })).toBeVisible();
  expect(calls.slice(count).every(url => url.searchParams.get('venue') === 'KRX')).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('seconds-saved-range.png') });
  expect(errors).toEqual([]);
});

test('seconds directional trade pane uses raw second cells and does not offer daily cumulative estimates', async ({ page }) => {
  await installLiveMocks(page);
  const calls = await secondsMock(page);
  await page.goto('/live?code=098460');
  await singleMinute(page);
  await page.getByRole('button', { name: '초봉으로 확대', exact: true }).click();
  const chart = page.getByTestId('second-chart');
  await expect(chart).toHaveAttribute('data-bar-count', '12');
  await chart.getByRole('button', { name: '보조지표', exact: true }).click();
  await page.getByRole('button', { name: '지표 추가', exact: true }).click();
  await page.getByRole('button', { name: '체결강도', exact: true }).click();
  await expect(page.getByText('표시 구간의 관측 매수·매도 체결량입니다.', { exact: false })).toBeVisible();
  await expect(page.getByTestId('settings-toggle-fillStrengthCumulative')).toHaveCount(0);
  await page.getByRole('button', { name: '설정대로 추가', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect.poll(() => calls.some(url => url.searchParams.get('include_prices') === 'true')).toBe(true);
  await expect.poll(() => page.evaluate(async () => {
    const path = '/src/state/workspace.ts';
    const { useWorkspaceStore } = await import(path);
    const id = useWorkspaceStore.getState().windows.find((w: any) => w.chart?.timeframe === '5s')?.id;
    const charts = (window as any).__liveCharts as Map<string, any>;
    const c = charts.get(id);
    const histograms = c?.panes()[2]?.getSeries().filter((s: any) => s.seriesType() === 'Histogram');
    return histograms?.map((s: any) => s.data().filter((p: any) => typeof p.value === 'number').at(-1)?.value);
  })).toEqual([15, -10]);
});

test('enabling trade quantities retains loaded seconds history', async ({ page }) => {
  await installLiveMocks(page);
  const calls = await secondsMock(page);
  await page.goto('/live?code=098460');
  await singleMinute(page);
  await page.evaluate(async () => {
    const path = '/src/state/workspace.ts';
    const { useWorkspaceStore } = await import(path);
    const win = useWorkspaceStore.getState().windows[0];
    useWorkspaceStore.getState().setChartTimeframe(win.id, '5s');
  });
  const chart = page.getByTestId('second-chart');
  await expect(chart).toHaveAttribute('data-bar-count', '240');
  await chart.getByRole('button', { name: '이전 구간 불러오기', exact: true }).click();
  await expect(chart).toHaveAttribute('data-bar-count', '480');
  await chart.getByRole('button', { name: '보조지표', exact: true }).click();
  await page.getByRole('button', { name: '지표 추가', exact: true }).click();
  await page.getByRole('button', { name: '체결강도', exact: true }).click();
  await page.getByRole('button', { name: '설정대로 추가', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect.poll(() => calls.filter(url => url.searchParams.get('include_prices') === 'true').length).toBeGreaterThanOrEqual(2);
  await expect.poll(() => page.evaluate(async () => {
    const path = '/src/state/workspace.ts';
    const { useWorkspaceStore } = await import(path);
    const id = useWorkspaceStore.getState().windows[0].id;
    const c = ((window as any).__liveCharts as Map<string, any>).get(id);
    return c?.panes()[2]?.getSeries().filter((s: any) => s.seriesType() === 'Histogram')
      .map((s: any) => s.data().filter((p: any) => typeof p.value === 'number').length);
  })).toEqual([480, 480]);
  await expect(chart).toHaveAttribute('data-bar-count', '480');
});

test('a measured minute range overrides the saved span and retains its KRX source', async ({ page }) => {
  await installLiveMocks(page);
  const calls = await secondsMock(page);
  const start = Date.parse('2026-05-28T09:00:00+09:00');
  await page.route(apiPrefix('range'), r => r.fulfill({ json: {
    code: '098460', from_date: '20260528', to_date: '20260528', bucket_ms: 60000,
    segments: [{ date: '20260528', session_open_ms: start, session_close_ms: start + 23400000, source: 'hogaplay' }],
    candles: [0, 60000, 120000].map(offset => ({ ts_ms: start + offset, open: 35000, high: 35200, low: 34900, close: 35100, vol_a: 100, vol_b: 50 })),
    quote_ratio: { bucket_ms: 60000, points: [] }, fill_strength: { bucket_ms: 60000, points: [] },
    volume_profile_range: { bin_count: 0, price_min: 0, price_max: 0, bin_width: 0, bins: [] },
    volume_profile_by_day: [], excluded_dates: [], data_warnings: [],
  } }));
  await page.goto('/live?code=098460');
  await singleMinute(page);
  await page.evaluate(async start => {
    const pagePath = '/src/state/livePage.ts', venuePath = '/src/state/liveVenue.ts';
    const { useLivePageStore } = await import(pagePath);
    const { useLiveVenueStore } = await import(venuePath);
    useLiveVenueStore.setState({ venue: 'NXT' });
    useLivePageStore.getState().focusSavedRange({ viewId: 'measured-saved-source', code: '098460', label: '고영',
      fromMs: start, toMs: start + 59000, fromDate: '20260528', toDate: '20260528', savedTimeframe: '1m', savedBarSpan: 1 });
  }, start);
  await expect(page.getByTestId('live-saved-range-chip')).toBeVisible();
  await expect(page.getByRole('button', { name: '초봉으로 확대', exact: true })).toBeEnabled();
  await page.evaluate(async start => {
    const drawingsPath = '/src/state/drawings.ts';
    const { useDrawingsStore, drawingScopeFor } = await import(drawingsPath);
    const scope = drawingScopeFor('098460', '1m'), store = useDrawingsStore.getState();
    store.setActiveScope(scope);
    store.add(scope, { id: 'seconds-measure', kind: 'measure',
      a: { realMs: start + 70000, price: 35000 }, b: { realMs: start + 140000, price: 35100 },
      color: '#14B8A6', width: 2, lineStyle: 'solid', paneId: 'candle' });
    store.setActiveTool('select');
    store.setSelected(scope, 'seconds-measure');
  }, start);
  await page.getByTestId('drawing-inspect-seconds').click();
  const chart = page.getByTestId('second-chart');
  await expect(chart).toHaveAttribute('data-bar-count', '15');
  expect(calls.at(-1)?.searchParams.get('venue')).toBe('KRX');
  expect(Number(calls.at(-1)?.searchParams.get('from_ms'))).toBe(start + 70000);
  expect(Number(calls.at(-1)?.searchParams.get('to_ms'))).toBe(start + 145000);
  await chart.getByRole('button', { name: '초봉 구간 해제', exact: true }).click();
  // Ending drill-down leaves the source saved view selected.
  await expect(chart.getByTestId('live-saved-range-chip')).toBeVisible();
});
