import { test, expect, type Page } from '@playwright/test';
import { installLiveMocks } from './helpers/liveMocks';
import { installLiveWs } from './helpers/liveWs';
import { apiPrefix } from './helpers/apiRoutes';
import type { AftermarketExclusionReason } from '../../src/api/aftermarketExclusion';

const CODE = '005930';
const NOW = Date.UTC(2026, 9, 22, 1);

async function setup(page: Page, options: { initialFailure?: boolean; nowMs?: number; bookMs?: number; code?: string;
  exclusionReasons?: AftermarketExclusionReason[] } = {}) {
  const nowMs = options.nowMs ?? NOW;
  const code = options.code ?? CODE;
  await page.clock.install({ time: nowMs });
  await page.setViewportSize({ width: 1600, height: 1100 });
  await page.addInitScript(() => localStorage.setItem('live.venue.v1', JSON.stringify({ venue: 'KRX' })));
  await installLiveMocks(page);
  const ws = await installLiveWs(page);
  await page.route(apiPrefix('trading/v2/accounts'), route => route.fulfill({ status: 404, json: { detail: 'legacy fixture' } }));
  await page.route(apiPrefix('trading/accounts'), route => route.fulfill({ json: {
    configured: true, accounts: [{ account_seq: 1, label: '테스트 계좌' }],
  } }));
  await page.route(apiPrefix('trading/state'), route => route.fulfill({ json: {
    account_seq: 1, code, orders: [], recent_orders: [], unresolved_commands: [],
    fetched_at_ms: nowMs, events_connected: true, buying_power: '20000000',
    sellable_quantity: '100', holding_quantity: '100', average_purchase_price: '66000',
  } }));
  let phase = 'waiting_slot';
  let failed = options.initialFailure ?? false;
  let replyBookMs = options.bookMs;
  let serverReceivedMs: number | undefined;
  let seriesRequests = 0;
  let heldSeries: Promise<void> | undefined;
  const product = code === '069500' ? 'etf' : code === '500001' ? 'etn' : 'stock';
  const reasons: AftermarketExclusionReason[] = options.exclusionReasons ?? (product === 'stock' ? [] : [product]);
  await page.route(apiPrefix('symbols/all'), route => route.fulfill({ json: {
    symbols: [{ code, name: code === '222800' ? '심텍' : code === '079650' ? '서산' : product === 'etf' ? 'KODEX 200' : product === 'etn' ? '테스트 ETN' : '삼성전자',
      market: ['079650', '222800'].includes(code) ? 'KOSDAQ' : 'KOSPI', security_type: product,
      nxt_enabled: code !== '079650' && product === 'stock' }], status: 'fresh',
  } }));
  await page.route(apiPrefix('live/aftermarket-exclusion'), async route => route.fulfill({ json: {
    code, date: '20261022', status: 'checked', reasons,
    checked_at_ms: await page.evaluate(() => Date.now()),
    source: product === 'stock' ? 'kiwoom_ka10100' : 'symbol_master',
  } }));
  await page.route(apiPrefix('live/series'), async route => {
    seriesRequests++;
    if (heldSeries) await heldSeries;
    if (failed) return route.fulfill({ status: 503, json: { detail: 'fixture unavailable' } });
    const url = new URL(route.request().url());
    return route.fulfill({ json: { code: url.searchParams.get('code'), date: url.searchParams.get('date'),
      session_open_ms: NOW - 3_600_000, session_close_ms: null, is_open: true,
      last_ob: replyBookMs === undefined ? null : { kind: 'ob', code, venue: 'KRX',
        t_ms: replyBookMs, phase: 'after_hours_closing',
        asks: [{ price: 67300, qty: 100 }], bids: [{ price: 67200, qty: 200 }],
        total_ask_qty: 100, total_bid_qty: 200 },
      snapshots: [], trades: [], brokers: [], programs: [], after_hours: [], expected: [],
      ask_peak_today: null, bid_peak_today: null } });
  });
  await page.route(apiPrefix('live/status'), async route => {
    const observed = await page.evaluate(() => Date.now());
    return route.fulfill({ json: {
      running: true, started_at_ms: nowMs, last_tick_ms: null, cycle_lag_ms: 0,
      capture_healthy: true, capture_reason: 'healthy', watchlist_count: 0, live_set: [], rest_bypass_enabled: false,
      kiwoom: { enabled: true, accounts_configured: 1, connected_accounts: 1, subscribed_count: 0,
        accounts: [], last_tick_ms: null, connection_allowed: true, observed_at_ms: observed,
        ready_registrations: phase === 'registered' ? [code] : [],
        view_subscriptions: [{ code, venue: 'KRX', phase, connection_generation: 1 }],
        data_received_ms: serverReceivedMs === undefined ? {} : { [`${code}:KRX:ob`]: serverReceivedMs }, on_demand_count: 1, on_demand_capacity: 1 },
    } });
  });
  await page.goto(`/live?code=${code}`);
  await ws.waitForSubscribe(code);
  await page.getByTestId('workspace-add-menu-button').click();
  await page.getByTestId('workspace-add-order').click();
  await expect(page.getByTestId('order-window')).toBeVisible();
  return { ws, setPhase: (value: string) => { phase = value; }, recoverQuery: () => { failed = false; },
    setServerBook: (time: number) => { replyBookMs = time; serverReceivedMs = time; },
    seriesRequests: () => seriesRequests,
    holdSeries: () => { let release!: () => void; heldSeries = new Promise<void>(resolve => { release = resolve; });
      return () => { heldSeries = undefined; release(); }; },
  };
}

