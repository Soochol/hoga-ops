import { test, expect } from '@playwright/test';
import type { IChartApi, LineData, Time } from 'lightweight-charts';
import type { WorkspaceWindow } from '../../src/state/workspace';
import { installLiveMocks } from './helpers/liveMocks';
import { installLiveWs } from './helpers/liveWs';
import { apiExact } from './helpers/apiRoutes';

for (const venue of ['KRX', 'NXT', 'UN'] as const) {
  test(`${venue} shows saved evening totals through 19:59 with auction masking on`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.clock.setFixedTime(new Date('2026-10-16T20:10:00+09:00'));
    await page.addInitScript(venue => localStorage.setItem('live.venue.v1', JSON.stringify({ venue })), venue);
    await installLiveMocks(page);
    await installLiveWs(page);
    await page.route(apiExact('symbols/all'), r => r.fulfill({ json: {
      symbols: [{ code: '098460', name: '고영', market: 'KOSDAQ', nxt_enabled: true }],
    } }));
    await page.route(apiExact('live/settings'), r => r.fulfill({ json: {
      rest_bypass_enabled: false, krx_prefer_hogaplay: true,
    } }));
    const at = (clock: string) => Date.parse(`2026-10-15T${clock}:00+09:00`);
    const opening = at(venue === 'KRX' ? '09:00' : '08:00');
    const times = ['15:00', '16:00', '19:55', '19:59'].map(at);
    await page.route(apiExact('live/series'), r => r.fulfill({ json: {
      code: '098460', date: '20261016', is_open: false, snapshots: [], trades: [], brokers: [],
      session_open_ms: Date.parse('2026-10-16T09:00:00+09:00'), session_close_ms: null,
    } }));
    await page.route(apiExact('live/past-candles'), r => r.fulfill({ json: {
      code: '098460', venue, from: '20261015', to: '20261016', bucket_ms: 60000,
      candles: times.map(t_ms => ({ t_ms, open: 35000, high: 35100, low: 34900, close: 35050, volume: 100 })),
      cached_dates: ['20261015'], fresh_dates: [], data_warnings: [],
      effective_sessions: [{ date: '20261015', venue, open_ms: opening, close_ms: at('20:00') }],
    } }));
    await page.route(apiExact('range'), r => r.fulfill({ json: {
      code: '098460', from_date: '20261015', to_date: '20261015', bucket_ms: 60000,
      segments: [{ date: '20261015', venue, session_open_ms: opening, session_close_ms: at('20:00'),
        source: venue === 'KRX' ? 'hogaplay' : 'kiwoom_live' }], candles: [],
      quote_ratio: { bucket_ms: 60000, points: times.map((t, i) => ({ t, bid_total: 300 + i * 100,
        ask_total: 200 + i * 100, bid_max: 300 + i * 100, ask_max: 200 + i * 100,
        imb_max_bid: 300 + i * 100, imb_max_ask: 200 + i * 100, band_pct: 1, tick: 50 })) },
      fill_strength: { bucket_ms: 60000, points: [] },
      volume_profile_range: { bin_count: 0, price_min: 0, price_max: 0, bin_width: 0, bins: [] },
      volume_profile_by_day: [], excluded_dates: [], data_warnings: [],
    } }));
    await page.goto('/live?code=098460');
    await expect(page.getByTestId('chart-window-header').first()).toBeVisible();
    const id = await page.evaluate(async () => {
      const wsPath = '/src/state/workspace.ts', storePath = '/src/state/livePage.ts';
      const scopePath = '/src/live/workspace/windowViewContext.ts', prefsPath = '/src/state/chartPrefs.ts';
      const { useWorkspaceStore: ws } = await import(wsPath);
      const { useLivePageStore: store } = await import(storePath);
      const { windowScopeKey } = await import(scopePath);
      const { useChartPrefsStore: prefs } = await import(prefsPath);
      const win = ws.getState().windows.find((w: WorkspaceWindow) => w.kind === 'chart');
      ws.getState().applyWorkspaceSnapshot({ windows: [{ ...win, group: 1, rect: { x: 0, y: 0, w: 1, h: 1 },
        chart: { ...win.chart, timeframe: '1m', regularSessionOnly: false } }], zOrder: [win.id], maximizedId: null });
      store.getState().patchIndicatorsScoped({ windowKey: windowScopeKey(win.id) }, '1m', { quoteTotalsEnabled: true });
      prefs.getState().setToggle('auctionWindowMask', true);
      return win.id as string;
    });
    await expect.poll(() => page.evaluate(id => {
      const chart = (window as unknown as { __liveCharts?: Map<string, IChartApi> }).__liveCharts?.get(id);
      const quotes = chart?.panes().map(p => p.getSeries())
        .find(series => series.length === 2 && series.every(s => s.seriesType() === 'Line'));
      return quotes?.map(s => (s.data() as LineData<Time>[]).filter(p => p.value > 0).at(-1)?.value);
    }, id)).toEqual([600, 500]);
  });
}
