import { test, expect, type Page } from '@playwright/test';
import { installLiveMocks } from './helpers/liveMocks';
import { installLiveWs } from './helpers/liveWs';
import { apiPrefix } from './helpers/apiRoutes';

const CODE = '005930';
const NOW = Date.UTC(2026, 9, 22, 1);

async function setup(page: Page, initialFailure = false) {
  await page.clock.install({ time: NOW });
  await page.setViewportSize({ width: 1600, height: 1100 });
  await page.addInitScript(() => localStorage.setItem('live.venue.v1', JSON.stringify({ venue: 'KRX' })));
  await installLiveMocks(page);
  const ws = await installLiveWs(page);
  await page.route(apiPrefix('trading/v2/accounts'), route => route.fulfill({ status: 404, json: { detail: 'legacy fixture' } }));
  await page.route(apiPrefix('trading/accounts'), route => route.fulfill({ json: {
    configured: true, accounts: [{ account_seq: 1, label: '테스트 계좌' }],
  } }));
  await page.route(apiPrefix('trading/state'), route => route.fulfill({ json: {
    account_seq: 1, code: CODE, orders: [], recent_orders: [], unresolved_commands: [],
    fetched_at_ms: NOW, events_connected: true, buying_power: '20000000',
    sellable_quantity: '100', holding_quantity: '100', average_purchase_price: '66000',
  } }));
  let phase = 'waiting_slot';
  let failed = initialFailure;
  await page.route(apiPrefix('symbols/all'), route => route.fulfill({ json: {
    symbols: [{ code: CODE, name: '삼성전자', market: 'KOSPI', nxt_enabled: true }], status: 'fresh',
  } }));
  await page.route(apiPrefix('live/series'), route => {
    if (failed) return route.fulfill({ status: 503, json: { detail: 'fixture unavailable' } });
    const url = new URL(route.request().url());
    return route.fulfill({ json: { code: url.searchParams.get('code'), date: url.searchParams.get('date'),
      session_open_ms: NOW - 3_600_000, session_close_ms: null, is_open: true,
      snapshots: [], trades: [], brokers: [], programs: [], after_hours: [], expected: [],
      ask_peak_today: null, bid_peak_today: null } });
  });
  await page.route(apiPrefix('live/status'), async route => {
    const observed = await page.evaluate(() => Date.now());
    return route.fulfill({ json: {
      running: true, started_at_ms: NOW, last_tick_ms: null, cycle_lag_ms: 0,
      capture_healthy: true, capture_reason: 'healthy', watchlist_count: 0, live_set: [], rest_bypass_enabled: false,
      kiwoom: { enabled: true, accounts_configured: 1, connected_accounts: 1, subscribed_count: 0,
        accounts: [], last_tick_ms: null, connection_allowed: true, observed_at_ms: observed,
        ready_registrations: phase === 'registered' ? [CODE] : [],
        view_subscriptions: [{ code: CODE, venue: 'KRX', phase, connection_generation: 1 }],
        data_received_ms: {}, on_demand_count: 1, on_demand_capacity: 1 },
    } });
  });
  await page.goto(`/live?code=${CODE}`);
  await ws.waitForSubscribe(CODE);
  await page.getByTestId('workspace-add-menu-button').click();
  await page.getByTestId('workspace-add-order').click();
  await expect(page.getByTestId('order-window')).toBeVisible();
  return { ws, setPhase: (value: string) => { phase = value; }, recoverQuery: () => { failed = false; } };
}

test('both books recover from slot wait through vendor registration and the first book', async ({ page }, testInfo) => {
  const fixture = await setup(page);
  const states = page.getByTestId('book-availability');
  await expect(states).toHaveCount(2);
  await expect(states.nth(0)).toHaveAttribute('data-state', 'waiting_slot');
  await expect(states.nth(1)).toHaveAttribute('data-state', 'waiting_slot');
  await page.screenshot({ path: testInfo.outputPath('slot-wait.png') });
  await page.getByRole('button', { name: '구독 현황', exact: true }).first().click();
  const dialog = page.getByRole('dialog', { name: '서비스 상태' });
  await expect(dialog).toContainText('열람 구독 1/1등록');
  await expect(dialog).toContainText('005930 · KRX 연결 대기');
  await dialog.getByRole('button', { name: '서비스 상태 닫기', exact: true }).click();
  fixture.setPhase('registering');
  await page.clock.runFor(5_100);
  await expect(states.nth(0)).toHaveAttribute('data-state', 'registering');
  fixture.setPhase('registered');
  await page.clock.runFor(5_100);
  fixture.ws.pushLive(CODE, { kind: 'trade', venue: 'KRX', t_ms: NOW + 10_200,
    trades: [{ price: 67200, qty: 10, side: 1 }] });
  await expect(states.nth(0)).toContainText('첫 호가 수신 대기 중');
  await expect(states.nth(1)).toContainText('첫 호가 수신 대기 중');
  const bookTime = await page.evaluate(() => Date.now());
  fixture.ws.pushLive(CODE, { kind: 'ob', venue: 'KRX', t_ms: bookTime,
    asks: [{ price: 67300, qty: 100 }], bids: [{ price: 67200, qty: 200 }],
    total_ask_qty: 100, total_bid_qty: 200 });
  await expect(states).toHaveCount(0);
  const buy = page.getByTestId('order-window').getByRole('button', { name: /매수 67,200원 주문 추가/ });
  await expect(buy).toHaveAttribute('aria-disabled', 'false');
  await page.clock.runFor(31_000);
  await expect(states).toHaveCount(2);
  await expect(states.nth(0)).toContainText('마지막 호가');
  await expect(states.nth(1)).toContainText('마지막 호가');
  await expect(buy).toHaveAttribute('aria-disabled', 'true');
  expect(fixture.ws.connectionCount()).toBe(1);
});

test('an initial book query failure can be retried from either book', async ({ page }) => {
  const fixture = await setup(page, true);
  fixture.setPhase('registered');
  await page.clock.runFor(12_000);
  const states = page.getByTestId('book-availability');
  await expect(states.nth(0)).toHaveAttribute('data-state', 'query_error');
  await expect(states.nth(1)).toHaveAttribute('data-state', 'query_error');
  fixture.recoverQuery();
  await page.getByRole('button', { name: '다시 조회', exact: true }).first().click();
  await expect(states.nth(0)).toHaveAttribute('data-state', 'awaiting_book');
  await expect(states.nth(1)).toHaveAttribute('data-state', 'awaiting_book');
});
