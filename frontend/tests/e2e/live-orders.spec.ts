import { test, expect, type Page, type Locator } from '@playwright/test';
import { installLiveMocks } from './helpers/liveMocks';
import { installLiveWs } from './helpers/liveWs';

const mkOrder = (id: string, price = '67200', filled = '30') => ({
  orderId: id, symbol: '005930', side: 'BUY', orderType: 'LIMIT', timeInForce: 'DAY', status: 'PARTIAL_FILLED', price,
  quantity: '100', orderAmount: null, currency: 'KRW', orderedAt: '2026-10-13T10:00:00+09:00', canceledAt: null,
  execution: { filledQuantity: filled, averageFilledPrice: '67200', filledAmount: '2016000', commission: null, tax: null, filledAt: null, settlementDate: null },
});

async function setup(page: Page, withOrder: boolean | ReturnType<typeof mkOrder>[] = false, maximize = true, sameDepth = false, priceOffset = 0, accountCount = 1, market: { time?: number; venue?: 'KRX' | 'NXT' | 'UN'; averagePrice?: string } = {}) {
  await page.setViewportSize({ width: 1440, height: 1100 });
  // Existing order/WS fixtures exercise integrated trading. Venue tests switch explicitly.
  await page.addInitScript(venue => localStorage.setItem('live.venue.v1', JSON.stringify({ venue })), market.venue ?? 'UN');
  await installLiveMocks(page);
  const ws = await installLiveWs(page);
  await page.route(/^https?:\/\/[^/]+\/api\/symbols\/all$/, route => route.fulfill({ json: {
    symbols: [{ code: '005930', name: '삼성전자', market: 'KOSPI' }, { code: '000660', name: 'SK하이닉스', market: 'KOSPI' }], status: 'fresh', fetched_at_ms: Date.now(), reason: null,
  } }));
  await page.route(/^https?:\/\/[^/]+\/api\/live\/quotes\?/, route => route.fulfill({ json: {
    phase: 'open', quotes: [{ code: new URL(route.request().url()).searchParams.get('codes')?.split(',')[0] ?? '005930', price: 67200 + priceOffset, baseline_price: 66000 + priceOffset, change_pct: 1200 / (66000 + priceOffset) * 100, change_won: 1200 }],
  } }));
  await page.route(/^https?:\/\/[^/]+\/api\/live\/series\?/, route => route.fulfill({ json: {
    code: new URL(route.request().url()).searchParams.get('code') ?? '005930', date: new URL(route.request().url()).searchParams.get('date'), session_open_ms: Date.now(), session_close_ms: null, is_open: true,
    snapshots: [{ kind: 'ob', venue: new URL(route.request().url()).searchParams.get('venue') ?? 'UN', t_ms: market.time ?? Date.now(), asks: Array.from({ length: 10 }, (_, i) => ({ price: 67300 + priceOffset + i * 100, qty: 100 + i })), bids: Array.from({ length: 10 }, (_, i) => ({ price: 67200 + priceOffset - i * 100, qty: (sameDepth ? 100 : 200) + i })), total_ask_qty: 1000, total_bid_qty: 2000 }],
    trades: [], brokers: [], programs: [], after_hours: [], expected: [], today_ask_peak: null, today_bid_peak: null,
  } }));
  await page.route(/^https?:\/\/[^/]+\/api\/live\/stock-limits\?/, route => route.fulfill({ json: {
    code: '005930', base_price: 66000, upper_limit: 85800, lower_limit: 46200, high_250: 1_578_000, low_250: 1_425_000,
    high_250_date: null, low_250_date: null, fetched_at_ms: Date.now(), source: 'kiwoom',
  } }));
  await page.route(/^https?:\/\/[^/]+\/api\/trading\/accounts$/, route => route.fulfill({ json: { configured: true, accounts: Array.from({ length: accountCount }, (_, i) => ({ account_seq: i + 1, label: i === 0 ? '토스증권 · ****1234' : '토스증권 · ****5678' })) } }));
  let orders = Array.isArray(withOrder) ? withOrder : withOrder ? [mkOrder('old')] : [];
  const commands: Record<string, unknown>[] = [];
  const stateRequests: string[] = [];
  await page.route(/^https?:\/\/[^/]+\/api\/trading\/state\?/, route => {
    const part = new URL(route.request().url()).searchParams.get('part') ?? 'all';
    stateRequests.push(part);
    const code = new URL(route.request().url()).searchParams.get('code') ?? '005930';
    const orderState = { account_seq: 1, code, orders: orders.filter(order => order.symbol === code), recent_orders: [], fetched_at_ms: Date.now(), events_connected: true, unresolved_commands: [] };
    const balances = { account_seq: 1, code: '005930', buying_power: '20000000', sellable_quantity: '100', holding_quantity: '100', average_purchase_price: market.averagePrice ?? '66000', fetched_at_ms: Date.now() };
    return route.fulfill({ json: part === 'orders' ? orderState : part === 'balances' ? balances : { ...balances, ...orderState } });
  });
  await page.route(/^https?:\/\/[^/]+\/api\/trading\/account-orders\?/, route => route.fulfill({ json: {
    account_seq: Number(new URL(route.request().url()).searchParams.get('account_seq')), code: '', orders, recent_orders: [],
    fetched_at_ms: Date.now(), events_connected: true, unresolved_commands: [],
  } }));
  await page.route(/^https?:\/\/[^/]+\/api\/trading\/holdings\?/, route => {
    const account_seq = Number(new URL(route.request().url()).searchParams.get('account_seq'));
    return route.fulfill({ json: { account_seq, holdings: [{ code: '000660', name: 'SK하이닉스',
      quantity: account_seq === 1 ? '22' : '33', average_purchase_price: '180000' }], fetched_at_ms: Date.now() } });
  });
  await page.route(/^https?:\/\/[^/]+\/api\/trading\/orders(?:\/[^/]+\/(?:modify|cancel))?$/, async route => {
    const body = route.request().postDataJSON(); commands.push(body);
    expect(route.request().headers()['x-hoga-order']).toBe('1');
    const path = new URL(route.request().url()).pathname;
    const operationId = `replacement-${commands.length}`;
    const targetId = decodeURIComponent(path.split('/').at(-2)!);
    const previous = orders.find(order => order.orderId === targetId);
    if (path.endsWith('/cancel')) orders = orders.filter(order => order.orderId !== targetId);
    else {
      const next = { ...mkOrder(operationId, String(body.price), previous?.execution.filledQuantity ?? '0'),
        side: body.side ?? previous?.side ?? 'BUY', quantity: String(body.quantity ?? previous?.quantity ?? 100) };
      orders = path.endsWith('/modify') ? orders.map(order => order.orderId === targetId ? next : order) : [...orders, next];
    }
    await route.fulfill({ json: { command_id: body.command_id, order_id: operationId, status: 'accepted' } });
  });
  await page.route(/^https?:\/\/[^/]+\/api\/trading\/cancel-all$/, async route => {
    const body = route.request().postDataJSON(); commands.push(body);
    expect(route.request().headers()['x-hoga-order']).toBe('1');
    const canceled = orders.filter(order => body.side == null || order.side === body.side);
    orders = orders.filter(order => !canceled.includes(order));
    await route.fulfill({ json: { command_id: body.command_id,
      results: canceled.map(order => ({ order_id: order.orderId, accepted: true, operation_id: `cancel-${order.orderId}`, code: null, message: null })),
    } });
  });
  await page.goto('/live');
  await page.getByRole('button', { name: '종목 검색 열기' }).click();
  const dialog = page.getByRole('dialog', { name: '종목 검색' });
  await dialog.getByRole('combobox', { name: '종목 검색' }).fill('삼성전자');
  await dialog.getByRole('option').first().click();
  await page.getByTestId('workspace-add-menu-button').click();
  await page.getByTestId('workspace-add-order').click();
  const window = page.getByTestId('order-window');
  if (maximize) await page.locator('[data-win]').filter({ has: window }).getByRole('button', { name: '창 최대화', exact: true }).click();
  const initialSide = orders[0]?.side === 'SELL' ? '매도' : '매수';
  const initialPrice = (initialSide === '매도' ? 67300 : 67200) + priceOffset;
  await expect(window.getByRole('button', { name: new RegExp(`${initialSide} ${initialPrice.toLocaleString('ko-KR')}원 주문 추가`) })).toBeEnabled();
  return { window, commands, ws, stateRequests };
}

async function drag(page: Page, from: Locator, to: Locator) {
  const a = await from.boundingBox(), b = await to.boundingBox();
  expect(a).not.toBeNull(); expect(b).not.toBeNull();
  await page.mouse.move(a!.x + a!.width / 2, a!.y + a!.height / 2);
  await page.mouse.down();
  await page.mouse.move(b!.x + b!.width / 2, b!.y + b!.height / 2, { steps: 12 });
  await page.mouse.up();
}

test('계좌 목록은 열 때만 조회하고 다른 종목 주문을 취소하며 보유종목으로 이동한다', async ({ page }, testInfo) => {
  const other = { ...mkOrder('other-sell', '185000', '0'), symbol: '000660', side: 'SELL', quantity: '22' };
  const reads: string[] = [];
  page.on('request', request => { const path = new URL(request.url()).pathname;
    if (['/api/trading/account-orders', '/api/trading/holdings'].includes(path)) reads.push(path); });
  const { window, commands } = await setup(page, [mkOrder('old'), other], false);
  expect(reads).toEqual([]);
  await window.getByRole('button', { name: '미체결 주문', exact: true }).click();
  const panel = page.getByRole('dialog', { name: '계좌 목록' });
  await expect(panel.getByRole('button', { name: '삼성전자', exact: true })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'SK하이닉스', exact: true })).toBeVisible();
  await panel.screenshot({ path: testInfo.outputPath('account-orders-panel.png') });
  expect(reads).toContain('/api/trading/account-orders'); expect(reads).not.toContain('/api/trading/holdings');
  await panel.getByRole('button', { name: '매도', exact: true }).click();
  await expect(panel.getByRole('button', { name: '삼성전자', exact: true })).toHaveCount(0);
  await panel.getByRole('button', { name: 'SK하이닉스 매도 주문 1 취소', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'SK하이닉스', exact: true })).toHaveCount(0);
  expect(commands).toHaveLength(1); expect(commands[0]).toMatchObject({ code: '000660', account_seq: 1 });
  await panel.getByRole('button', { name: '전체', exact: true }).click();
  await expect(panel.getByRole('button', { name: '삼성전자', exact: true })).toBeVisible();
  await panel.getByRole('tab', { name: '보유종목', exact: true }).click();
  await expect(panel.getByRole('cell', { name: '22', exact: true })).toBeVisible();
  await panel.screenshot({ path: testInfo.outputPath('account-holdings-panel.png') });
  await panel.getByRole('button', { name: 'SK하이닉스', exact: true }).click();
  await expect(panel).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'SK하이닉스 호가 주문 창 닫기', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'SK하이닉스 10호가 창 닫기', exact: true })).toBeVisible();
  expect(commands).toHaveLength(1);
});

test('고정한 호가 주문 창의 보유종목 이동은 다른 연결 창의 종목을 바꾸지 않는다', async ({ page }) => {
  const { window, commands } = await setup(page);
  const frame = page.locator('[data-win]').filter({ has: window });
  await frame.getByRole('button', { name: '이 창 종목 고정 — 목록 클릭으로 안 바뀌고, 이 창에 직접 드롭할 때만 바뀝니다', exact: true }).click();
  await window.getByRole('button', { name: '보유종목', exact: true }).click();
  await page.getByRole('dialog', { name: '계좌 목록' }).getByRole('button', { name: 'SK하이닉스', exact: true }).click();
  await expect(page.getByRole('button', { name: 'SK하이닉스 호가 주문 창 닫기', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '삼성전자 10호가 창 닫기', exact: true })).toBeVisible();
  expect(commands).toHaveLength(0);
});

