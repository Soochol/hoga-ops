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
  test(`${venue} stored candles retain the evening across regular badge and timeframe changes without vendor filling`, async ({ page }) => {
    execFileSync('uv', ['run', 'python', '-c',
      'import runpy,sys; from pathlib import Path; runpy.run_path("tests/unit/api/test_range_indicator_sessions.py")["write_day"](Path(sys.argv[1]), sys.argv[2])',
      DATA_DIR, venue], { cwd: WORKTREE_ROOT });
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.clock.setFixedTime(new Date('2026-09-15T20:10:00+09:00'));
    await page.addInitScript(venue => localStorage.setItem('live.venue.v1', JSON.stringify({ venue })), venue);
    await installLiveMocks(page);
    const ws = await installLiveWs(page);
    await page.route(apiExact('symbols/all'), r => r.fulfill({ json: {
      symbols: [{ code: '005930', name: '삼성전자', market: 'KOSPI', nxt_enabled: true }],
    } }));
    await page.route(apiExact('live/series'), r => r.fulfill({ json: {
      code: '005930', date: '20260915', is_open: false, snapshots: [], trades: [], brokers: [], programs: [],
      session_open_ms: Date.parse('2026-09-15T09:00:00+09:00'), session_close_ms: null,
    } }));
    const vendorRequests: string[] = [];
    let diskOn = false;
    await page.route(apiExact('live/past-candles'), r => {
      if (diskOn) vendorRequests.push(r.request().url());
      const q = new URL(r.request().url()).searchParams;
      return r.fulfill({ json: { code: '005930', from: q.get('from'), to: q.get('to'), candles: [],
        cached_dates: [], fresh_dates: [], data_warnings: [], adjust_factors: {},
        effective_sessions: [{ date: '20260914', venue, open_ms: Date.parse('2026-09-14T09:00:00+09:00'),
          close_ms: Date.parse('2026-09-14T15:30:00+09:00') }],
      } });
    });
    const scopes: boolean[] = [];
    await page.route(apiExact('range'), async r => {
      const url = new URL(r.request().url());
      if (url.searchParams.get('mode') === 'candles') {
        diskOn = true;
        scopes.push(url.searchParams.get('regular_session_only') === 'true');
      }
      await r.continue({ url: `${API_URL}${url.pathname}${url.search}` });
    });
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto('/live?code=005930');
    await expect(page.getByTestId('chart-window-header').first()).toBeVisible();
    const id = await page.evaluate(async () => {
      const path = '/src/state/workspace.ts';
      const { useWorkspaceStore: store } = await import(path);
      const win = store.getState().windows.find((w: WorkspaceWindow) => w.kind === 'chart');
      store.getState().applyWorkspaceSnapshot({ windows: [{ ...win, group: 1,
        rect: { x: 0, y: 0, w: 1, h: 1 }, chart: { ...win.chart, timeframe: '1m', regularSessionOnly: false } }],
        zOrder: [win.id], maximizedId: null });
      return win.id as string;
    });
    await ws.waitForSubscribe('005930');
    await page.getByRole('button', { name: 'hogaplay 저장 데이터로 보기', exact: true }).click();
    await expect(page.getByTestId('live-hogaplay-source-chip')).toBeVisible();
    const connections = ws.connectionCount();
    const prices = () => page.evaluate(id => {
      const chart = (window as unknown as { __liveCharts?: Map<string, IChartApi> }).__liveCharts?.get(id);
      return chart?.panes().flatMap(p => p.getSeries()).find(s => s.seriesType() === 'Candlestick')
        ?.data().flatMap(p => 'close' in p ? [p.close] : []) ?? [];
    }, id);
    for (const tf of ['1m', '120m', '240m']) {
      await page.evaluate(async ({ id, tf }) => {
        const path = '/src/state/workspace.ts';
        const { useWorkspaceStore: store } = await import(path);
        store.getState().setChartTimeframe(id, tf);
      }, { id, tf });
      for (const regular of [false, true, false]) {
        const badge = page.getByRole('button', { name: '정규장만 보기', exact: true });
        if ((await badge.getAttribute('aria-pressed')) !== String(regular)) await badge.click();
        await expect(badge).toHaveAttribute('aria-pressed', String(regular));
        await page.keyboard.press('Escape');
        await expect.poll(prices).toContain(100);
        await expect.poll(async () => (await prices()).includes(170)).toBe(!regular);
        expect(ws.subscribed()).toContain('005930');
        expect(ws.connectionCount()).toBe(connections);
      }
    }
    expect(scopes).toContain(true);
    expect(scopes).toContain(false);
    expect(vendorRequests).toEqual([]);
    // The source switch is window runtime state; re-enable it after reload.
    diskOn = false;
    await page.reload();
    await expect(page.getByRole('button', { name: '정규장만 보기', exact: true })).toHaveAttribute('aria-pressed', 'false');
    await page.getByRole('button', { name: 'hogaplay 저장 데이터로 보기', exact: true }).click();
    await expect(page.getByTestId('live-hogaplay-source-chip')).toBeVisible();
    await expect.poll(async () => (await prices()).includes(170)).toBe(true);
    expect(errors.filter(e => !e.startsWith('ResizeObserver loop'))).toEqual([]);
  });
}
