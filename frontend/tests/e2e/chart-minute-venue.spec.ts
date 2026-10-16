import { test, expect, type Page } from '@playwright/test';
import type { CandlestickData, IChartApi, ISeriesApi, Time } from 'lightweight-charts';
import type { WorkspaceWindow } from '../../src/state/workspace';
import { installLiveMocks } from './helpers/liveMocks';
import { installLiveWs } from './helpers/liveWs';
import { apiExact } from './helpers/apiRoutes';

async function selectVenue(page: Page, venue: 'KRX' | 'UN') {
  await page.getByTestId('live-venue-picker').click();
  await page.getByTestId(`live-venue-option-${venue}`).click();
}

test('우리로 통합 1분봉은 실시간 venue가 KRX여도 19:50~20:00 상승·하락 색을 유지한다', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.clock.setFixedTime(new Date('2026-10-16T20:05:00+09:00'));
  await page.addInitScript(() => {
    localStorage.setItem('live.venue.v1', JSON.stringify({ venue: 'UN' }));
  });
  await installLiveMocks(page);
  await page.routeWebSocket(/\/api\/ws/, () => {});
  await page.route(apiExact('symbols/all'), route => route.fulfill({ json: {
    symbols: [{ code: '046970', name: '우리로', market: 'KOSDAQ', nxt_enabled: false }],
  } }));
  await page.route(apiExact('live/settings'), route => route.fulfill({ json: {
    rest_bypass_enabled: false, krx_prefer_hogaplay: false,
  } }));
  const at = (time: string) => Date.parse(`2026-10-16T${time}:00+09:00`);
  const candles = [
    { t_ms: at('09:00'), open: 8100, high: 8200, low: 8010, close: 8170, volume: 157456 },
    { t_ms: at('15:20'), open: 8880, high: 8950, low: 8880, close: 8940, volume: 100 },
    { t_ms: at('19:49'), open: 8900, high: 8900, low: 8860, close: 8880, volume: 18150 },
    { t_ms: at('19:50'), open: 8880, high: 8950, low: 8880, close: 8940, volume: 21982 },
    { t_ms: at('19:52'), open: 8960, high: 8960, low: 8920, close: 8920, volume: 18890 },
    { t_ms: at('19:59'), open: 8890, high: 8950, low: 8880, close: 8930, volume: 64784 },
    { t_ms: at('20:00'), open: 8930, high: 8930, low: 8920, close: 8920, volume: 100 },
  ];
  const liveVenues: string[] = [];
  await page.route(apiExact('live/series'), route => {
    liveVenues.push(new URL(route.request().url()).searchParams.get('venue') ?? '');
    return route.fulfill({ json: { code: '046970', date: '20261016', is_open: false,
      snapshots: [], trades: [], brokers: [], session_open_ms: at('09:00'), session_close_ms: at('20:00') } });
  });
  await page.route(apiExact('live/past-candles'), route => {
    const params = new URL(route.request().url()).searchParams;
    const venue = params.get('venue');
    return route.fulfill({ json: {
      code: '046970', venue, bucket_ms: Number(params.get('bucket_ms')),
      from: params.get('from'), to: params.get('to'), candles,
      cached_dates: [], fresh_dates: ['20261016'], data_warnings: [],
      effective_sessions: [{ date: '20261016', venue,
        open_ms: at(venue === 'UN' ? '08:00' : '09:00'), close_ms: at('20:00') }],
    } });
  });
  await page.goto('/live?code=046970');
  await expect(page.locator('[data-win]').first()).toBeVisible();
  const id = await page.evaluate(async () => {
    const path = '/src/state/workspace.ts';
    const { useWorkspaceStore: store } = await import(path);
    const win = store.getState().windows.find((w: WorkspaceWindow) => w.kind === 'chart');
    store.getState().applyWorkspaceSnapshot({ windows: [{ ...win, group: 1,
      rect: { x: 0, y: 0, w: 1, h: 1 }, chart: { ...win.chart, timeframe: '1m', regularSessionOnly: false } }],
      zOrder: [win.id], maximizedId: null });
    store.getState().setWindowSymbol(win.id, { code: '046970', name: '우리로', kind: 'stock' });
    return win.id as string;
  });
  const displayed = () => page.evaluate(id => {
    const chart = (window as unknown as { __liveCharts?: Map<string, IChartApi> }).__liveCharts?.get(id);
    const series = chart?.panes().flatMap(pane => pane.getSeries())
      .find(series => series.seriesType() === 'Candlestick') as ISeriesApi<'Candlestick'> | undefined;
    if (!series) return null;
    const options = series.options();
    return { up: options.upColor, down: options.downColor,
      bars: series.data().filter(bar => 'open' in bar) as CandlestickData<Time>[] };
  }, id);
  const expectedColors = async () => {
    const data = await displayed();
    return !!data && data.bars.length === candles.length && data.bars.every((bar, i) => {
      const color = candles[i].close >= candles[i].open ? data.up : data.down;
      return bar.color === color && bar.wickColor === color && bar.borderColor === color;
    });
  };
  await expect.poll(() => liveVenues.includes('KRX')).toBe(true);
  await expect.poll(expectedColors).toBe(true);
  await selectVenue(page, 'KRX');
  // KRX still mutes its real 15:20 closing auction, not its aftermarket tail.
  await expect.poll(async () => {
    const data = await displayed();
    return data?.bars.length === candles.length && data.bars[1].color !== data.up && data.bars[1].color !== data.down;
  }).toBe(true);
  await selectVenue(page, 'UN');
  await expect.poll(expectedColors).toBe(true);
  await page.reload();
  await expect(page.getByTestId('live-venue-picker')).toContainText('통합');
  await expect.poll(expectedColors).toBe(true);
});