test('계좌 전환 후 늦게 도착한 이전 보유 목록은 새 계좌를 덮어쓰지 않는다', async ({ page }) => {
  const { window } = await setup(page, false, true, false, 0, 2);
  let release!: () => void, entered = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route(/\/api\/trading\/holdings\?/, async route => {
    if (new URL(route.request().url()).searchParams.get('account_seq') === '1') { entered = true; await gate; }
    await route.fallback();
  });
  try {
    await window.getByRole('button', { name: '보유종목', exact: true }).click();
    await expect.poll(() => entered).toBe(true);
    await window.getByRole('combobox', { name: '주문 계좌', exact: true }).selectOption('2');
    const panel = page.getByRole('dialog', { name: '계좌 목록' });
    await expect(panel.getByRole('cell', { name: '33', exact: true })).toBeVisible();
    release();
    await expect(panel.getByRole('cell', { name: '22', exact: true })).toHaveCount(0);
    await expect(panel.getByText('토스증권 · ****5678', { exact: true })).toBeVisible();
    await page.keyboard.press('Escape'); await expect(panel).toHaveCount(0);
  } finally { release(); }
});

test('계좌 목록의 처리 중 취소는 중복 전송하지 않고 닫혀 있는 탭은 조회하지 않는다', async ({ page }) => {
  const { window, commands } = await setup(page, true);
  let release!: () => void, entered = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const reads: string[] = [];
  page.on('request', request => { const path = new URL(request.url()).pathname;
    if (['/api/trading/account-orders', '/api/trading/holdings'].includes(path)) reads.push(path); });
  await page.route(/\/api\/trading\/orders\/old\/cancel$/, async route => { entered = true; await gate; await route.fallback(); });
  try {
    await window.getByRole('button', { name: '미체결 주문', exact: true }).click();
    const panel = page.getByRole('dialog', { name: '계좌 목록' });
    const cancel = panel.getByRole('button', { name: '삼성전자 매수 주문 1 취소', exact: true });
    await cancel.click(); await expect.poll(() => entered).toBe(true);
    await expect(panel.getByRole('button', { name: '삼성전자 매수 주문 1 취소 중', exact: true })).toBeDisabled();
    const readsBefore = reads.length;
    await window.getByRole('button', { name: '보유종목', exact: true }).click();
    expect(reads).toHaveLength(readsBefore);
    release();
    await expect.poll(() => commands.length).toBe(1);
    await expect(panel.getByRole('cell', { name: '22', exact: true })).toBeVisible();
    await panel.getByRole('tab', { name: '미체결 주문', exact: true }).click();
    await expect(panel.getByRole('button', { name: '삼성전자', exact: true })).toHaveCount(0);
    await panel.getByRole('button', { name: '계좌 목록 닫기', exact: true }).click();
    await expect(panel).toHaveCount(0);
  } finally { release(); }
});

test('긴 계좌 주문 목록은 작은 화면 안에서 스크롤하며 마지막 주문만 취소한다', async ({ page }) => {
  const { window, commands } = await setup(page, Array.from({ length: 40 }, (_, i) => mkOrder(`list-${i}`)), false);
  await page.setViewportSize({ width: 800, height: 700 });
  await window.getByRole('button', { name: '미체결 주문', exact: true }).click();
  const panel = page.getByRole('dialog', { name: '계좌 목록' });
  await expect(panel.locator('tbody tr')).toHaveCount(40);
  const bounds = (await panel.boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.y).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(800);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(700);
  const last = panel.getByRole('button', { name: '삼성전자 매수 주문 40 취소', exact: true });
  await last.scrollIntoViewIfNeeded(); await last.click();
  await expect(panel.locator('tbody tr')).toHaveCount(39);
  expect(commands).toHaveLength(1);
  await page.keyboard.press('Escape'); await expect(panel).toHaveCount(0);
});

test('느린 주문 상태 조회 중에도 접수 응답을 표시하고 기존 주문의 중복 취소는 막는다', async ({ page }) => {
  const { window, commands } = await setup(page, true);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route(/\/api\/trading\/state\?/, async route => {
    if (new URL(route.request().url()).searchParams.get('part') === 'orders') await gate;
    await route.fallback();
  });
  try {
    const cell = window.getByRole('button', { name: /매수 67,200원 주문 추가/ });
    await drag(page, cell, window.getByRole('button', { name: '주문 설정', exact: true }));
    await expect(page.getByRole('status', { name: '주문 접수 알림' })).toHaveText('취소 요청 접수됨');
    await expect(window.getByRole('button', { name: '주문 설정', exact: true })).toBeEnabled();
    await expect(cell).toHaveText('70 · 처리 중');
    await cell.click({ button: 'right' });
    await expect(page.getByRole('menuitem', { name: '주문 1 · 70주', exact: true })).toBeDisabled();
    await page.keyboard.press('Escape');
    expect(commands).toHaveLength(1);
    await window.getByRole('button', { name: /매수 67,100원 주문 추가/ }).dblclick();
    await expect.poll(() => commands.length).toBe(2);
    await expect(window.getByRole('button', { name: '주문 설정', exact: true })).toBeEnabled();
    release();
    await expect(cell).toBeEmpty();
  } finally { release(); }
});

for (const timing of ['before', 'after'] as const) {
  test(`정정 완료 이벤트가 접수 응답 ${timing}에 와도 새 주문의 회색 잠금을 조회 없이 해제한다`, async ({ page }) => {
    const { window, ws } = await setup(page, true);
    const replacement = { ...mkOrder('new-modified', '67100', '0'), quantity: '70', status: 'PENDING_REPLACE' };
    let releaseAck!: () => void, releaseRead!: () => void, entered = false;
    const ackGate = new Promise<void>(resolve => { releaseAck = resolve; });
    const readGate = new Promise<void>(resolve => { releaseRead = resolve; });
    const writes: Record<string, unknown>[] = [];
    await page.route(/\/api\/trading\/orders\/old\/modify$/, async route => {
      const body = route.request().postDataJSON(); writes.push(body); entered = true;
      await ackGate;
      await route.fulfill({ json: { command_id: body.command_id, order_id: replacement.orderId, status: 'accepted' } });
    });
    await page.route(/\/api\/trading\/state\?/, async route => {
      if (new URL(route.request().url()).searchParams.get('part') !== 'orders') return route.fallback();
      await readGate;
      // Even a later REST response can lag the final broker event.
      await route.fulfill({ json: { account_seq: 1, code: '005930', orders: [replacement, { ...mkOrder('old'), status: 'PENDING_REPLACE' }], recent_orders: [],
        fetched_at_ms: Date.now(), events_connected: true, unresolved_commands: [], revision: 900 } });
    });
    const from = window.getByRole('button', { name: /매수 67,200원 주문 추가/ });
    const to = window.getByRole('button', { name: /매수 67,100원 주문 추가/ });
    try {
      await drag(page, from, to);
      await expect.poll(() => entered).toBe(true);
      ws.pushEvent({ type: 'trading_order', mode: 'live', account_seq: 1, revision: 100, order: replacement });
      ws.pushEvent({ type: 'trading_order', mode: 'live', account_seq: 1, revision: 101, order: { ...mkOrder('old'), status: 'PENDING_REPLACE' } });
      await expect(to).toHaveText('70 · 처리 중');
      const completed = { type: 'trading_order', mode: 'live', account_seq: 1, revision: 102, order: { ...replacement, status: 'PENDING' } };
      if (timing === 'before') {
        ws.pushEvent(completed);
        await expect(to).toHaveText('70 · 처리 중');
      }
      releaseAck();
      await expect(page.getByRole('status', { name: '주문 접수 알림' })).toHaveText('정정 요청 접수됨');
      if (timing === 'after') {
        await expect(to).toHaveText('70 · 처리 중');
        ws.pushEvent(completed);
      }
      await expect(to).toHaveText('70');
      await expect(window.getByLabel('매수 67,100원 주문', { exact: true })).toHaveAttribute('data-drag-order', replacement.orderId);
      await expect(from).toBeEmpty();
      expect(writes).toHaveLength(1);
      expect(writes[0]).toMatchObject({ quantity: null, price: 67100 });
      releaseRead();
      await expect(to).toHaveText('70');
      await expect(from).toBeEmpty();
    } finally { releaseAck(); releaseRead(); }
  });
}

test('느린 잔고 조회는 주문 수량 표시와 다음 주문을 지연시키지 않는다', async ({ page }) => {
  const { window, commands } = await setup(page);
  let release!: () => void, entered = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route(/\/api\/trading\/state\?/, async route => {
    if (new URL(route.request().url()).searchParams.get('part') === 'balances') { entered = true; await gate; }
    await route.fallback();
  });
  try {
    const buy = window.getByRole('button', { name: /매수 67,200원 주문 추가/ });
    await buy.dblclick();
    await expect(buy).toHaveText('10');
    await expect.poll(() => entered).toBe(true);
    await window.getByRole('button', { name: /매수 67,100원 주문 추가/ }).dblclick();
    await expect(window.getByRole('button', { name: /매수 67,100원 주문 추가/ })).toHaveText('10');
    expect(commands).toHaveLength(2);
  } finally { release(); }
});

test('5건 묶음 취소 중 주문 이벤트가 와도 조회를 끼워 넣지 않고 마지막에 한번 갱신한다', async ({ page }) => {
  const { window, commands, ws, stateRequests } = await setup(page, Array.from({ length: 5 }, (_, i) => mkOrder(`item-${i}`)));
  await expect(window.getByLabel('매수 가능 금액')).toContainText('20,000,000원');
  stateRequests.length = 0;
  const readsDuringWrites: number[] = [];
  await page.route(/\/api\/trading\/orders\/item-\d+\/cancel$/, async route => {
    ws!.pushEvent({ type: 'trading_changed', mode: 'live', revision: commands.length + 1 });
    // Inject broker latency so each event exceeds the refresh coalescing window.
    await new Promise(resolve => setTimeout(resolve, 200));
    readsDuringWrites.push(stateRequests.length);
    await route.fallback();
  });
  const cell = window.getByRole('button', { name: /매수 67,200원 주문 추가/ });
  await drag(page, cell, window.getByRole('button', { name: '주문 설정', exact: true }));
  await expect(cell).toBeEmpty();
  expect(commands).toHaveLength(5);
  expect(readsDuringWrites).toEqual([0, 0, 0, 0, 0]);
  expect(stateRequests.filter(part => part === 'orders')).toHaveLength(1);
});

test('묶음 취소 응답을 기다리는 동안 다른 주문의 체결·취소 이벤트를 즉시 표시하고 늦은 조회가 되돌리지 않는다', async ({ page }, testInfo) => {
  const other = mkOrder('other', '67100');
  const { window, commands, ws, stateRequests } = await setup(page, [...Array.from({ length: 5 }, (_, i) => mkOrder(`item-${i}`)), other]);
  await expect(window.getByLabel('매수 가능 금액')).toContainText('20,000,000원');
  const target = window.getByRole('button', { name: /매수 67,100원 주문 추가/ });
  const source = window.getByRole('button', { name: /매수 67,200원 주문 추가/ });
  let release!: () => void, entered = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route(/\/api\/trading\/orders\/item-0\/cancel$/, async route => { entered = true; await gate; await route.fallback(); });
  stateRequests.length = 0;
  try {
    await drag(page, source, window.getByRole('button', { name: '주문 설정', exact: true }));
    await expect.poll(() => entered).toBe(true);
    const at = Date.now();
    ws!.pushEvent({ type: 'trading_order', mode: 'live', account_seq: 1, revision: 100,
      order: { ...other, execution: { ...other.execution, filledQuantity: '50' } } });
    await expect(target).toHaveText('50');
    await testInfo.attach('event-to-display-observed', { body: JSON.stringify({ upper_bound_ms: Date.now() - at }), contentType: 'application/json' });
    expect(commands).toHaveLength(0);
    expect(stateRequests.filter(part => part === 'orders')).toHaveLength(0);
    ws!.pushEvent({ type: 'trading_order', mode: 'live', account_seq: 1, revision: 99, order: other });
    await expect(target).toHaveText('50');
    ws!.pushEvent({ type: 'trading_order', mode: 'live', account_seq: 1, revision: 101,
      order: { ...other, status: 'CANCELED', execution: { ...other.execution, filledQuantity: '50' } } });
    await expect(target).toBeEmpty();
    ws!.pushEvent({ type: 'trading_order', mode: 'live', account_seq: 1, revision: 102,
      order: { ...other, execution: { ...other.execution, filledQuantity: '50' } } });
    release();
    await expect(source).toBeEmpty();
    await expect(target).toBeEmpty();
    expect(commands).toHaveLength(5);
  } finally { release(); }
});

