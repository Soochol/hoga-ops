import { test, expect, type Page } from '@playwright/test';
import type { WorkspaceWindow } from '../../src/state/workspace';
import { installLiveMocks } from './helpers/liveMocks';
import { apiExact } from './helpers/apiRoutes';

async function selectVenue(page: Page, venue: 'KRX' | 'UN' | 'NXT') {
  await page.getByTestId('live-venue-picker').click();
  await page.getByTestId(`live-venue-option-${venue}`).click();
}

for (const timeframe of ['D', 'W', 'M'] as const) {
  test(`${timeframe}: historical venue survives current NXT ineligibility, switching and reload`, async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.clock.setFixedTime(new Date('2025-05-30T17:00:00+09:00'));
    await installLiveMocks(page);
    await page.routeWebSocket(/\/api\/ws/, () => {});
    await page.route(apiExact('symbols/all'), route => route.fulfill({ json: {
      symbols: [{ code: '098460', name: '고영', market: 'KOSDAQ', nxt_enabled: false }],
    } }));
    await page.route(apiExact('live/settings'), route => route.fulfill({ json: {
      rest_bypass_enabled: false, krx_prefer_hogaplay: false,
    } }));
    const dailyVenues: string[] = [];
    const liveVenues: string[] = [];
    await page.route(apiExact('live/series'), route => {
      const p = new URL(route.request().url()).searchParams;
      liveVenues.push(p.get('venue') ?? '');
      return route.fulfill({ json: { code: '098460', date: '20250530',
        snapshots: [], trades: [], brokers: [], is_open: false,
        session_open_ms: Date.parse('2025-05-30T09:00:00+09:00'), session_close_ms: null } });
    });
    // May 29 prices from the investigation: UN differs despite today's nxt_enabled=false.
    await page.route(apiExact('live/past-daily-candles'), route => {
      const p = new URL(route.request().url()).searchParams;
      const venue = p.get('venue') ?? '';
      dailyVenues.push(venue);
      const integrated = venue === 'UN';
      return route.fulfill({ json: { code: '098460', venue, from: p.get('from'), to: p.get('to'),
        candles: [{ t_ms: Date.parse('2025-05-29T09:00:00+09:00'),
          open: integrated ? 15450 : 15520, high: 15530, low: 15140,
          close: integrated ? 15230 : 15200, volume: integrated ? 1793352 : 1112611 }],
        cached_batches: [], fresh_batches: [], data_warnings: [] } });
    });
    await page.goto('/live?code=098460');
    await expect(page.locator('[data-win]').first()).toBeVisible();
    const id = await page.evaluate(async timeframe => {
      const path = '/src/state/workspace.ts';
      const { useWorkspaceStore: store } = await import(path);
      const win = store.getState().windows.find((w: WorkspaceWindow) => w.kind === 'chart');
      store.getState().applyWorkspaceSnapshot({ windows: [{ ...win, group: 1,
        rect: { x: 0, y: 0, w: 1, h: 1 }, chart: { ...win.chart, timeframe } }],
        zOrder: [win.id], maximizedId: null });
      store.getState().setWindowSymbol(win.id, { code: '098460', name: '고영', kind: 'stock' });
      return win.id as string;
    }, timeframe);
    const chart = page.locator(`[data-win="${id}"]`);
    await expect(chart).toContainText('15,200원');
    await selectVenue(page, 'UN');
    await expect.poll(() => dailyVenues.includes('UN')).toBe(true);
    await expect(chart).toContainText('15,230원');
    await expect(chart.locator('.legend-ohlc-open')).toContainText('15,450원');
    expect(new Set(liveVenues)).toEqual(new Set(['KRX']));
    await page.evaluate(() => history.replaceState(null, '', '/live'));
    await page.reload();
    await expect(page.getByTestId('live-venue-picker')).toContainText('통합');
    await expect(chart).toContainText('15,230원');
    await selectVenue(page, 'NXT');
    await expect.poll(() => dailyVenues.includes('NXT')).toBe(true);
    await expect(chart).toContainText('15,200원');
    await selectVenue(page, 'KRX');
    await expect(chart).toContainText('15,200원');
    await selectVenue(page, 'UN');
    await expect(chart).toContainText('15,230원');
    // Reload can briefly query UN while the symbol master is still unknown.
    expect(liveVenues).toContain('NXT');
  });
}