test('UN minute history retains Jeju premarket when current NXT eligibility is false', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.clock.setFixedTime(new Date('2026-01-30T10:00:00+09:00'));
  await page.addInitScript(() => {
    localStorage.setItem('live.venue.v1', JSON.stringify({ venue: 'UN' }));
  });
  await installLiveMocks(page);
  const ws = await installLiveWs(page);
  await page.route(apiExact('symbols/all'), route => route.fulfill({ json: {
    symbols: [{ code: '080220', name: '제주반도체', market: 'KOSDAQ', nxt_enabled: false }],
  } }));
  await page.route(apiExact('live/settings'), route => route.fulfill({ json: {
    rest_bypass_enabled: false, krx_prefer_hogaplay: false,
  } }));

  const premarket = Date.parse('2026-01-29T08:00:00+09:00');
  const regular = premarket + 3600_000;
  const today = Date.parse('2026-01-30T09:00:00+09:00');
  const pastBars = [
    { t_ms: premarket, open: 36400, high: 39250, low: 36400, close: 38850, volume: 2525271 },
    { t_ms: premarket + 900_000, open: 38900, high: 39500, low: 38550, close: 38800, volume: 1430701 },
    { t_ms: regular, open: 38350, high: 39050, low: 36900, close: 36900, volume: 1971426 },
    { t_ms: regular + 6.5 * 3600_000, open: 36700, high: 36900, low: 36600, close: 36850, volume: 200 },
  ];
  const todayBar = { t_ms: today, open: 36100, high: 36300, low: 36000, close: 36200, volume: 100 };
  const minuteVenues: string[] = [];
  const liveVenues: string[] = [];
  await page.route(apiExact('live/series'), route => {
    liveVenues.push(new URL(route.request().url()).searchParams.get('venue') ?? '');
    return route.fulfill({ json: { code: '080220', date: '20260130', is_open: true,
      snapshots: [], trades: [], brokers: [], session_open_ms: today, session_close_ms: null } });
  });
  await page.route(apiExact('live/past-candles'), route => {
    const params = new URL(route.request().url()).searchParams;
    const venue = params.get('venue') ?? '';
    minuteVenues.push(venue);
    const integrated = venue === 'UN';
    return route.fulfill({ json: {
      code: '080220', venue, bucket_ms: Number(params.get('bucket_ms')),
      from: params.get('from'), to: params.get('to'),
      candles: [...pastBars.filter(bar => integrated || bar.t_ms >= regular), todayBar],
      cached_dates: ['20260129'], fresh_dates: ['20260130'], data_warnings: [],
      effective_sessions: [
        { date: '20260129', venue: integrated ? 'UN' : 'KRX', open_ms: integrated ? premarket : regular,
          close_ms: integrated ? premarket + 12 * 3600_000 : regular + 6.5 * 3600_000 },
        { date: '20260130', venue: 'KRX', open_ms: today, close_ms: today + 6.5 * 3600_000 },
      ],
    } });
  });
  await page.goto('/live?code=080220');
  await expect(page.locator('[data-win]').first()).toBeVisible();
  const id = await page.evaluate(async () => {
    const path = '/src/state/workspace.ts';
    const { useWorkspaceStore: store } = await import(path);
    const win = store.getState().windows.find((w: WorkspaceWindow) => w.kind === 'chart');
    store.getState().applyWorkspaceSnapshot({ windows: [{ ...win, group: 1,
      rect: { x: 0, y: 0, w: 1, h: 1 }, chart: { ...win.chart, timeframe: '15m', regularSessionOnly: false } }],
      zOrder: [win.id], maximizedId: null });
    store.getState().setWindowSymbol(win.id, { code: '080220', name: '제주반도체', kind: 'stock' });
    return win.id as string;
  });
  const chartWindow = page.locator(`[data-win="${id}"]`);
  const displayedBars = () => page.evaluate(() => {
    const charts = [...(window as unknown as { __liveCharts?: Map<string, IChartApi> }).__liveCharts?.values() ?? []];
    if (charts.length !== 1) return [];
    const series = charts[0].panes().flatMap(pane => pane.getSeries())
      .find(series => series.seriesType() === 'Candlestick');
    return (series?.data() ?? []) as CandlestickData<Time>[];
  });
  const regularOnly = chartWindow.getByRole('button', { name: '정규장만 보기', exact: true });
  await expect(regularOnly).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(async () => (await displayedBars())[0]?.open).toBe(36400);
  expect(minuteVenues).toContain('UN');
  await expect.poll(() => liveVenues.includes('KRX')).toBe(true);
  // Historical UN 15:30 OHLC must survive today's effective KRX auction policy.
  expect((await displayedBars()).find(bar => bar.open === 36700)).toMatchObject({ high: 36900, low: 36600, close: 36850 });

  await ws.waitForSubscribe('080220');
  ws.pushLive('080220', { kind: 'trade', venue: 'KRX', t_ms: today + 60_000,
    trades: [{ price: 36500, qty: 10, side: 1 }] });
  await expect.poll(async () => (await displayedBars()).at(-1)?.close).toBe(36500);

  await regularOnly.click();
  await expect(regularOnly).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => (await displayedBars())[0]?.open).toBe(38350);
  await regularOnly.click();
  await expect.poll(async () => (await displayedBars())[0]?.open).toBe(36400);

  await selectVenue(page, 'KRX');
  await expect.poll(async () => (await displayedBars())[0]?.open).toBe(38350);
  await selectVenue(page, 'UN');
  await expect.poll(async () => (await displayedBars())[0]?.open).toBe(36400);
  await page.reload();
  await expect(page.getByTestId('live-venue-picker')).toContainText('통합');
  await expect(regularOnly).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(async () => (await displayedBars())[0]?.open).toBe(36400);
});