test('주문한 칸은 버튼 하나이며 수량과 칸 가장자리 더블클릭으로 추가 주문한다', async ({ page }, testInfo) => {
  const { window, commands } = await setup(page, true, false);
  const cell = window.getByRole('button', { name: /매수 67,200원 주문 추가/ });
  const quantity = window.getByLabel('매수 67,200원 주문', { exact: true });
  await expect(cell).toHaveText('70');
  await expect(cell.locator('button')).toHaveCount(0);
  await expect(window.locator('.order-add')).toHaveCount(0);
  await window.getByRole('spinbutton', { name: '신규 주문 수량' }).fill('25');
  await quantity.click();
  expect(commands).toHaveLength(0);
  await quantity.dblclick();
  await expect(cell).toHaveText('95');
  expect(commands).toHaveLength(1);
  expect(commands[0]).toMatchObject({ side: 'BUY', price: 67200, quantity: 25 });
  await cell.dblclick({ position: { x: 1, y: 1 } });
  await expect(cell).toHaveText('120');
  expect(commands).toHaveLength(2);
  expect(commands[1]).toMatchObject({ side: 'BUY', price: 67200, quantity: 25 });
  await page.screenshot({ path: testInfo.outputPath('order-single-cell.png') });
});

test('주문 한 건이 있는 칸의 가장자리도 드래그 정정하고 드래그 클릭은 추가 주문하지 않는다', async ({ page }) => {
  const { window, commands } = await setup(page, true);
  const cell = window.getByRole('button', { name: /매수 67,200원 주문 추가/ });
  const destination = window.getByRole('button', { name: /매수 67,100원 주문 추가/ });
  const source = (await cell.boundingBox())!;
  const target = (await destination.boundingBox())!;
  await page.mouse.move(source.x + 1, source.y + 1);
  await page.mouse.down();
  await page.mouse.move(target.x + 1, target.y + 1, { steps: 12 });
  await page.mouse.up();
  await expect(destination).toHaveText('70');
  expect(commands).toHaveLength(1);
  expect(commands[0]).toMatchObject({ price: 67100, quantity: null });
  // A browser dblclick immediately following a drag must never create an order.
  await destination.dispatchEvent('click', { detail: 2 });
  await destination.dispatchEvent('dblclick', { detail: 2 });
  expect(commands).toHaveLength(1);
  await destination.dblclick();
  await expect(destination).toHaveText('80');
  expect(commands).toHaveLength(2);
});

test('오른쪽 가장자리 주문 취소 메뉴는 실시간 갱신 중에도 화면 안에서 안정적으로 열린다', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  // ErrorBoundary가 처리한 렌더 오류도 검출한다.
  page.on('console', message => {
    if (message.type() === 'error' && message.text().includes('Maximum update depth')) errors.push(message.text());
  });
  const { window, commands, ws } = await setup(page, true);
  await ws!.waitForSubscribe('005930');
  const menu = page.getByRole('menu', { name: '주문 취소', exact: true });
  for (const viewport of [{ width: 1440, height: 1100 }, { width: 800, height: 700 }]) {
    await page.setViewportSize(viewport);
    const row = window.locator('.order-row').last();
    await row.scrollIntoViewIfNeeded();
    const box = (await row.boundingBox())!;
    await row.click({ button: 'right', position: { x: box.width - 1, y: box.height / 2 } });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: '매수 모두 취소' })).toBeFocused();
    const bounds = (await menu.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.y).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height);
    const strength = viewport.width === 1440 ? 141 : 142;
    ws!.pushLive('005930', { kind: 'trade', venue: 'UN', t_ms: Date.now(), fill_strength_pct: strength,
      trades: [{ price: 67200, qty: 78, side: 1 }],
    });
    await expect(window.locator('.order-info').nth(0)).toHaveText(`체결강도${strength}%`);
    await expect(menu).toBeVisible();
    expect(await menu.boundingBox()).toEqual(bounds);
    expect(errors).toEqual([]);
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
  }
  await window.locator('.order-row').last().click({ button: 'right' });
  await menu.getByRole('menuitem', { name: '전체 주문 취소' }).click();
  await expect(window.locator('[data-drag-order]')).toHaveCount(0);
  expect(commands).toHaveLength(1);
  expect(errors).toEqual([]);
});

test('venue 선택은 시세·잔량·체결을 바꾸고 주문은 같은 지정가로 통합 처리한다', async ({ page }) => {
  const { window, commands, ws } = await setup(page);
  await ws!.waitForSubscribe('005930');
  await page.getByTestId('live-venue-picker').click();
  await page.getByTestId('live-venue-option-NXT').click();
  await expect(window.getByLabel('시세·주문 기준')).toHaveCount(0);
  ws!.pushLive('005930', { kind: 'ob', venue: 'NXT', t_ms: Date.now(),
    asks: Array.from({ length: 10 }, (_, i) => ({ price: 68300 + i * 100, qty: 300 + i })),
    bids: Array.from({ length: 10 }, (_, i) => ({ price: 68200 - i * 100, qty: 400 + i })),
    total_ask_qty: 3300, total_bid_qty: 4400,
  });
  ws!.pushLive('005930', { kind: 'trade', venue: 'NXT', t_ms: Date.now(), fill_strength_pct: 140,
    trades: [{ price: 68200, qty: 77, side: 1 }],
  });
  await expect(window.getByLabel('매도총잔량 3,300')).toBeVisible();
  await expect(window.getByLabel('매수총잔량 4,400')).toBeVisible();
  await expect(window.locator('[data-order-price="68300"] .order-depth-qty')).toHaveText('300');
  await expect(window.locator('.order-info').nth(0)).toHaveText('체결강도140%');
  await expect(window.locator('.order-info').nth(1)).toHaveText('68,20077');
  // Another market's prints must not replace the selected NXT tape.
  ws!.pushLive('005930', { kind: 'trade', venue: 'KRX', t_ms: Date.now(), fill_strength_pct: 50,
    trades: [{ price: 65000, qty: 999, side: -1 }],
  });
  await window.getByRole('button', { name: /매수 68,200원 주문 추가/ }).dblclick();
  await expect(window.getByLabel('매수 68,200원 주문', { exact: true })).toHaveText('10');
  expect(commands).toHaveLength(1);
  expect(commands[0]).toEqual({ account_seq: 1, command_id: expect.any(String), code: '005930',
    side: 'BUY', price: 68200, quantity: 10, confirm_high_value: false });
  await expect(window.locator('.order-info').nth(1)).toHaveText('68,20077');
});

test('다른 탭의 venue 전환은 드래그를 중단하고 입력 수량과 계좌 주문을 유지한다', async ({ page, context }, testInfo) => {
  const { window, commands } = await setup(page, true);
  await window.getByLabel('신규 주문 수량').fill('75');
  const sibling = await context.newPage();
  await sibling.goto(new URL('/config.json', page.url()).href);
  const chip = window.getByLabel('매수 67,200원 주문', { exact: true });
  const from = (await chip.boundingBox())!;
  const target = (await window.getByRole('button', { name: /매수 67,100원 주문 추가/ }).boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 12 });
  await expect(page.getByLabel('주문 드래그 미리보기')).toBeVisible();
  await expect(window.getByRole('button', { name: '주문 설정', exact: true })).toBeDisabled();
  await sibling.evaluate(() => localStorage.setItem('live.venue.v1', JSON.stringify({ venue: 'NXT' })));
  await expect(window.getByLabel('시세·주문 기준')).toHaveCount(0);
  await expect(page.getByLabel('주문 드래그 미리보기')).toHaveCount(0);
  await expect(window.locator('.order-target')).toHaveCount(0);
  await expect(window.getByRole('button', { name: '주문 설정', exact: true })).toBeEnabled();
  await page.mouse.up();
  await expect(window.getByLabel('신규 주문 수량')).toHaveValue('75');
  await expect(chip).toHaveText('70');
  expect(commands).toHaveLength(0);
  await window.screenshot({ path: testInfo.outputPath('venue-order-window.png') });
  await sibling.close();
});

