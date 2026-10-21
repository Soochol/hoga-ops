import { test, expect } from '@playwright/test';
import type { ScanRequest, VolumeParams } from '../../src/api/screener';
import { apiExact, apiPrefix } from './helpers/apiRoutes';
import { installLiveMocks } from './helpers/liveMocks';


test('volume timeframe, candle counts and open-bar policy survive save/reload and scan', async ({ page }, testInfo) => {
  await installLiveMocks(page);
  let saved = { id: 'bar-volume', name: '봉수 거래량', universe: {}, created_at_ms: 1, updated_at_ms: 1,
    conditions: [{ id: 'volume', type: 'new_high_vol' as const, params: { lookback: 60, period: 250, include_open_bar: false } as VolumeParams }] };
  const scans: ScanRequest[] = [];
  await page.route(apiExact('screener/status'), route => route.fulfill({ json: { status: 'ok', warnings: [] } }));
  await page.route(apiExact('screener/saves'), route => route.fulfill({ json: { saves: [saved] } }));
  await page.route(apiExact('screener/saves/bar-volume'), route => {
    saved = { ...saved, ...route.request().postDataJSON(), updated_at_ms: saved.updated_at_ms + 1 };
    return route.fulfill({ json: saved });
  });
  await page.route(apiExact('screener/scan'), route => {
    const request: ScanRequest = route.request().postDataJSON();
    scans.push(request);
    return route.fulfill({ json: { status: 'ok', warnings: ['bar_volume_partial'],
      bar_coverage: { total: 2, complete: 1,
        incomplete: [{ code: '000660', condition_id: 'volume', reason: 'missing_history' }] },
      rows: [{ code: '005930', name: '삼성전자', market: 'KOSPI', price: 70000,
        trade_value_won: 1e8, change_pct: 0, occurrences: [{ condition_id: 'volume', condition_key: 'bars',
          date: '2026-07-30', bar_start_ms: 1785373800000,
          bar_match: { timeframe: '5m', volume: 300, maximum: 300, window_start_ms: 1785373500000,
            is_open: false, fetched_at_ms: 1785374100000 } }] }] } });
  });
  // The read-only drawer must also migrate the old saved policy before a scan.
  await page.goto('/heatmap');
  await page.getByRole('button', { name: '스크리너 패널 토글' }).click();
  const panel = page.getByTestId('screener-panel');
  await panel.getByRole('button', { name: '실시간 감시 시작' }).click();
  await expect.poll(() => scans.at(-1)?.conditions[0].params).toMatchObject({ include_open_bar: true });
  await panel.getByRole('button', { name: '종료', exact: true }).click();
  await page.getByRole('button', { name: '스크리너 패널 토글' }).click();
  await page.goto('/screener');
  await expect(page.getByRole('combobox', { name: '거래량 주기', exact: true })).toHaveValue('D');
  await page.getByRole('combobox', { name: '거래량 주기', exact: true }).selectOption('5m');
  await page.getByLabel('최근 기간(봉)').fill('3');
  await page.getByLabel('신고 기준 기간(봉)').fill('2');
  await expect(page.getByLabel('진행 중 봉 포함')).toHaveCount(0);
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await expect.poll(() => saved.conditions[0].params).toMatchObject({ timeframe: '5m', lookback: 3, period: 2, include_open_bar: true });
  await expect(page.getByRole('button', { name: '저장본으로 되돌리기', exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('combobox', { name: '거래량 주기', exact: true })).toHaveValue('5m');
  await expect(page.getByLabel('최근 기간(봉)')).toHaveValue('3');
  await expect(page.getByLabel('신고 기준 기간(봉)')).toHaveValue('2');
  await expect(page.getByLabel('진행 중 봉 포함')).toHaveCount(0);
  await page.getByRole('button', { name: '조회', exact: true }).click();
  await expect(page.getByText('봉 이력 충분 1/2종목')).toBeVisible();
  expect(scans.at(-1)?.conditions[0].params).toMatchObject({ timeframe: '5m', lookback: 3, period: 2, include_open_bar: true });
  await page.screenshot({ path: testInfo.outputPath('bar-volume-wide.png'), fullPage: true });
  for (const timeframe of ['W', 'M', 'D']) {
    await page.getByRole('combobox', { name: '거래량 주기', exact: true }).selectOption(timeframe);
    await expect(page.getByLabel('최근 기간(봉)')).toHaveValue('3');
    await page.getByRole('button', { name: '조회', exact: true }).click();
    await expect.poll(() => scans.at(-1)?.conditions[0].params).toMatchObject({ timeframe, lookback: 3, period: 2 });
  }
  await page.setViewportSize({ width: 768, height: 850 });
  await page.screenshot({ path: testInfo.outputPath('bar-volume-narrow.png'), fullPage: true });
});


test('open-minute crossing refreshes the page and monitoring drawer before the polling interval', async ({ page }, testInfo) => {
  await installLiveMocks(page);
  await page.route(apiPrefix('live/quotes'), route => route.fulfill({ json: { phase: 'open', quotes: [] } }));
  let socket: import('@playwright/test').WebSocketRoute | undefined;
  await page.routeWebSocket('**/api/ws', ws => { socket = ws; });
  const saved = { id: 'live-volume', name: '1분봉 거래량 감시', universe: { scopes: ['watchlist', 'heatmap'] }, created_at_ms: 1, updated_at_ms: 1,
    conditions: [{ id: 'volume', type: 'new_high_vol' as const,
      params: { timeframe: '1m', lookback: 5, period: 100, include_open_bar: true } }] };
  let crossed = false;
  let scans = 0;
  await page.route(apiExact('screener/status'), route => route.fulfill({ json: { status: 'ok', warnings: [] } }));
  await page.route(apiExact('screener/saves'), route => route.fulfill({ json: { saves: [saved] } }));
  await page.route(apiPrefix('screener/(monitors|scan)'), route => {
    if (!route.request().url().endsWith('/result') && !route.request().url().endsWith('/scan')) {
      return route.fulfill({ json: { id: 'continuous-test', total: 100, prepared: 64, receiving: 12,
        preparing: 36, recovering: 0, unavailable: 52, last_verified_ms: Date.now(), error: null } });
    }
    scans += 1;
    return route.fulfill({ json: { status: 'ok', warnings: [], scanned_at_ms: Date.now(),
      bar_coverage: { total: 100, complete: 64, incomplete: [], realtime: { prepared: 64, receiving: 12, continuous: true, preparing: 36, unavailable: 52 } },
      rows: crossed ? [{ code: '005930', name: '삼성전자', market: 'KOSPI', price: 70000,
        trade_value_won: 1e8, change_pct: 0, occurrences: [{ condition_id: 'volume', condition_key: 'live',
          date: '2026-10-20', bar_start_ms: 1792458120000,
          bar_match: { timeframe: '1m', volume: 1200, maximum: 1200, window_start_ms: 1792452180000,
            is_open: true, volume_is_lower_bound: true, fetched_at_ms: Date.now() } }] }] : [] } });
  });
  await page.goto('/screener');
  await expect(page.getByLabel('최근 기간(봉)')).toHaveValue('5');
  await page.getByRole('button', { name: '조회', exact: true }).click();
  await expect(page.getByText('실시간 감시 12/100종목 · 준비 중 36 · 연결 확인 필요 52')).toBeVisible();
  await expect.poll(() => !!socket).toBe(true);
  const initialScans = scans;
  crossed = true;
  for (let i = 0; i < 20; i += 1) socket!.send(JSON.stringify({ ch: 'event',
    data: { type: 'screener_volume_changed', condition_ids: ['volume'] } }));
  await expect(page.getByText('삼성전자', { exact: true })).toBeVisible({ timeout: 5000 });
  expect(scans).toBe(initialScans + 1);
  await page.screenshot({ path: testInfo.outputPath('live-volume-page.png'), fullPage: true });
  await page.setViewportSize({ width: 768, height: 850 });
  await expect(page.getByText('실시간 감시 12/100종목 · 준비 중 36 · 연결 확인 필요 52')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('live-volume-page-narrow.png'), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 850 });
  await page.goto('/heatmap');
  crossed = false;
  await page.getByRole('button', { name: '스크리너 패널 토글' }).click();
  const panel = page.getByTestId('screener-panel');
  await panel.getByRole('button', { name: '실시간 감시 시작' }).click();
  await panel.getByText('적용 조건 1개 · 모두 충족', { exact: true }).click();
  await expect(panel.getByText('1분봉 · 최근 5봉 이내 · 100봉 신고거래량')).toBeVisible();
  await expect(panel.getByText('실시간 감시 12/100종목 · 준비 중 36 · 연결 확인 필요 52')).toBeVisible();
  await expect(panel.getByText('삼성전자', { exact: true })).toHaveCount(0);
  crossed = true;
  socket!.send(JSON.stringify({ ch: 'event', data: { type: 'screener_volume_changed', condition_ids: ['volume'] } }));
  await expect(panel.getByText('삼성전자', { exact: true })).toBeVisible({ timeout: 5000 });
  await panel.getByRole('button', { name: '종료', exact: true }).click();
  await expect(panel.getByText('실시간 감시 12/100종목 · 준비 중 36 · 연결 확인 필요 52')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('live-volume-drawer.png'), fullPage: true });
});
