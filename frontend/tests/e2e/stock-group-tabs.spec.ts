import { expect, test } from '@playwright/test';
import type { HeatmapEntry } from '../../src/api/heatmap';
import { installLiveMocks } from './helpers/liveMocks';
import { apiExact, apiPrefix } from './helpers/apiRoutes';

for (const source of [
  { label: '관심종목', panel: 'watchlist-panel', row: 'watchlist-row-005930' },
  { label: '스크리너', panel: 'screener-panel', row: 'screener-row-005930' },
  { label: '순위', panel: 'ranking-panel', row: 'ranking-row-005930' },
]) {
  test(`${source.label} 우클릭에서 두 목록을 독립 등록하고 실행 취소한다`, async ({ page }, info) => {
    await page.setViewportSize({ width: 1440, height: 960 });
    await installLiveMocks(page);
    await page.routeWebSocket(/\/api\/ws/, () => {});
    let heatmapEntries: HeatmapEntry[] = [];
    const heatmapWrites: string[] = [];
    let watchlistWrites = 0;
    await page.route(apiExact('watchlist'), route => route.fulfill({ json: {
      folders: [{ id: 'f_watch', name: '매매후보', order: 0 }],
      entries: [{ code: '005930', name: '삼성전자', folder_id: 'f_watch', order: 0,
        registered_at_kst_date: '20261101', last_success_date: null }], memos: [], next_run_at_ms: 0,
    } }));
    await page.route(apiPrefix('watchlist/folders/'), route => {
      if (route.request().method() !== 'GET') watchlistWrites++;
      return route.fallback();
    });
    await page.route(apiExact('heatmap'), route => route.fulfill({ json: {
      folders: [{ id: 'f_heat', name: '반도체', order: 0 }], entries: heatmapEntries, capture_markers: {}, next_run_at_ms: 0,
    } }));
    await page.route(apiPrefix('heatmap/folders/f_heat/members'), route => {
      const method = route.request().method();
      heatmapWrites.push(method);
      if (method === 'POST') {
        const entry = { code: route.request().postDataJSON().code as string, name: '삼성전자', folder_id: 'f_heat', order: 0 };
        heatmapEntries = [entry];
        return route.fulfill({ json: entry });
      }
      heatmapEntries = [];
      return route.fulfill({ status: 204 });
    });
    await page.route(apiExact('live/rankings'), route => route.fulfill({ json: {
      kind: 'change', market: 'all', direction: 'up', venue: 'KRX', market_open: true,
      fetched_at_ms: Date.now(), queried_count: 1, has_more: false,
      rows: [{ rank: 1, code: '005930', name: '삼성전자', price: 72400, change_pct: 2.26 }],
    } }));
    await page.route(apiExact('screener/saves'), route => route.fulfill({ json: {
      schema_version: 1, saves: [{ id: 's_a', name: '등록 테스트', conditions: [{ id: 'c1', type: 'trade_value', params: { min_eok: 100 } }],
        universe: {}, created_at_ms: 0, updated_at_ms: 0 }],
    } }));
    await page.addInitScript(() => {
      localStorage.setItem('screenerPanel.v1', JSON.stringify({
        selectedSavedId: 's_a', sortMode: 'default', monitoringActive: false, monitorPeriodMs: null,
        lastScan: { savedId: 's_a', savedName: '등록 테스트', savedUpdatedAtMs: 0, scanKey: null,
          rows: [{ code: '005930', name: '삼성전자', market: 'KOSPI', price: 72400, change_pct: 2.26, trade_value_won: 1e11 }],
          scanStatus: 'ok', warnings: [], depthValues: null, scannedAtMs: Date.now(), basis: 'intraday', dataStale: false },
      }));
    });
    await page.goto('/live?code=098460');
    const panel = page.getByTestId(source.panel);
    if (!await panel.isVisible()) await page.getByRole('button', { name: `${source.label} 패널 토글`, exact: true }).click();
    await panel.getByTestId(source.row).click({ button: 'right' });
    const menu = page.getByRole('menu', { name: '삼성전자 관심 그룹' });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('tab', { name: '관심종목' })).toHaveAttribute('aria-selected', 'true');
    await expect(menu.getByRole('menuitemcheckbox', { name: '매매후보' })).toBeChecked();
    const heatTab = menu.getByRole('tab', { name: '히트맵' });
    await heatTab.click();
    await expect(menu.getByTestId('quote-menu-remove-all')).toHaveCount(0);
    await menu.getByRole('menuitemcheckbox', { name: '반도체' }).click();
    await expect(menu.getByRole('menuitemcheckbox', { name: '반도체' })).toBeChecked();
    await expect(heatTab).toContainText('1');
    await menu.getByRole('tab', { name: '관심종목' }).click();
    await expect(menu.getByRole('menuitemcheckbox', { name: '매매후보' })).toBeChecked();
    await heatTab.click();
    await menu.getByRole('button', { name: '실행 취소', exact: true }).click();
    await expect(menu.getByRole('menuitemcheckbox', { name: '반도체' })).not.toBeChecked();
    expect(heatmapWrites).toEqual(['POST', 'DELETE']);
    expect(watchlistWrites).toBe(0);
    await menu.screenshot({ path: info.outputPath('stock-group-tabs.png') });
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await expect(panel).toBeVisible();
  });
}