test('576px 압축형은 라벨 있는 보유 정보와 주문 입력을 분리하고 호가 밀도를 유지한다', async ({ page }, testInfo) => {
  const { window, commands } = await setup(page, false, false);
  const frame = page.locator('[data-win]').filter({ has: window });
  await expect.poll(async () => (await frame.boundingBox())!.width).toBeCloseTo(576, 0);
  await expect.poll(() => window.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await expect(window).toHaveClass(/order-expanded/);
  await expect(window.getByRole('button', { name: '종목 상세 정보', exact: true })).toHaveCount(0);
  await expect(window.getByTestId('book-summary').getByText('1,578,000/1,425,000', { exact: true })).toBeVisible();
  const settings = (await window.getByRole('button', { name: '주문 설정', exact: true }).boundingBox())!;
  const buyingPower = window.getByLabel('매수 가능 금액');
  const cash = (await buyingPower.boundingBox())!;
  expect(cash.y).toBeGreaterThan(settings.y + settings.height);
  expect(await buyingPower.evaluate(el => getComputedStyle(el).whiteSpace)).toBe('nowrap');
  for (const label of ['보유', '평단가', '평가손익']) await expect(window.getByText(label, { exact: true })).toBeVisible();
  const holdings = (await window.getByRole('group', { name: '보유 종목 정보' }).boundingBox())!;
  const inputs = (await window.getByRole('group', { name: '공통 주문 수량' }).boundingBox())!;
  expect(inputs.y).toBeGreaterThan(holdings.y + holdings.height);
  await expect(window.locator('.order-row').first()).toHaveCSS('height', '24px');
  const priceFont = await window.locator('.order-price > span').first().evaluate(el => getComputedStyle(el).fontSize);
  await window.screenshot({ path: testInfo.outputPath('compact-order-window.png') });
  const buy = window.getByRole('button', { name: /매수 67,200원 주문 추가/ });
  await buy.click();
  expect(commands).toHaveLength(0);
  await buy.dblclick();
  const chip = window.getByLabel('매수 67,200원 주문', { exact: true });
  await expect(chip).toHaveText('10');
  await chip.click();
  await expect(window.getByRole('group', { name: '주문 확인' })).toHaveCount(0);
  await expect(window.getByRole('spinbutton', { name: '정정 수량' })).toHaveCount(0);
  expect(commands).toHaveLength(1);
  await drag(page, chip, window.getByRole('button', { name: /매수 67,100원 주문 추가/ }));
  const moved = window.getByLabel('매수 67,100원 주문', { exact: true });
  await expect(moved).toHaveText('10');
  expect(commands).toHaveLength(2);
  await drag(page, moved, window.getByRole('button', { name: '주문 설정', exact: true }));
  await expect(window.locator('[data-drag-order]')).toHaveCount(0);
  expect(commands).toHaveLength(3);
  await window.evaluate(el => { (el as HTMLElement).style.width = '700px'; });
  expect(await window.locator('.order-price > span').first().evaluate(el => getComputedStyle(el).fontSize)).toBe(priceFont);
  await expect(window.locator('.order-quantity-controls')).toHaveCSS('flex-direction', 'row');
});

test('매입수량·평단가에 500ms 호버하면 매수금액을 표시하고 이탈·스크롤로 닫는다', async ({ page }, testInfo) => {
  const { window, commands } = await setup(page);
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  const quantity = window.getByLabel('매입수량');
  const average = window.getByLabel('매입평단가');
  const tooltip = page.getByRole('tooltip');
  await quantity.hover();
  await page.clock.runFor(499);
  await expect(tooltip).toHaveCount(0);
  await page.mouse.move(0, 0);
  await page.clock.runFor(1);
  await expect(tooltip).toHaveCount(0);
  await quantity.hover();
  await page.clock.runFor(500);
  await expect(tooltip).toHaveText('매수금액 6,600,000원');
  await expect(quantity).toHaveAttribute('aria-describedby', await tooltip.getAttribute('id') as string);
  await page.screenshot({ path: testInfo.outputPath('holding-purchase-tooltip.png') });
  await average.hover();
  await expect(tooltip).toHaveCount(0);
  await page.clock.runFor(500);
  await expect(tooltip).toHaveText('매수금액 6,600,000원');
  await average.press('Escape');
  await expect(tooltip).toHaveCount(0);
  await page.mouse.move(0, 0);
  await quantity.hover();
  await window.evaluate(el => el.dispatchEvent(new Event('scroll')));
  await page.clock.runFor(500);
  await expect(tooltip).toHaveCount(0);
  expect(commands).toHaveLength(0);
});

test('평단가 원은 시고저 배지·7자리 가격과 좁은 창에서도 겹치지 않는다', async ({ page }, testInfo) => {
  const { window, commands, ws } = await setup(page, false, false, false, 1_401_800, 1, { averagePrice: '1469040.5' });
  await ws!.waitForSubscribe('005930');
  const value = window.locator('[data-order-price="1469000"] .order-price-value');
  const dot = window.getByRole('img', { name: '내 평단가 1,469,040.5원 · 가장 가까운 호가 1,469,000원' });
  await expect(dot).toBeVisible();
  await expect(window.locator('.order-average-marker')).toHaveCount(1);
  for (const [field, label] of [['day_open', '시'], ['day_high', '고'], ['day_low', '저']] as const) {
    ws!.pushLive('005930', { kind: 'trade', venue: 'UN', t_ms: Date.now(),
      day_open: 1_470_000, day_high: 1_470_000, day_low: 1_468_100, [field]: 1_469_000,
      trades: [{ price: 1_469_000, qty: 1, side: 1 }],
    });
    const badge = value.locator('[data-price-badges] > span');
    await expect(badge).toHaveText(label);
    await expect(value.locator('..')).toHaveClass(/order-current/);
    for (const width of [800, 696, 576, 560, 504, 360]) {
      await window.evaluate((el, width) => { (el as HTMLElement).style.width = `${width}px`; (el as HTMLElement).style.flexShrink = '0'; }, width);
      await expect(window).toHaveClass(width < 560 ? /order-compact/ : /order-expanded/);
      // Measure in one frame: ResizeObserver may switch density between separate reads.
      await expect.poll(() => value.evaluate(el => {
        const badgeBox = el.querySelector('[data-price-badges] > span')!.getBoundingClientRect();
        const dotBox = el.querySelector('.order-average-marker')!.getBoundingClientRect();
        const text = Array.from(el.childNodes).find(node => node.nodeType === Node.TEXT_NODE && node.textContent?.includes('1,469,000'))!;
        const range = document.createRange(); range.selectNode(text);
        const textBox = range.getBoundingClientRect();
        const priceBox = el.parentElement!.getBoundingClientRect();
        const percentBox = el.parentElement!.querySelector('small')!.getBoundingClientRect();
        return {
          badgeBeforeDot: badgeBox.right + 1 <= dotBox.left,
          dotBeforeText: dotBox.right + 1 <= textBox.left,
          textBeforePercent: textBox.right <= percentBox.left,
          withinPrice: badgeBox.left >= priceBox.left && percentBox.right <= priceBox.right,
        };
      })).toEqual({ badgeBeforeDot: true, dotBeforeText: true, textBeforePercent: true, withinPrice: true });
    }
  }
  await window.evaluate(el => { (el as HTMLElement).style.width = '576px'; });
  await expect(window).toHaveClass(/order-expanded/);
  await window.screenshot({ path: testInfo.outputPath('order-average-day-badge.png') });
  expect(commands).toHaveLength(0);
});

test('주문창은 실시간 틱 방향색·잔량 증감·가격 왼쪽 시고저를 10호가 규칙으로 표시한다', async ({ page }, testInfo) => {
  const { window, commands, ws } = await setup(page);
  await ws!.waitForSubscribe('005930');
  const t_ms = Date.now();
  ws!.pushLive('005930', {
    kind: 'trade', venue: 'UN', t_ms, fill_strength_pct: 120,
    day_open: 67400, day_high: 68200, day_low: 66300,
    trades: [{ price: 66000, qty: 23, side: -1 }, { price: 67200, qty: 37, side: 1 }],
  });
  const ticks = window.locator('.order-info');
  await expect(ticks.nth(0)).toHaveText('체결강도120%');
  await expect(ticks.nth(1)).toHaveText('67,20037');
  await expect(ticks.nth(1).locator('span').last()).toHaveClass(/text-price-up/);
  await expect(ticks.nth(2).locator('span').last()).toHaveClass(/text-price-down/);
  await expect(ticks.nth(1).locator('span').first()).toHaveClass(/text-price-up/);
  await expect(ticks.nth(2).locator('span').first()).toHaveClass(/text-fg-dim/);
  for (const [price, label] of [[67400, '시'], [68200, '고'], [66300, '저']] as const) {
    const value = window.locator(`[data-order-price="${price}"] .order-price-value`);
    const marker = value.locator('[data-price-badges]');
    await expect(marker).toHaveText(label);
    const markerBox = (await marker.boundingBox())!;
    const valueBox = (await value.boundingBox())!;
    expect(markerBox.x).toBeGreaterThanOrEqual(valueBox.x);
    expect(markerBox.x + markerBox.width).toBeLessThanOrEqual(valueBox.x + 24);
  }
  ws!.pushLive('005930', {
    kind: 'ob', venue: 'UN', t_ms: t_ms + 1,
    asks: Array.from({ length: 10 }, (_, i) => ({ price: 67300 + i * 100, qty: i === 0 ? 1300 : 100 + i })),
    bids: Array.from({ length: 10 }, (_, i) => ({ price: 67200 - i * 100, qty: i === 0 ? 120 : 200 + i })),
    total_ask_qty: 2200, total_bid_qty: 1920,
  });
  const incoming = window.locator('[data-order-price="67300"] .order-ask').getByTitle('+1,200', { exact: true });
  const outgoing = window.locator('[data-order-price="67200"] .order-bid').getByTitle('−80', { exact: true });
  await expect(incoming).toHaveClass(/text-price-up/);
  await expect(outgoing).toHaveClass(/text-price-down/);
  await expect(window.locator('[data-order-price="67300"] .order-depth-qty')).toHaveText('1,300');
  await expect(window.locator('[data-order-price="67200"] .order-depth-qty')).toHaveText('120');
  await window.screenshot({ path: testInfo.outputPath('order-book-display-parity.png') });
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  await page.clock.runFor(2500);
  await expect(window.locator('.book-qty-delta')).toHaveCount(0);
  expect(commands).toHaveLength(0);
});

test('왼쪽 매도·오른쪽 매수 더블클릭 주문, 상하단 정보·신규 확인창 없음', async ({ page }, testInfo) => {
  const { window, commands } = await setup(page);
  const add = window.getByRole('button', { name: /매수 67,200원 주문 추가/ });
  await expect(add).toHaveText('');
  const sellBox = await window.getByRole('button', { name: /매도 67,200원 주문 추가/ }).boundingBox();
  const buyBox = await add.boundingBox();
  expect(sellBox!.x).toBeLessThan(buyBox!.x);
  await expect(window.locator('.order-topline,.order-quote,.order-footer,.order-position,.order-cancel-zone,.order-status,.order-history')).toHaveCount(0);
  await expect(window.getByRole('checkbox', { name: '즉시 주문' })).toHaveCount(0);
  await add.click();
  await add.press('Enter');
  await add.press('Space');
  expect(commands).toHaveLength(0);
  await expect(window.locator('[data-drag-order]')).toHaveCount(0);
  await add.dblclick();
  await expect(window.getByRole('group', { name: '주문 확인' })).toHaveCount(0);
  await expect(window.getByRole('button', { name: '주문 접수', exact: true })).toHaveCount(0);
  await expect(window.getByLabel('매수 67,200원 주문', { exact: true })).toBeVisible();
  expect(commands).toHaveLength(1);
  expect(commands[0]).toMatchObject({ code: '005930', account_seq: 1, side: 'BUY', price: 67200, quantity: 10 });
  await expect(window).not.toContainText('⠿');
  await window.screenshot({ path: testInfo.outputPath('order-window.png') });
});

for (const priceOffset of [0, -2000]) {
  test(`평가손익 숫자 전환은 주변 항목 위치를 유지한다 (${priceOffset})`, async ({ page }) => {
    const { window, commands } = await setup(page, false, true, false, priceOffset);
    const toggle = window.getByRole('button', { name: '평가손익 표시 전환' });
    const amount = priceOffset === 0 ? '120,000' : '-80,000';
    const percent = priceOffset === 0 ? '1.82%' : '-1.21%';
    await expect(toggle).toHaveText(amount);
    await page.evaluate(() => document.fonts.ready);
    const originalColor = await toggle.locator('.order-field-value').evaluate(el => getComputedStyle(el).color);
    await toggle.click();
    await expect(toggle).toHaveText(amount);
    const fields = [window.getByLabel('매입수량'), window.getByLabel('매입평단가'), window.getByLabel('보유 종목 평가 수익'), toggle];
    for (const width of [800, 504, 360]) {
      await window.evaluate((el, width) => { (el as HTMLElement).style.width = `${width}px`; }, width);
      const before = await Promise.all(fields.map(field => field.boundingBox()));
      await toggle.dblclick();
      await expect(toggle).toHaveText(percent);
      await expect(toggle).toHaveAttribute('aria-pressed', 'true');
      await expect(toggle.locator('.order-field-value')).toHaveCSS('color', originalColor);
      const after = await Promise.all(fields.map(field => field.boundingBox()));
      for (let i = 0; i < fields.length; i++) {
        expect(after[i]!.x).toBeCloseTo(before[i]!.x, 1);
        expect(after[i]!.y).toBeCloseTo(before[i]!.y, 1);
        expect(after[i]!.width).toBeCloseTo(before[i]!.width, 1);
        expect(after[i]!.height).toBeCloseTo(before[i]!.height, 1);
      }
      await toggle.dblclick();
      await expect(toggle).toHaveText(amount);
    }
    await toggle.focus();
    await page.keyboard.press('Enter');
    await expect(toggle).toHaveText(percent);
    await page.keyboard.press('Space');
    await expect(toggle).toHaveText(amount);
    expect(commands).toHaveLength(0);
  });
}

test('공통 수량·환산 금액·상단 보유 종목 매입 정보', async ({ page }, testInfo) => {
  const { window, commands } = await setup(page);
  await expect(window.getByRole('combobox', { name: '수량 방향' })).toHaveCount(0);
  await expect(window.getByLabel('주문 기준 금액')).toHaveCount(0);
  await expect(window.getByRole('button', { name: '매도 25%' })).toHaveCount(0);
  await expect(window.getByLabel('매수 가능 금액')).toHaveText('매수 가능20,000,000원');
  await expect(window.getByLabel('매도 가능 수량')).toHaveCount(0);
  await expect(window.getByLabel('매입수량').locator('.order-field-value')).toHaveText('100');
  await expect(window.getByLabel('매입평단가').locator('.order-field-value')).toHaveText('66,000');
  const valuation = window.getByLabel('보유 종목 평가 수익');
  await expect(valuation.locator('.order-field-value')).toHaveText('120,000');
  // 숫자만 상승 색을 쓰고 라벨은 기존 메타 색을 유지한다.
  const profitColor = await window.evaluate(el => getComputedStyle(el).getPropertyValue('--price-up').trim());
  const rgb = profitColor.match(/^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i)!;
  await expect(valuation.locator('.order-field-value')).toHaveCSS('color', `rgb(${rgb.slice(1).map(hex => parseInt(hex, 16)).join(', ')})`);
  await expect(valuation.locator('.order-meta')).toHaveText('평가손익');
  const averageBox = (await window.getByLabel('매입평단가').boundingBox())!;
  const valuationBox = (await valuation.boundingBox())!;
  expect(valuationBox.x).toBeGreaterThan(averageBox.x + averageBox.width);
  expect(valuationBox.y).toBe(averageBox.y);
  const inputBox = (await window.getByRole('group', { name: '공통 주문 수량' }).boundingBox())!;
  expect(inputBox.y).toBeGreaterThan(valuationBox.y + valuationBox.height);
  const preset = window.getByRole('button', { name: '50주', exact: true });
  await preset.click();
  await expect(preset).toHaveAttribute('aria-pressed', 'true');
  const buy = window.getByRole('button', { name: /매수 67,200원 주문 추가/ });
  await buy.hover();
  await expect(window.getByLabel('예상 주문 금액').locator('.order-field-value')).toHaveText('3,360,000원');
  await expect(window.getByRole('button', { name: '종목 상세 정보', exact: true })).toHaveCount(0);
  const summary = window.getByTestId('book-summary');
  await expect(summary.getByText('매수 가능', { exact: true })).toHaveCount(0);
  await expect(summary.getByText('매도 가능', { exact: true })).toHaveCount(0);
  for (const label of ['KRX종가', '상승VI', '하강VI', '250일']) await expect(summary.getByText(label, { exact: true })).toBeVisible();
  await buy.dblclick();
  await expect(window.getByLabel('매수 67,200원 주문', { exact: true })).toHaveText('50');
  expect(commands[0]).toMatchObject({ side: 'BUY', quantity: 50 });
  await drag(page, window.getByLabel('매수 67,200원 주문', { exact: true }), window.getByRole('button', { name: '주문 설정', exact: true }));
  const sell = window.getByRole('button', { name: /매도 67,300원 주문 추가/ });
  await expect(sell).toBeEnabled();
  await sell.focus();
  await expect(window.getByLabel('예상 주문 금액').locator('.order-field-value')).toHaveText('3,365,000원');
  await expect(valuation.locator('.order-field-value')).toHaveText('120,000');
  await sell.click();
  expect(commands).toHaveLength(2);
  await expect(window.locator('[data-drag-order]')).toHaveCount(0);
  await sell.dblclick();
  await expect(window.getByLabel('매도 67,300원 주문', { exact: true })).toHaveText('50');
  expect(commands[2]).toMatchObject({ side: 'SELL', quantity: 50 });
  await window.screenshot({ path: testInfo.outputPath('unified-order-controls.png') });
});

test('압축형 바로 전환은 입력값을 보존하고 금액 프리셋은 클릭 호가로 환산한다', async ({ page }, testInfo) => {
  const { window, commands } = await setup(page, false, false);
  const mode = window.getByRole('group', { name: '주문 입력 방식' });
  await window.getByRole('spinbutton', { name: '신규 주문 수량' }).fill('37');
  await mode.getByRole('button', { name: '금액', exact: true }).click();
  await window.getByRole('button', { name: '500만', exact: true }).click();
  await mode.getByRole('button', { name: '수량', exact: true }).click();
  await expect(window.getByRole('spinbutton', { name: '신규 주문 수량' })).toHaveValue('37');
  await mode.getByRole('button', { name: '금액', exact: true }).click();
  await expect(window.getByRole('spinbutton', { name: '신규 주문 금액' })).toHaveValue('5');
  expect(commands).toHaveLength(0);
  const buy = window.getByRole('button', { name: /매수 68,200원 주문 추가/ });
  await buy.hover();
  await expect(window.getByLabel('예상 주문 수량').locator('.order-field-value')).toHaveText('73주');
  await window.screenshot({ path: testInfo.outputPath('compact-amount-controls.png') });
  await buy.dblclick();
  expect(commands).toHaveLength(1);
  expect(commands[0]).toMatchObject({ price: 68200, quantity: 73 });
});

test('압축형 팝오버는 다크 테마에서도 표시하고 키보드 탭 이동·닫기 포커스를 유지한다', async ({ page }, testInfo) => {
  const { window, commands } = await setup(page, [mkOrder('old')], false);
  await page.evaluate(() => { document.documentElement.dataset.theme = 'toss-dark'; });
  const trigger = window.getByRole('button', { name: '미체결 주문', exact: true });
  await trigger.click();
  const panel = page.getByRole('dialog', { name: '계좌 목록' });
  const ordersTab = panel.getByRole('tab', { name: '미체결 주문' });
  await ordersTab.focus();
  await page.keyboard.press('ArrowRight');
  await expect(panel.getByRole('tab', { name: '보유종목' })).toHaveAttribute('aria-selected', 'true');
  await expect(panel.getByRole('button', { name: 'SK하이닉스', exact: true })).toBeVisible();
  await panel.screenshot({ path: testInfo.outputPath('account-holdings-dark.png') });
  await page.keyboard.press('ArrowLeft');
  await expect(ordersTab).toHaveAttribute('aria-selected', 'true');
  await panel.screenshot({ path: testInfo.outputPath('account-orders-dark.png') });
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect(commands).toHaveLength(0);
});

test('주문 설정은 계좌 목록과 같은 버튼 앵커 팝오버로 열고 바깥 클릭·재클릭으로 편집을 버린다', async ({ page }, testInfo) => {
  const { window, commands } = await setup(page);
  const settings = window.getByRole('button', { name: '주문 설정', exact: true });
  const dialog = page.getByRole('dialog', { name: '주문 설정', exact: true });
  for (const theme of ['toss-light', 'toss-dark']) {
    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
    await window.getByRole('button', { name: '미체결 주문', exact: true }).click();
    const accountPanel = page.getByRole('dialog', { name: '계좌 목록' });
    const accountStyle = await accountPanel.evaluate(el => {
      const s = getComputedStyle(el);
      return [s.backgroundColor, s.color, s.borderColor, s.borderRadius, s.boxShadow, s.fontSize];
    });
    await settings.click();
    await expect(accountPanel).toHaveCount(0);
    await expect(dialog).toBeVisible();
    await expect(dialog).not.toHaveAttribute('aria-modal', 'true');
    await expect(settings).toHaveAttribute('aria-expanded', 'true');
    const settingsStyle = await dialog.evaluate(el => {
      const s = getComputedStyle(el);
      return [s.backgroundColor, s.color, s.borderColor, s.borderRadius, s.boxShadow, s.fontSize];
    });
    expect(settingsStyle).toEqual(accountStyle);
    const anchor = (await settings.boundingBox())!;
    const panel = (await dialog.boundingBox())!;
    expect(panel.y).toBeCloseTo(anchor.y + anchor.height + 4, 0);
    expect(panel.x + panel.width).toBeCloseTo(anchor.x + anchor.width, 0);
    await dialog.screenshot({ path: testInfo.outputPath(`order-settings-${theme}.png`) });
    await dialog.getByRole('spinbutton', { name: '수량 프리셋 1', exact: true }).fill('29');
    await settings.click();
    await expect(dialog).toHaveCount(0);
    await expect(settings).toHaveAttribute('aria-expanded', 'false');
    await settings.click();
    await expect(dialog.getByRole('spinbutton', { name: '수량 프리셋 1', exact: true })).toHaveValue('10');
    await dialog.getByRole('spinbutton', { name: '수량 프리셋 1', exact: true }).fill('31');
    await window.getByLabel('매수 가능 금액').click();
    await expect(dialog).toHaveCount(0);
    await settings.click();
    await expect(dialog.getByRole('spinbutton', { name: '수량 프리셋 1', exact: true })).toHaveValue('10');
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(settings).toBeFocused();
  }
  await page.setViewportSize({ width: 320, height: 640 });
  await settings.scrollIntoViewIfNeeded();
  await settings.click();
  await expect(dialog).toBeVisible();
  const bounds = (await dialog.boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(320);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(640);
  const layout = await dialog.getByRole('spinbutton').evaluateAll(inputs => inputs.map(input => {
    const bounds = input.getBoundingClientRect();
    const field = input.parentElement!.getBoundingClientRect();
    return bounds.left >= field.left && bounds.right <= field.right && bounds.width > 0
      && input.scrollWidth <= input.clientWidth;
  }));
  expect(layout).toEqual(Array(6).fill(true));
  await page.screenshot({ path: testInfo.outputPath('order-settings-anchored-narrow.png') });
  await page.setViewportSize({ width: 320, height: 360 });
  await expect(dialog.getByRole('button', { name: '적용', exact: true })).toBeInViewport();
  await expect(dialog.getByRole('button', { name: '취소', exact: true })).toBeInViewport();
  await expect.poll(() => dialog.locator('.order-settings-body').evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
  await dialog.screenshot({ path: testInfo.outputPath('order-settings-short-viewport.png') });
  await dialog.getByRole('button', { name: '주문 설정 닫기' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(settings).toBeFocused();
  expect(commands).toHaveLength(0);
});

test('주문 설정 적용·취소와 백만원 금액을 클릭 호가의 정수 수량으로 환산', async ({ page }, testInfo) => {
  const { window, commands } = await setup(page);
  const settings = window.getByRole('button', { name: '주문 설정', exact: true });
  const frame = page.locator('[data-win]').filter({ has: window });
  const bounds = await frame.boundingBox();
  await settings.click();
  const dialog = page.getByRole('dialog', { name: '주문 설정', exact: true });
  await expect(dialog.getByText('주문 방식', { exact: true })).toHaveCount(0);
  await expect(dialog.getByRole('radio')).toHaveCount(0);
  await expect(dialog.getByText(/^프리셋 [123]$/)).toHaveCount(0);
  await expect(dialog.getByText(/100만원|500만원|1,000만원/)).toHaveCount(0);
  await expect(dialog.getByText('주', { exact: true })).toHaveCount(3);
  await expect(dialog.getByText('백만원', { exact: true })).toHaveCount(3);
  await dialog.getByRole('spinbutton', { name: '수량 프리셋 1', exact: true }).fill('25');
  await dialog.getByRole('button', { name: '취소', exact: true }).click();
  await expect(window.getByRole('spinbutton', { name: '신규 주문 수량' })).toHaveValue('10');
  await settings.click();
  await expect(dialog.getByRole('spinbutton', { name: '수량 프리셋 1', exact: true })).toHaveValue('10');
  for (const [index, value] of [25, 75, 250].entries()) await dialog.getByRole('spinbutton', { name: `수량 프리셋 ${index + 1}`, exact: true }).fill(String(value));
  for (const [index, value] of [2, 6, 12].entries()) await dialog.getByRole('spinbutton', { name: `금액 프리셋 ${index + 1}`, exact: true }).fill(String(value));
  await dialog.getByRole('spinbutton', { name: '금액 프리셋 1', exact: true }).fill('1.5');
  await expect(dialog.getByRole('button', { name: '적용', exact: true })).toBeDisabled();
  await dialog.getByRole('spinbutton', { name: '금액 프리셋 1', exact: true }).fill('2');
  await page.screenshot({ path: testInfo.outputPath('order-settings-dialog.png') });
  await dialog.getByRole('button', { name: '적용', exact: true }).click();
  await expect(settings).toBeFocused();
  await window.getByRole('button', { name: '금액', exact: true }).click();
  await expect(window.getByRole('spinbutton', { name: '신규 주문 금액' })).toHaveValue('2');
  await window.getByRole('button', { name: '600만', exact: true }).click();
  await expect(window.getByLabel('예상 주문 수량').locator('.order-field-value')).toHaveText('89주');
  const buy = window.getByRole('button', { name: /매수 68,200원 주문 추가/ });
  await buy.hover();
  await expect(window.getByLabel('예상 주문 수량').locator('.order-field-value')).toHaveText('87주');
  await buy.dblclick();
  await expect(window.getByLabel('매수 68,200원 주문', { exact: true })).toHaveText('87');
  expect(commands[0]).toMatchObject({ side: 'BUY', price: 68200, quantity: 87 });
  await settings.click();
  await dialog.getByRole('spinbutton', { name: '수량 프리셋 1', exact: true }).fill('30');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(frame.getByRole('button', { name: '원래 크기로 복원', exact: true })).toBeVisible();
  expect(await frame.boundingBox()).toEqual(bounds);
  await expect(window.getByRole('spinbutton', { name: '신규 주문 금액' })).toHaveValue('6');
  await window.screenshot({ path: testInfo.outputPath('order-amount-controls.png') });
});

test('평단가 표시 체크박스는 적용 후 저장하며 다른 주문 창에는 영향을 주지 않는다', async ({ page }, testInfo) => {
  const { commands } = await setup(page, false, false, false, 0, 1, { averagePrice: '67000.1' });
  const first = page.getByTestId('order-window').first();
  const settings = first.getByRole('button', { name: '주문 설정', exact: true });
  const dialog = page.getByRole('dialog', { name: '주문 설정', exact: true });
  const checkbox = dialog.getByRole('checkbox', { name: '내 평단가 표시', exact: true });
  await expect(first.locator('.order-average-marker')).toHaveCount(1);
  await settings.click();
  await expect(checkbox).toBeChecked();
  for (const theme of ['toss-light', 'toss-dark']) {
    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
    await dialog.screenshot({ path: testInfo.outputPath(`order-average-settings-${theme}.png`) });
  }
  await checkbox.focus();
  await page.keyboard.press('Space');
  await expect(checkbox).not.toBeChecked();
  await expect(first.locator('.order-average-marker')).toHaveCount(1);
  await dialog.getByRole('button', { name: '취소', exact: true }).click();
  await settings.click();
  await expect(checkbox).toBeChecked();
  await checkbox.uncheck();
  await dialog.getByRole('button', { name: '적용', exact: true }).click();
  await expect(first.locator('.order-average-marker')).toHaveCount(0);
  await expect(first.getByLabel('매입평단가')).toContainText('67,001');
  await page.reload();
  await expect(first.getByLabel('매입평단가')).toContainText('67,001');
  await expect(first.locator('.order-average-marker')).toHaveCount(0);
  await settings.click();
  await expect(checkbox).not.toBeChecked();
  await dialog.getByRole('button', { name: '취소', exact: true }).click();
  await page.getByTestId('workspace-add-menu-button').click();
  await page.getByTestId('workspace-add-order').click();
  const second = page.getByTestId('order-window').nth(1);
  await expect(second.locator('.order-average-marker')).toHaveCount(1);
  await second.getByRole('button', { name: '주문 설정', exact: true }).click();
  await expect(checkbox).toBeChecked();
  await dialog.getByRole('button', { name: '취소', exact: true }).click();
  await page.locator('[data-win]').filter({ has: page.getByTestId('order-window') }).nth(1)
    .getByRole('button', { name: '삼성전자 호가 주문 창 닫기', exact: true }).click();
  await settings.click();
  await checkbox.check();
  await dialog.getByRole('button', { name: '적용', exact: true }).click();
  await expect(first.locator('.order-average-marker')).toHaveCount(1);
  expect(commands).toHaveLength(0);
});

test('주문 방식·프리셋은 새로고침 후 유지하고 다른 주문창과 독립적이다', async ({ page }) => {
  const { window } = await setup(page);
  await window.getByRole('button', { name: '금액', exact: true }).click();
  await window.getByRole('button', { name: '주문 설정', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '주문 설정', exact: true });
  await dialog.getByRole('spinbutton', { name: '수량 프리셋 1', exact: true }).fill('25');
  await dialog.getByRole('spinbutton', { name: '금액 프리셋 1', exact: true }).fill('2');
  await dialog.getByRole('button', { name: '적용', exact: true }).click();
  await page.reload();
  await expect(window.getByRole('spinbutton', { name: '신규 주문 금액' })).toHaveValue('2');
  await expect(window.getByRole('button', { name: '200만', exact: true })).toBeVisible();
  await window.getByRole('button', { name: '주문 설정', exact: true }).click();
  await expect(dialog.getByRole('radio')).toHaveCount(0);
  await expect(window.getByRole('button', { name: '금액', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(dialog.getByRole('spinbutton', { name: '수량 프리셋 1', exact: true })).toHaveValue('25');
  await dialog.getByRole('button', { name: '취소', exact: true }).click();
  const restore = page.locator('[data-win]').filter({ has: window }).getByRole('button', { name: '원래 크기로 복원', exact: true });
  if (await restore.count()) await restore.click();
  await page.getByTestId('workspace-add-menu-button').click();
  await page.getByTestId('workspace-add-order').click();
  const second = page.getByTestId('order-window').nth(1);
  await expect(second.getByRole('spinbutton', { name: '신규 주문 수량' })).toHaveValue('10');
  await expect(page.getByTestId('order-window').first().getByRole('spinbutton', { name: '신규 주문 금액' })).toHaveValue('2');
  await second.getByRole('button', { name: '주문 설정', exact: true }).click();
  await dialog.getByRole('spinbutton', { name: '수량 프리셋 1', exact: true }).fill('30');
  await dialog.getByRole('button', { name: '적용', exact: true }).click();
  await expect(second.getByRole('spinbutton', { name: '신규 주문 수량' })).toHaveValue('30');
  await expect(page.getByTestId('order-window').first().getByRole('button', { name: '200만', exact: true })).toBeVisible();
});

test('드래그 주문이 커서를 따라 떠다니며 정정 호가·드래그 아웃 취소를 표시한다', async ({ page }, testInfo) => {
  const { window, commands } = await setup(page, true);
  const original = window.getByLabel('매수 67,200원 주문', { exact: true });
  await expect(original).toHaveText('70');
  const source = (await original.boundingBox())!;
  const preview = page.getByRole('status', { name: '주문 드래그 미리보기' });
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
  await page.mouse.down();
  await page.mouse.move(source.x + source.width / 2 + 3, source.y + source.height / 2);
  await expect(preview).toHaveCount(0);
  const destination = window.getByRole('button', { name: /매수 67,000원 주문 추가/ });
  const target = (await destination.boundingBox())!;
  const x = target.x + target.width / 2, y = target.y + target.height / 2;
  await page.mouse.move(x, y, { steps: 12 });
  await expect(preview).toHaveText('70');
  await expect(preview).toHaveCSS('pointer-events', 'none');
  expect(await preview.evaluate(el => getComputedStyle(el).fontSize)).toBe(await original.evaluate(el => getComputedStyle(el).fontSize));
  await expect(original).toHaveCSS('opacity', '0.35');
  await expect(destination).toHaveClass(/order-drag-destination/);
  expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-order-price]')?.dataset.orderPrice, { x, y })).toBe('67000');
  expect(commands).toHaveLength(0);
  await page.screenshot({ path: testInfo.outputPath('order-drag-modify.png') });
  const before = (await preview.boundingBox())!;
  // A movement within the same target row must still move the preview (no state change).
  await page.mouse.move(x, y + 3);
  expect((await preview.boundingBox())!.y).toBeGreaterThan(before.y);
  await page.mouse.up();
  const moved = window.getByLabel('매수 67,000원 주문', { exact: true });
  await expect(moved).toBeVisible();
  await expect(preview).toHaveCount(0);
  await expect(moved).toHaveCSS('opacity', '1');
  expect(commands[0]).toMatchObject({ price: 67000, quantity: null });
  await expect(window.getByRole('group', { name: '주문 확인' })).toHaveCount(0);
  const movedBox = (await moved.boundingBox())!;
  const outside = (await window.getByRole('button', { name: '주문 설정', exact: true }).boundingBox())!;
  await page.mouse.move(movedBox.x + movedBox.width / 2, movedBox.y + movedBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(outside.x + outside.width / 2, outside.y + outside.height / 2, { steps: 12 });
  await expect(preview).toHaveText('70');
  await expect(preview).toHaveClass(/order-drag-preview-cancel/);
  await expect(preview).toHaveCSS('border-top-style', 'dashed');
  await expect(window.locator('.order-drag-destination')).toHaveCount(0);
  expect(commands).toHaveLength(1);
  await page.screenshot({ path: testInfo.outputPath('order-drag-cancel.png') });
  await page.mouse.up();
  await expect(preview).toHaveCount(0);
  await expect(window.locator('[data-drag-order]')).toHaveCount(0);
  expect(commands).toHaveLength(2);
});


test('주문 창은 모의투자 UI와 시세 기준 라벨 없이 항상 실계좌를 조회한다', async ({ page }) => {
  const tradingRequests: string[] = [];
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (/^\/api\/(?:paper-)?trading\//.test(path)) tradingRequests.push(path);
  });
  const { window } = await setup(page);
  await expect(window.getByRole('combobox', { name: '주문 모드' })).toHaveCount(0);
  await expect(window.getByRole('button', { name: '모의 계좌 설정' })).toHaveCount(0);
  await expect(window.getByLabel('시세·주문 기준')).toHaveCount(0);
  await expect(window.getByText('토스증권 · ****1234', { exact: true })).toBeVisible();
  expect(tradingRequests).toContain('/api/trading/accounts');
  expect(tradingRequests).toContain('/api/trading/state');
  expect(tradingRequests.some(path => path.startsWith('/api/paper-trading/'))).toBe(false);
});

test('호가 경계 1px 밖 드롭은 즉시 취소하고 Esc로 중단할 수 있다', async ({ page }) => {
  const { window, commands } = await setup(page, true);
  const chip = window.getByLabel('매수 67,200원 주문', { exact: true });
  const a = await chip.boundingBox(), bounds = await window.locator('.order-ladder').boundingBox();
  expect(a).not.toBeNull(); expect(bounds).not.toBeNull();
  const x = a!.x + a!.width / 2, y = a!.y + a!.height / 2;
  await page.mouse.move(x, y); await page.mouse.down();
  await page.mouse.move(bounds!.x + bounds!.width + 1, y, { steps: 8 });
  expect(commands).toHaveLength(0);
  await expect(window.locator('.order-cancel-active')).toHaveCount(1);
  await expect(page.getByRole('status', { name: '주문 드래그 미리보기' })).toHaveText('70');
  await expect(page.getByRole('status', { name: '주문 드래그 미리보기' })).toHaveClass(/order-drag-preview-cancel/);
  await page.keyboard.press('Escape'); await page.mouse.up();
  await expect(page.getByRole('status', { name: '주문 드래그 미리보기' })).toHaveCount(0);
  await expect(window.locator('.order-drag-destination,.order-cancel-active')).toHaveCount(0);
  await expect(chip).toHaveCSS('opacity', '1');
  expect(commands).toHaveLength(0);
  expect(await window.locator('.order-ladder').boundingBox()).toEqual(bounds);
  await expect(chip).toHaveText('70');
  await page.mouse.move(x, y); await page.mouse.down();
  await page.mouse.move(bounds!.x + bounds!.width + 1, y, { steps: 8 });
  expect(commands).toHaveLength(0);
  await page.mouse.up();
  await expect(window.locator('[data-drag-order]')).toHaveCount(0);
  expect(commands).toHaveLength(1);
  await expect(window.getByRole('group', { name: '주문 확인' })).toHaveCount(0);
});


test('시간외종가의 잔량은 정규장 잔량이 0이어도 두 호가창에 함께 갱신된다', async ({ page }) => {
  const time = Date.UTC(2026, 9, 14, 6, 47); // 15:47 KST
  await page.clock.install({ time });
  const { window, ws, commands } = await setup(page, false, true, false, 0, 1, { time, venue: 'KRX' });
  const book = page.locator('.book-panel');
  await ws.waitForSubscribe('005930');
  ws.pushLive('005930', { kind: 'ob', venue: 'KRX', t_ms: time + 1,
    asks: [{ price: 67300, qty: 0 }], bids: [{ price: 67200, qty: 0 }],
    total_ask_qty: 0, total_bid_qty: 0 });
  await expect(window.getByLabel('매도총잔량 0', { exact: true })).toBeVisible();
  const connections = ws.connectionCount();
  await page.clock.fastForward(65_000);
  // Advancing past the heartbeat watchdog reconnects the mocked socket.
  await expect.poll(ws.connectionCount).toBeGreaterThan(connections);
  await ws.waitForSubscribe('005930');
  for (const [index, ask, bid] of [[0, 879, 538], [1, 0, 620]] as const) {
    ws.pushLive('005930', { kind: 'ah', venue: 'KRX', t_ms: time + 65_000 + index,
      total_ask_qty: ask, total_bid_qty: bid });
    for (const panel of [window, book]) {
      const strip = panel.getByTestId('book-total-strip');
      await expect(strip).toHaveText(`${ask}마지막 수신 · 15:47:00${bid}`);
      await expect(strip.getByTestId('book-total-fill')).toBeVisible();
      expect(await strip.getByTestId('book-total-fill').evaluate(el => (el as HTMLElement).style.gridTemplateColumns)).toBe(`${ask}fr ${bid}fr`);
    }
  }
  expect(commands).toHaveLength(0);
});

test('예상 체결가·체결량은 10호가창과 주문창에 함께 표시되고 빈 호가는 제거된다', async ({ page }, testInfo) => {
  const { window, ws, commands } = await setup(page);
  const book = page.locator('.book-panel'); // 기본 배치의 10호가창과 비교
  await expect(book).toHaveCount(1);
  await ws.waitForSubscribe('005930');
  const frame = { kind: 'ob', venue: 'UN', t_ms: Date.now(),
    asks: [241000, 241500, 242000, 242500].map(price => ({ price, qty: 100 })),
    bids: [241000, 240500, 240000].map(price => ({ price, qty: 200 })),
    total_ask_qty: 400, total_bid_qty: 600, expected_price: 241000, expected_qty: 6140 };
  ws.pushLive('005930', frame);
  for (const panel of [window, book]) {
    const banner = panel.getByTestId('book-expected-fill');
    await expect(banner).toHaveText('예상 체결가241,000원예상 체결량6,140');
    await expect(banner).toBeVisible();
  }
  await expect(window.locator('[data-order-price]')).toHaveCount(7);
  await expect(window.locator('.order-ask')).toHaveCount(4);
  await expect(window.locator('.order-bid')).toHaveCount(3);
  await expect(window.locator('.order-divider')).toHaveAttribute('data-order-price', '241000');
  await expect(window.locator('[data-order-price="0"]')).toHaveCount(0);
  for (const width of [640, 360]) {
    await window.evaluate((el, width) => { (el as HTMLElement).style.width = `${width}px`; el.scrollLeft = 0; }, width);
    const banner = window.getByTestId('book-expected-fill');
    await expect(banner.getByText('241,000원', { exact: true })).toBeInViewport();
    await expect(banner.getByText('6,140', { exact: true })).toBeInViewport();
    expect(await banner.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  }
  await window.screenshot({ path: testInfo.outputPath('order-expected-fill.png') });
  ws.pushLive('005930', { ...frame, t_ms: frame.t_ms + 1, expected_price: 0, expected_qty: 0 });
  for (const panel of [window, book]) await expect(panel.getByTestId('book-expected-fill')).toHaveCount(0);
  expect(commands).toHaveLength(0);
});

test('호가 주문 가격·잔량·총잔량 폰트는 기존 10호가창과 동일하다', async ({ page }) => {
  const { window } = await setup(page);
  await page.getByTestId('workspace-add-menu-button').click();
  await page.getByTestId('workspace-add-book').click();
  const book = page.locator('.book-panel');
  await expect(book.locator('.font-data.text-base').first()).toBeAttached();
  const dataFont = await book.locator('.font-data.text-base').first().evaluate(el => getComputedStyle(el).fontSize);
  const metaFont = await book.locator('.text-xs').first().evaluate(el => getComputedStyle(el).fontSize);
  for (const selector of ['.order-price > span', '.order-depth > span', '.order-info > span:last-child', '[data-testid="book-total-strip"] .font-data']) {
    expect(await window.locator(selector).first().evaluate(el => getComputedStyle(el).fontSize)).toBe(dataFont);
  }
  expect(await window.locator('.order-meta').first().evaluate(el => getComputedStyle(el).fontSize)).toBe(metaFont);
  await expect(window.getByLabel('매도총잔량 1,000')).toHaveText('1,000');
  await expect(window.getByLabel('매수총잔량 2,000')).toHaveText('2,000');
  await expect(window.getByTestId('book-total-fill')).toHaveCSS('height', '4px');
});

test('넓은 창은 상세 정보를 직접 표시하고 기본·압축·스크롤에서는 정보 버튼으로 전환한다', async ({ page }, testInfo) => {
  const { window, commands } = await setup(page, false, true, true);
  const controls = window.locator('.order-quantity-controls');
  const originalHeight = (await controls.boundingBox())!.height;
  const baseFont = await window.locator('.order-price > span').first().evaluate(el => getComputedStyle(el).fontSize);
  for (const width of [800, 696, 695, 584, 576, 568, 560, 559, 504, 503, 360]) {
    await window.evaluate((el, nextWidth) => { (el as HTMLElement).style.width = `${nextWidth}px`; el.scrollLeft = 0; }, width);
    if (width < 560) await expect(window).toHaveClass(/order-compact/);
    else await expect(window).not.toHaveClass(/order-compact/);
    await expect(window.locator('.order-depth')).toHaveCount(20);
    expect(await window.locator('.order-row').first().evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length)).toBe(5);
    if (width >= 504) await expect.poll(async () => (await controls.boundingBox())!.height).toBe(originalHeight);
    expect(await window.locator('.order-price > span').first().evaluate(el => getComputedStyle(el).fontSize)).toBe(baseFont);
    const fields = [window.getByRole('spinbutton', { name: '신규 주문 수량' }), window.getByRole('button', { name: '50주', exact: true }), window.getByLabel('예상 주문 금액')];
    const boxes = await Promise.all(fields.map(field => field.boundingBox()));
    if (width >= 504) for (const box of boxes) expect(box!.y + box!.height / 2).toBeCloseTo(boxes[0]!.y + boxes[0]!.height / 2, 0);
    expect(await window.evaluate(el => el.scrollWidth > el.clientWidth)).toBe(width < 504);
    const ask = window.locator('.order-ask').last();
    const bid = window.locator('.order-bid').first();
    const askBox = (await ask.boundingBox())!, bidBox = (await bid.boundingBox())!;
    expect(askBox.width).toBeCloseTo(bidBox.width, 3);
    const barWidth = (field: Locator) => field.evaluate(el => parseFloat(getComputedStyle(el, '::before').width));
    expect(await barWidth(ask)).toBeGreaterThan(0);
    expect(await barWidth(ask)).toBeCloseTo(await barWidth(bid), 3);
    expect(await ask.evaluate(el => getComputedStyle(el, '::before').right)).toBe('3px');
    expect(await bid.evaluate(el => getComputedStyle(el, '::before').left)).toBe('3px');
    const rowBox = (await window.locator('.order-row').first().boundingBox())!;
    const priceBox = (await window.locator('.order-price').first().boundingBox())!;
    expect(priceBox.x + priceBox.width / 2).toBeCloseTo(rowBox.x + rowBox.width / 2, 2);
    const info = window.getByRole('button', { name: '종목 상세 정보', exact: true });
    const usableWidth = await window.locator('.order-scroll').evaluate(el => el.clientWidth);
    if (width >= 560 && usableWidth >= 560) {
      await expect(window).toHaveClass(/order-expanded/);
      await expect(info).toHaveCount(0);
      const summary = window.getByTestId('book-summary');
      await expect(summary.getByText('250일', { exact: true })).toBeVisible();
      await expect(summary.getByText('1,578,000/1,425,000', { exact: true })).toBeVisible();
      expect(await summary.evaluate(el => [...el.querySelectorAll('.book-summary > div:not(.book-summary-extra), .book-summary-extra > div')].every(row => {
        const spans = [...row.children].map(child => child.getBoundingClientRect());
        const r = row.getBoundingClientRect();
        return spans.length === 2 && spans[0].right <= spans[1].left && spans[1].right <= r.right + 0.5;
      }))).toBe(true);
      const summaryBox = (await summary.boundingBox())!;
      const firstSlot = (await window.locator('.order-summary-slot').first().boundingBox())!;
      const firstRow = (await window.locator('.order-row').first().boundingBox())!;
      const lastRow = (await window.locator('.order-row').nth(9).boundingBox())!;
      expect(summaryBox.x).toBeCloseTo(firstSlot.x, 1);
      expect(summaryBox.width).toBeCloseTo(firstSlot.width, 1);
      expect(summaryBox.y).toBeCloseTo(firstRow.y, 1);
      expect(summaryBox.y + summaryBox.height).toBeCloseTo(lastRow.y + lastRow.height, 1);
      await window.screenshot({ path: testInfo.outputPath(`responsive-order-${width}px.png`) });
      continue;
    }
    await expect(window).not.toHaveClass(/order-expanded/);
    await expect(window.getByTestId('book-summary')).toHaveCount(0);
    await info.click();
    const popup = page.getByRole('dialog', { name: '종목 상세 정보', exact: true });
    await expect(popup.getByTestId('book-summary').getByText('250일', { exact: true })).toBeVisible();
    await expect(popup.getByRole('button', { name: '종목 정보 닫기' })).toBeFocused();
    const rect = (await popup.boundingBox())!;
    expect(rect.x).toBeGreaterThanOrEqual(0);
    expect(rect.x + rect.width).toBeLessThanOrEqual(1440);
    await window.screenshot({ path: testInfo.outputPath(`responsive-order-${width}px.png`) });
    await page.keyboard.press('Escape');
    await expect(popup).toHaveCount(0);
    await expect(info).toBeFocused();
    await info.click();
    await page.mouse.click(1436, 1096);
    await expect(popup).toHaveCount(0);
  }
  await window.getByRole('button', { name: '종목 상세 정보', exact: true }).click();
  await window.evaluate(el => { (el as HTMLElement).style.width = '800px'; });
  await expect(window).toHaveClass(/order-expanded/);
  await expect(window.getByRole('button', { name: '종목 상세 정보', exact: true })).toHaveCount(0);
  await expect(window.getByTestId('book-summary')).toBeVisible();
  await expect(page.getByRole('dialog', { name: '종목 상세 정보', exact: true })).toHaveCount(0);
  await window.evaluate(el => { (el as HTMLElement).style.width = '360px'; el.scrollLeft = el.scrollWidth; });
  await expect(window).toHaveClass(/order-compact/);
  await window.evaluate(el => { el.scrollLeft = el.scrollWidth; });
  await expect(window.getByRole('button', { name: /매수 67,200원 주문 추가/ })).toBeInViewport();
  await window.getByRole('button', { name: /매수 67,200원 주문 추가/ }).dblclick();
  const chip = window.getByLabel('매수 67,200원 주문', { exact: true });
  await expect(chip).toBeVisible();
  expect(commands[0]).toMatchObject({ side: 'BUY', price: 67200, quantity: 10 });
  const chipBox = (await chip.boundingBox())!, windowBox = (await window.boundingBox())!;
  const y = chipBox.y + chipBox.height / 2;
  await page.mouse.move(chipBox.x + chipBox.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(windowBox.x - 1, y, { steps: 8 });
  await page.mouse.up();
  await expect(window.locator('[data-drag-order]')).toHaveCount(0);
  expect(commands).toHaveLength(2);
});

test('같은 가격 칸의 드래그 아웃은 그 가격의 주문만 모두 취소한다', async ({ page }) => {
  const { window, commands } = await setup(page, [mkOrder('one'), mkOrder('two'), mkOrder('other', '67100')]);
  const cell = window.getByRole('button', { name: /매수 67,200원 주문 추가/ });
  await expect(cell).toHaveText('140');
  await cell.click();
  expect(commands).toHaveLength(0);
  await drag(page, cell, window.getByRole('button', { name: '주문 설정', exact: true }));
  await expect(cell).toBeEmpty();
  await expect(window.getByRole('button', { name: /매수 67,100원 주문 추가/ })).toHaveText('70');
  expect(commands).toHaveLength(2);
  expect(commands.every(body => !('price' in body))).toBe(true);
});

test('같은 가격의 여러 주문은 다른 호가로 모두 함께 정정한다', async ({ page }) => {
  const { window, commands } = await setup(page, [mkOrder('one'), mkOrder('two'), mkOrder('other', '67000')]);
  const cell = window.getByRole('button', { name: /매수 67,200원 주문 추가/ });
  const destination = window.getByRole('button', { name: /매수 67,100원 주문 추가/ });
  await drag(page, cell, destination);
  await expect(cell).toBeEmpty();
  await expect(destination).toHaveText('140');
  await expect(window.getByRole('button', { name: /매수 67,000원 주문 추가/ })).toHaveText('70');
  expect(commands).toHaveLength(2);
  expect(commands.every(body => body.price === 67100 && body.quantity === null)).toBe(true);
});

test('묶음 정정은 합산 금액의 고액 확인을 거쳐 모든 주문에 적용한다', async ({ page }) => {
  const large = ['one', 'two'].map(id => ({ ...mkOrder(id, '67200', '0'), quantity: '800' }));
  const { window, commands } = await setup(page, large);
  const cell = window.getByRole('button', { name: /매수 67,200원 주문 추가/ });
  const destination = window.getByRole('button', { name: /매수 67,100원 주문 추가/ });
  await drag(page, cell, destination);
  const confirmation = page.getByRole('dialog', { name: '고액 주문 확인' });
  await expect(confirmation).toContainText('1,600주');
  expect(commands).toHaveLength(0);
  await expect(confirmation.getByRole('button', { name: '확인 후 주문' })).toBeDisabled();
  await confirmation.getByRole('checkbox', { name: '1억원 이상 주문 금액을 확인했습니다' }).check();
  await confirmation.getByRole('button', { name: '확인 후 주문' }).click();
  await expect(destination).toHaveText('1,600');
  expect(commands).toHaveLength(2);
  expect(commands.every(body => body.price === 67100 && body.confirm_high_value === true)).toBe(true);
});

test('묶음 취소 일부 실패는 성공한 주문을 다시 보내지 않고 실패 요청만 같은 ID로 재시도한다', async ({ page }) => {
  const { window, commands } = await setup(page, [mkOrder('one'), mkOrder('two')]);
  const failures: Record<string, unknown>[] = [];
  await page.route(/\/api\/trading\/orders\/two\/cancel$/, async route => {
    if (failures.length) { await route.fallback(); return; }
    failures.push(route.request().postDataJSON());
    await route.fulfill({ status: 409, json: { detail: { code: 'cancel-rejected', message: '취소 거절' } } });
  });
  const cell = window.getByRole('button', { name: /매수 67,200원 주문 추가/ });
  await drag(page, cell, window.getByRole('button', { name: '주문 설정', exact: true }));
  await expect(cell).toHaveText('70');
  await expect(page.getByRole('alert', { name: '주문 알림' })).toContainText('취소 미접수 1건');
  expect(commands).toHaveLength(1);
  const retry = page.getByRole('button', { name: '같은 요청 다시 확인' });
  await expect(retry).toBeEnabled();
  await retry.click();
  await expect(cell).toBeEmpty();
  expect(commands).toHaveLength(2);
  expect(commands[1].command_id).toBe(failures[0].command_id);
});

for (const side of ['BUY', 'SELL'] as const) {
  test(`${side} 우클릭 목록의 개별 주문은 다른 호가로 드래그하면 그 가격으로 정정한다`, async ({ page }) => {
    const price = side === 'BUY' ? 67200 : 67300;
    const destinationPrice = side === 'BUY' ? 66300 : 68200;
    const label = side === 'BUY' ? '매수' : '매도';
    const orderId = `one-${'long-order-id-'.repeat(8)}`;
    const { window, commands } = await setup(page, [
      { ...mkOrder(orderId, String(price)), side },
      { ...mkOrder('two', String(price)), side },
      { ...mkOrder('other', String(destinationPrice)), side },
    ], false);
    const paths: string[] = [];
    page.on('request', request => {
      if (request.method() === 'POST' && new URL(request.url()).pathname.startsWith('/api/trading/orders/'))
        paths.push(new URL(request.url()).pathname);
    });
    const cell = window.getByRole('button', { name: new RegExp(`${label} ${price.toLocaleString('ko-KR')}원 주문 추가`) });
    const cellBox = (await cell.boundingBox())!;
    await cell.click({ button: 'right', position: { x: cellBox.width - 1, y: cellBox.height - 1 } });
    const menu = page.getByRole('menu', { name: `${label} ${price.toLocaleString('ko-KR')}원 주문 목록` });
    const first = menu.getByRole('menuitem', { name: '주문 1 · 70주', exact: true });
    await expect(menu.getByRole('menuitem')).toHaveText(['주문 170', '주문 270']);
    await expect(menu).toContainText('총 140');
    // Staying inside the list or returning to the original price sends no command.
    await drag(page, first, menu.getByRole('menuitem', { name: '주문 2 · 70주', exact: true }));
    await expect(menu).toBeVisible();
    expect(commands).toHaveLength(0);
    await drag(page, first, cell);
    await expect(menu).toBeVisible();
    expect(commands).toHaveLength(0);
    const destination = window.getByRole('button', { name: new RegExp(`${label} ${destinationPrice.toLocaleString('ko-KR')}원 주문 추가`) });
    await drag(page, first, destination);
    await expect(menu).toHaveCount(0);
    await expect(cell).toHaveText('70');
    await expect(destination).toHaveText('140');
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ price: destinationPrice, quantity: null });
    expect(paths).toEqual([`/api/trading/orders/${encodeURIComponent(orderId)}/modify`]);
  });
}

test('가격 칸의 우클릭 목록에서 한 주문을 호가 밖으로 드래그하면 그 주문만 취소한다', async ({ page }, testInfo) => {
  const { window, commands } = await setup(page, [mkOrder('one'), mkOrder('two'), mkOrder('other', '67100')], false);
  const cell = window.getByRole('button', { name: /매수 67,200원 주문 추가/ });
  await cell.click({ button: 'right' });
  const menu = page.getByRole('menu', { name: '매수 67,200원 주문 목록' });
  await expect(menu.getByRole('menuitem')).toHaveCount(2);
  const first = menu.getByRole('menuitem', { name: '주문 1 · 70주', exact: true });
  await first.click();
  expect(commands).toHaveLength(0);
  await page.screenshot({ path: testInfo.outputPath('order-price-list.png') });
  await expect(menu.getByRole('menuitem')).toHaveText(['주문 170', '주문 270']);
  await expect(menu).toContainText('총 140');
  // Releasing outside both the list and the ladder cancels only this order.
  await drag(page, first, window.getByRole('button', { name: '주문 설정', exact: true }));
  await expect(menu).toHaveCount(0);
  await expect(cell).toHaveText('70');
  await expect(window.getByRole('button', { name: /매수 67,100원 주문 추가/ })).toHaveText('70');
  expect(commands).toHaveLength(1);
  expect(commands[0]).toEqual({ account_seq: 1, code: '005930', command_id: expect.any(String) });
  await cell.click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: '주문 1 · 70주', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
  expect(commands).toHaveLength(1);
});

test('호가 밖 주문도 드래그로 사다리에 정정하고 밖으로 끌어 즉시 취소한다', async ({ page }) => {
  const { window, commands } = await setup(page, [mkOrder('outside', '70000')]);
  const outside = window.getByRole('button', { name: '호가 밖 매수 70,000원 주문', exact: true });
  await outside.click();
  await expect(window.getByRole('group', { name: '주문 확인' })).toHaveCount(0);
  expect(commands).toHaveLength(0);
  await drag(page, outside, window.getByRole('button', { name: /매수 67,200원 주문 추가/ }));
  const moved = window.getByLabel('매수 67,200원 주문', { exact: true });
  await expect(moved).toHaveText('70');
  expect(commands[0]).toMatchObject({ price: 67200, quantity: null });
  await drag(page, moved, window.getByRole('button', { name: '주문 설정', exact: true }));
  await expect(window.locator('[data-drag-order]')).toHaveCount(0);
  expect(commands).toHaveLength(2);
});

test('고액 실계좌 신규·드래그 정정의 기존 확인은 입력창 없이 팝업에서 유지한다', async ({ page }) => {
  const { window, commands } = await setup(page);
  await window.getByRole('spinbutton', { name: '신규 주문 수량' }).fill('2000');
  await window.getByRole('button', { name: /매수 67,200원 주문 추가/ }).dblclick();
  const confirmation = page.getByRole('dialog', { name: '고액 주문 확인' });
  await expect(confirmation).toBeVisible();
  await expect(confirmation.getByRole('spinbutton')).toHaveCount(0);
  expect(commands).toHaveLength(0);
  await confirmation.getByRole('checkbox', { name: '1억원 이상 주문 금액을 확인했습니다' }).check();
  await confirmation.getByRole('button', { name: '확인 후 주문' }).click();
  const original = window.getByLabel('매수 67,200원 주문', { exact: true });
  await expect(original).toHaveText('2,000');
  expect(commands[0]).toMatchObject({ confirm_high_value: true });
  await drag(page, original, window.getByRole('button', { name: /매수 67,100원 주문 추가/ }));
  await expect(confirmation).toBeVisible();
  await expect(confirmation.getByRole('spinbutton')).toHaveCount(0);
  expect(commands).toHaveLength(1);
  await confirmation.getByRole('checkbox', { name: '1억원 이상 주문 금액을 확인했습니다' }).check();
  await confirmation.getByRole('button', { name: '확인 후 주문' }).click();
  const moved = window.getByLabel('매수 67,100원 주문', { exact: true });
  await expect(moved).toHaveText('2,000');
  expect(commands[1]).toMatchObject({ price: 67100, quantity: null, confirm_high_value: true });
  await drag(page, moved, window.getByRole('button', { name: '주문 설정', exact: true }));
  await expect(confirmation).toHaveCount(0);
  await expect(window.locator('[data-drag-order]')).toHaveCount(0);
  expect(commands).toHaveLength(3);
});

test('넓은 창의 상세 정보 위로 드래그해도 해당 호가로 정정한다', async ({ page }) => {
  const { window, commands } = await setup(page, true);
  await expect(window).toHaveClass(/order-expanded/);
  await expect(window.getByRole('button', { name: '종목 상세 정보', exact: true })).toHaveCount(0);
  const chip = window.getByLabel('매수 67,200원 주문', { exact: true });
  const chipBox = (await chip.boundingBox())!;
  const summary = (await window.locator('.order-summary-layer').boundingBox())!;
  const row = (await window.locator('.order-row').nth(9).boundingBox())!;
  await page.mouse.move(chipBox.x + chipBox.width / 2, chipBox.y + chipBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(summary.x + summary.width / 2, row.y + row.height / 2, { steps: 12 });
  await expect(window.locator('.order-target')).toHaveAttribute('data-order-price', '67300');
  await page.mouse.up();
  await expect(window.getByLabel('매수 67,300원 주문', { exact: true })).toHaveText('70');
  expect(commands).toHaveLength(1);
  expect(commands[0]).toMatchObject({ price: 67300, quantity: null });
  await expect(window.getByRole('group', { name: '주문 확인' })).toHaveCount(0);
});


test('기본 576px에서도 7자리 가격·긴 상세 값·폰트를 유지하며 직접 표시한다', async ({ page }, testInfo) => {
  const { window, commands, ws } = await setup(page, false, false, true, 1_401_800);
  await ws!.waitForSubscribe('005930');
  ws!.pushLive('005930', { kind: 'trade', venue: 'UN', t_ms: Date.now(),
    day_open: 1_469_100, day_high: 1_470_000, day_low: 1_468_100, trades: [] });
  for (const [price, marker] of [[1_469_100, '시'], [1_470_000, '고'], [1_468_100, '저']] as const)
    await expect(window.locator(`[data-order-price="${price}"] [data-price-badges]`)).toHaveText(marker);
  await page.evaluate(() => document.fonts.ready);
  await expect(window).toHaveClass(/order-expanded/);
  await expect(window.getByRole('button', { name: '종목 상세 정보', exact: true })).toHaveCount(0);
  await expect(window.getByTestId('book-summary').getByText('1,578,000/1,425,000', { exact: true })).toBeVisible();
  const priceFont = await window.locator('.order-price > span').first().evaluate(el => getComputedStyle(el).fontSize);
  const detailFont = await window.getByTestId('book-summary').getByText('1,578,000/1,425,000', { exact: true }).evaluate(el => getComputedStyle(el).fontSize);
  expect(await window.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  expect(await window.locator('.order-scroll').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  expect(await window.locator('.order-price').evaluateAll(cells => cells.every(cell => {
    const bounds = cell.getBoundingClientRect();
    return [...cell.children].every(child => {
      const r = child.getBoundingClientRect();
      return r.left >= bounds.left && r.right <= bounds.right;
    });
  }))).toBe(true);
  await window.screenshot({ path: testInfo.outputPath('default-inline-seven-digit-order.png') });
  await window.evaluate(el => { (el as HTMLElement).style.width = '800px'; });
  await expect(window).toHaveClass(/order-spacious/);
  expect(await window.locator('.order-price > span').first().evaluate(el => getComputedStyle(el).fontSize)).toBe(priceFont);
  expect(await window.getByTestId('book-summary').getByText('1,578,000/1,425,000', { exact: true }).evaluate(el => getComputedStyle(el).fontSize)).toBe(detailFont);
  await window.evaluate(el => { (el as HTMLElement).style.width = '568px'; });
  await expect(window).not.toHaveClass(/order-spacious/);
  await window.getByRole('button', { name: /매수 1,469,000원 주문 추가/ }).dblclick();
  const order = window.getByLabel('매수 1,469,000원 주문', { exact: true });
  await expect(order).toHaveText('10');
  await drag(page, order, window.getByRole('button', { name: /매수 1,468,900원 주문 추가/ }));
  const moved = window.getByLabel('매수 1,468,900원 주문', { exact: true });
  await expect(moved).toHaveText('10');
  await drag(page, moved, window.getByRole('button', { name: '주문 설정', exact: true }));
  await expect(window.locator('[data-drag-order]')).toHaveCount(0);
  expect(commands).toHaveLength(3);
});
