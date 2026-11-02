import { test, expect } from '@playwright/test';
import { apiExact, apiPrefix } from './helpers/apiRoutes';
import { installLiveMocks } from './helpers/liveMocks';

test('manual query stays one-shot; only explicit monitoring reacts to WS events and stops', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-11-02T09:27:00+09:00') });
  await installLiveMocks(page);
  await page.route(apiPrefix('live/quotes'), route => route.fulfill({ json: { phase: 'open', quotes: [] } }));
  let socket: import('@playwright/test').WebSocketRoute | undefined;
  await page.routeWebSocket('**/api/ws', ws => { socket = ws; });
  const conditions = [['3m', 40], ['5m', 24], ['10m', 12]].map(([timeframe, period]) => ({
    id: String(timeframe), type: 'new_high_vol', params: { timeframe, period, lookback: 3, include_open_bar: true, volume_basis: 'raw' },
  }));
  const saved = { id: 'afternoon', name: '오후장 공략', calculation_policy: 'separate_bases_v2',
    conditions, expression: 'A OR B OR C', universe: { scopes: ['watchlist', 'heatmap'] }, created_at_ms: 1, updated_at_ms: 1 };
  let manual = 0, starts = 0, reads = 0, stops = 0;
  const result = (continuous = false) => ({ status: 'ok', rows: [], warnings: ['bar_volume_partial'],
    scanned_at_ms: Date.now(), bar_coverage: { total: 2, complete: 0, trading_date: '2026-11-02',
      incomplete: conditions.map(leaf => ({ code: '005930', condition_id: leaf.id,
        reason: continuous ? 'insufficient_minute_history' : 'insufficient_day_bars' })),
      ...(continuous ? { realtime: { prepared: 0, receiving: 0, preparing: 0, insufficient: 2, continuous: true } } : {}) } });
  await page.route(apiExact('screener/status'), route => route.fulfill({ json: { status: 'ok' } }));
  await page.route(apiExact('screener/saves'), route => route.fulfill({ json: { saves: [saved] } }));
  await page.route(apiPrefix('screener/runs'), route => {
    manual += 1;
    const request = route.request().postDataJSON();
    expect(request).not.toHaveProperty('mode');
    return route.fulfill({ json: { id: 'once', request, status: 'partial', minute_date: '2026-11-02',
      total: 2, evaluated: 0, preparing: 0, waiting: 2, failed: 0, next_retry_at_ms: null,
      errors: {}, revision: 1, result_revision: 1, result: result(), started_at_ms: Date.now(), updated_at_ms: Date.now() } });
  });
  await page.route(apiPrefix('screener/monitors'), route => {
    if (route.request().method() === 'DELETE') { stops += 1; return route.fulfill({ status: 204 }); }
    if (route.request().url().endsWith('/result')) { reads += 1; return route.fulfill({ json: result(true) }); }
    if (route.request().url().endsWith('/monitors')) starts += 1;
    return route.fulfill({ json: { id: 'explicit-monitor', total: 2, prepared: 0, receiving: 0,
      preparing: 0, recovering: 0, unavailable: 0, insufficient: 2, error: null } });
  });
  await page.goto('/screener');
  await page.getByRole('button', { name: '조회', exact: true }).click();
  await expect(page.getByText('당일 분봉이 더 쌓여야 평가할 수 있습니다', { exact: true })).toBeVisible();
  await expect(page.getByText('필요한 비교 자료: 3분봉 42개 · 5분봉 26개 · 10분봉 14개. 해당 거래일 하루의 자료만 사용합니다.')).toBeVisible();
  await expect.poll(() => !!socket).toBe(true);
  for (let i = 0; i < 30; i += 1) socket!.send(JSON.stringify({ ch: 'event', data: {
    type: 'screener_volume_changed', condition_ids: ['3m', '5m', '10m'] } }));
  await page.clock.runFor(31_000);
  expect({ manual, starts, reads }).toEqual({ manual: 1, starts: 0, reads: 0 });
  await page.getByRole('button', { name: '실시간 감시 시작', exact: true }).click();
  await expect.poll(() => reads).toBe(1);
  await expect(page.getByRole('button', { name: '실시간 감시 종료', exact: true })).toBeEnabled();
  await expect(page.getByText('실시간 감시 0/2종목 · 비교 봉 대기 2')).toBeVisible();
  for (let i = 0; i < 20; i += 1) socket!.send(JSON.stringify({ ch: 'event', data: {
    type: 'screener_volume_changed', monitor_id: 'explicit-monitor', condition_ids: ['3m'] } }));
  await page.clock.runFor(500);
  await expect.poll(() => reads).toBe(2);
  await page.getByRole('button', { name: '실시간 감시 종료', exact: true }).click();
  await expect.poll(() => stops).toBe(1);
  socket!.send(JSON.stringify({ ch: 'event', data: { type: 'screener_volume_changed', condition_ids: ['3m'] } }));
  await page.clock.runFor(31_000);
  expect({ starts, reads }).toEqual({ starts: 1, reads: 2 });
  await page.getByRole('button', { name: '조회', exact: true }).click();
  await expect.poll(() => manual).toBe(2);
});