test('stale WS books converge to a newer REST book with one shared recovery and scoped diagnostics', async ({ page }, testInfo) => {
  const code = '222800';
  const start = Date.parse('2026-10-22T16:56:47+09:00');
  const fixture = await setup(page, { code, nowMs: start });
  fixture.setPhase('registered');
  fixture.ws.pushLive(code, { kind: 'ob', venue: 'KRX', t_ms: start,
    asks: [{ price: 67300, qty: 100 }], bids: [{ price: 67200, qty: 200 }], total_ask_qty: 100, total_bid_qty: 200 });
  await expect(page.getByTestId('book-availability')).toHaveCount(0);
  await page.clock.runFor(31_000);
  const before = fixture.seriesRequests();
  const release = fixture.holdSeries();
  const fresh = await page.evaluate(() => Date.now());
  // Other traffic keeps the app socket alive but is never orderbook evidence.
  fixture.ws.pushLive(code, { kind: 'trade', venue: 'KRX', t_ms: fresh, trades: [{ price: 67200, qty: 1, side: 1 }] });
  fixture.setServerBook(fresh);
  await page.clock.runFor(5_100);
  const states = page.getByTestId('book-availability');
  await expect(states).toHaveCount(2);
  await expect(states.nth(0)).toHaveAttribute('data-state', 'display_delayed');
  await expect(states.nth(1)).toHaveAttribute('data-state', 'display_delayed');
  await states.nth(0).getByRole('button', { name: '연결 상태', exact: true }).click();
  const diagnostics = page.getByTestId('book-diagnostics');
  await expect(diagnostics).toContainText('222800 · KRX');
  await expect(diagnostics).toContainText('표시 호가 시각 · 16:56:47');
  const freshClock = new Date(fresh).toLocaleTimeString('en-GB', { timeZone: 'Asia/Seoul' });
  await expect(diagnostics).toContainText(`서버 호가 수신 · ${freshClock}`);
  await expect(page.getByRole('button', { name: '현재 문제 0', exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('book-display-diagnosis.png') });
  expect(fixture.seriesRequests() - before).toBe(1);
  release();
  await expect(states).toHaveCount(0);
  const buy = page.getByTestId('order-window').getByRole('button', { name: /매수 67,200원 주문 추가/ });
  await expect(buy).toHaveAttribute('aria-disabled', 'false');
  expect(fixture.ws.connectionCount()).toBe(1);
  await page.getByRole('button', { name: '서비스 상태 닫기', exact: true }).click();
  await page.screenshot({ path: testInfo.outputPath('book-rest-recovered.png') });
});

test('recent browser book receipts with an old event time remain distinct from a display delivery gap', async ({ page }) => {
  const code = '222800';
  const now = Date.parse('2026-10-22T16:57:20+09:00');
  const fixture = await setup(page, { code, nowMs: now });
  fixture.setPhase('registered');
  await page.clock.runFor(5_100);
  const before = fixture.seriesRequests();
  fixture.ws.pushLive(code, { kind: 'ob', venue: 'KRX', t_ms: now - 60_000,
    asks: [{ price: 67300, qty: 100 }], bids: [{ price: 67200, qty: 200 }],
    total_ask_qty: 100, total_bid_qty: 200 });
  const states = page.getByTestId('book-availability');
  await expect(states).toHaveCount(2);
  await expect(states.nth(0)).toHaveAttribute('data-state', 'timestamp_old');
  await expect(states.nth(1)).toHaveAttribute('data-state', 'timestamp_old');
  await expect(states.nth(0)).toContainText('호가는 수신 중');
  await expect(page.getByTestId('order-window').getByRole('button', { name: /매수 67,200원 주문 추가/ }))
    .toHaveAttribute('aria-disabled', 'true');
  await page.clock.runFor(5_100);
  expect(fixture.seriesRequests()).toBe(before);
});

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
  const fixture = await setup(page, { initialFailure: true });
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

test('both books retain the 15:30:02 closing residual without a false live delay and accept new evening data', async ({ page }) => {
  const code = '079650';
  const fixture = await setup(page, { code, nowMs: Date.parse('2026-10-22T19:30:00+09:00'),
    bookMs: Date.parse('2026-10-22T15:30:02+09:00') });
  fixture.setPhase('registered');
  const states = page.getByTestId('book-availability');
  await expect(page.getByText('마지막 수신 · 15:30:02', { exact: true })).toHaveCount(2);
  await expect(states).toHaveCount(0);
  const buy = page.getByTestId('order-window').getByRole('button', { name: /매수 67,200원 주문 추가/ });
  await expect(buy).toHaveAttribute('aria-disabled', 'true');
  const bookTime = await page.evaluate(() => Date.now());
  fixture.ws.pushLive(code, { kind: 'ob', venue: 'KRX', t_ms: bookTime,
    asks: [{ price: 67300, qty: 100 }], bids: [{ price: 67200, qty: 200 }],
    total_ask_qty: 100, total_bid_qty: 200 });
  await expect(buy).toHaveAttribute('aria-disabled', 'false');
  await expect(states).toHaveCount(0);
  await expect(page.getByText('마지막 수신 · 15:30:02', { exact: true })).toHaveCount(0);
  await page.clock.runFor(31_000);
  await expect(states).toHaveCount(2);
  await expect(states.nth(0)).toHaveAttribute('data-state', 'stale');
  await expect(states.nth(1)).toHaveAttribute('data-state', 'stale');
  await expect(buy).toHaveAttribute('aria-disabled', 'true');
});

for (const [code, reason, label] of [
  ['069500', 'etf', 'ETF'], ['500001', 'etn', 'ETN'], ['079650', 'investment_warning', '투자경고종목'],
] as const) {
  test(`both books explain ${label} aftermarket exclusion without a delay alarm`, async ({ page }, testInfo) => {
    const fixture = await setup(page, { code, nowMs: Date.parse('2026-10-22T19:30:00+09:00'),
      bookMs: Date.parse('2026-10-22T15:30:02+09:00'), exclusionReasons: [reason] });
    fixture.setPhase('registered');
    const states = page.getByTestId('book-availability');
    await expect(states).toHaveCount(2);
    for (const notice of [states.nth(0), states.nth(1)]) {
      await expect(notice).toHaveAttribute('data-state', 'aftermarket_excluded');
      await expect(notice).toContainText(`KRX 장후 거래 제외 · ${label}`);
      await expect(notice).toContainText('16:00~20:00');
      await expect(notice).toContainText('마지막 호가 · 15:30:02');
      await expect(notice.getByRole('button')).toHaveCount(0);
    }
    await expect(page.getByText('호가 수신 지연', { exact: true })).toHaveCount(0);
    await expect(page.getByTestId('order-window').getByRole('button', { name: /매수 67,200원 주문 추가/ }))
      .toHaveAttribute('aria-disabled', 'true');
    await page.clock.runFor(61_000);
    await expect(states.nth(0)).toContainText(`KRX 장후 거래 제외 · ${label}`);
    await expect(states.nth(1)).toContainText(`KRX 장후 거래 제외 · ${label}`);
    if (code === '079650') await page.screenshot({ path: testInfo.outputPath('aftermarket-excluded.png') });
  });
}

test('an investment-warning designation does not replace normal-session book delay reporting', async ({ page }) => {
  const fixture = await setup(page, { code: '079650', bookMs: NOW - 60_000, exclusionReasons: ['investment_warning'] });
  fixture.setPhase('registered');
  await page.clock.runFor(5_100);
  const states = page.getByTestId('book-availability');
  await expect(states).toHaveCount(2);
  await expect(states.nth(0)).toHaveAttribute('data-state', 'stale');
  await expect(states.nth(1)).toHaveAttribute('data-state', 'stale');
  await expect(page.getByText(/KRX 장후 거래 제외/)).toHaveCount(0);
});
