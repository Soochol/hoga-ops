import { execFileSync } from 'node:child_process';
import { test, expect } from '@playwright/test';
import type { IChartApi } from 'lightweight-charts';
import type { WorkspaceWindow } from '../../src/state/workspace';
import { installLiveMocks } from './helpers/liveMocks';
import { installLiveWs } from './helpers/liveWs';
import { apiExact } from './helpers/apiRoutes';
import { API_URL, DATA_DIR, WORKTREE_ROOT } from './worktreeEnv';

test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: 'wait' }); });

for (const venue of ['KRX', 'NXT', 'UN'] as const) {
  test(`${venue} computes evening aggregates from Parquet and restores regular-only values across badge toggles`, async ({ page, request }) => {
    execFileSync('uv', ['run', 'python', '-c',
      'import runpy,sys; from pathlib import Path; runpy.run_path("tests/unit/api/test_range_indicator_sessions.py")["write_day"](Path(sys.argv[1]), sys.argv[2])',
      DATA_DIR, venue], { cwd: WORKTREE_ROOT });
    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.clock.setFixedTime(new Date('2026-09-15T20:10:00+09:00'));
    await page.addInitScript(venue => localStorage.setItem('live.venue.v1', JSON.stringify({ venue })), venue);
    await installLiveMocks(page);
    await installLiveWs(page);
    await page.route(apiExact('symbols/all'), r => r.fulfill({ json: {
      symbols: [{ code: '005930', name: '삼성전자', market: 'KOSPI', nxt_enabled: true }],
    } }));
    await page.route(apiExact('live/series'), r => r.fulfill({ json: {
      code: '005930', date: '20260915', is_open: false, snapshots: [], trades: [], brokers: [], programs: [],
      session_open_ms: Date.parse('2026-09-15T09:00:00+09:00'), session_close_ms: null,
    } }));
    const at = (clock: string) => Date.parse(`2026-09-14T${clock}:00+09:00`);
    const clocks = ['08:30', '10:00', '15:45', '16:00', '18:00', '19:59'];
    const prices = [70, 100, 100, 150, 160, 170];
    await page.route(apiExact('live/past-candles'), r => r.fulfill({ json: {
      code: '005930', venue, from: '20260914', to: '20260915', bucket_ms: 60000,
      candles: clocks.map((clock, i) => ({ t_ms: at(clock), open: prices[i], high: prices[i]+10,
        low: prices[i]-10, close: prices[i], volume: 100 })),
      cached_dates: ['20260914'], fresh_dates: [], data_warnings: [],
      effective_sessions: [{ date: '20260914', venue, open_ms: at(venue === 'KRX' ? '09:00' : '08:00'), close_ms: at('20:00') }],
    } }));
    // Keep UI dependencies deterministic, but run the actual range aggregation
    // against this worktree's isolated backend and real Parquet fixture.
    const scopes: boolean[] = [];
    await page.route(apiExact('range'), async r => {
      const url = new URL(r.request().url());
      scopes.push(url.searchParams.get('regular_session_only') === 'true');
      await r.continue({ url: `${API_URL}${url.pathname}${url.search}` });
    });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('/live?code=005930');
    await expect(page.getByTestId('chart-window-header').first()).toBeVisible();
    const id = await page.evaluate(async () => {
      const wsPath = '/src/state/workspace.ts', storePath = '/src/state/livePage.ts';
      const ctxPath = '/src/live/workspace/windowViewContext.ts', prefsPath = '/src/state/chartPrefs.ts';
      const { useWorkspaceStore: ws } = await import(wsPath);
      const { useLivePageStore: store } = await import(storePath);
      const { windowScopeKey } = await import(ctxPath);
      const { useChartPrefsStore: prefs } = await import(prefsPath);
      const win = ws.getState().windows.find((w: WorkspaceWindow) => w.kind === 'chart');
      ws.getState().applyWorkspaceSnapshot({ windows: [{ ...win, group: 1, rect: { x: 0, y: 0, w: 1, h: 1 },
        chart: { ...win.chart, timeframe: '1m', regularSessionOnly: false } }], zOrder: [win.id], maximizedId: null });
      store.getState().patchIndicatorsScoped({ windowKey: windowScopeKey(win.id) }, '1m', {
        askPeakEnabled: true, bidPeakEnabled: true, peakWallPaneEnabled: true,
        askPeakTradedPaneEnabled: true, bidPeakTradedPaneEnabled: true,
        tradeVolumePocEnabled: true, volumeDistributionEnabled: true, volumeDistributionRangeCount: 10,
      });
      for (const key of ['askPeakTradedAboveMaEnabled', 'bidPeakTradedBelowMaEnabled',
        'askPeakTradedAboveDailyMaEnabled', 'bidPeakTradedBelowDailyMaEnabled']) prefs.getState().setToggle(key, false);
      prefs.getState().setToggle('auctionWindowMask', true);
      return win.id as string;
    });
    const maximumWall = () => page.evaluate(id => {
      const chart = (window as unknown as { __liveCharts?: Map<string, IChartApi> }).__liveCharts?.get(id);
      const points = chart?.panes().flatMap(p => p.getSeries()).filter(s =>
        s.seriesType() === 'Line' && (s.options() as { lineType?: number }).lineType === 1)
        .flatMap(s => s.data()).flatMap(p => 'value' in p ? [p.value as number] : []);
      return Math.max(0, ...(points ?? []));
    }, id);
    const label = page.getByTestId('volume-distribution-poc-label').first();
    const params = new URLSearchParams({ code: '005930', from: '20260914', to: '20260914',
      venue, bucket_ms: '60000', mode: 'sidecar', volume_distribution_bins: '10', trade_volume_poc_bins: '10' });
    const expectedFull = await (await request.get(`${API_URL}/api/range?${params}`)).json();
    const profile = expectedFull.volume_distributions[0];
    const best = profile.bins.reduce((a: { qty: number }, b: { qty: number }) => b.qty > a.qty ? b : a);
    const fullPoc = Math.round((best.price_low + best.price_high) / 2).toLocaleString('ko-KR');
    const fullMaximum = venue === 'KRX' ? 300 : 9999;
    await expect.poll(maximumWall).toBe(fullMaximum);
    await expect(label).toHaveText(fullPoc);
    for (const regular of [true, false, true]) {
      await page.getByRole('button', { name: '정규장만 보기', exact: true }).click();
      await expect(page.getByRole('button', { name: '정규장만 보기', exact: true }))
        .toHaveAttribute('aria-pressed', String(regular));
      await page.keyboard.press('Escape');
      await expect.poll(maximumWall).toBe(regular ? 10 : fullMaximum);
      await expect(label).toHaveText(regular ? '101' : fullPoc);
      expect(scopes).toContain(regular);
    }
    await page.reload();
    await expect(page.getByRole('button', { name: '정규장만 보기', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(label).toHaveText('101');
    expect(errors.filter(error => !error.startsWith('ResizeObserver loop'))).toEqual([]);
  });
}
