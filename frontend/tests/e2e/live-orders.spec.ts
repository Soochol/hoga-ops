import { test, expect, type Page, type Locator } from '@playwright/test';
import { installLiveMocks } from './helpers/liveMocks';
import { installLiveWs } from './helpers/liveWs';
import { API_URL } from './worktreeEnv';

const mkOrder = (id: string, price = '67200', filled = '30') => ({
  orderId: id, symbol: '005930', side: 'BUY', orderType: 'LIMIT', timeInForce: 'DAY', status: 'PARTIAL_FILLED', price,
  quantity: '100', orderAmount: null, currency: 'KRW', orderedAt: '2026-10-13T10:00:00+09:00', canceledAt: null,
  execution: { filledQuantity: filled, averageFilledPrice: '67200', filledAmount: '2016000', commission: null, tax: null, filledAt: null, settlementDate: null },
});

async function setup(page: Page, withOrder = false, mode: 'paper' | 'live' = 'live') {
  await page.setViewportSize({ width: 1440, height: 1100 });
  await installLiveMocks(page);
  if (mode === 'live') await installLiveWs(page);
  await page.route(/^https?:\/\/[^/]+\/api\/symbols\/all$/, route => route.fulfill({ json: {
    symbols: [{ code: '005930', name: '삼성전자', market: 'KOSPI' }], status: 'fresh', fetched_at_ms: Date.now(), reason: null,
  } }));
  await page.route(/^https?:\/\/[^/]+\/api\/live\/series\?/, route => mode === 'paper' ? route.continue() : route.fulfill({ json: {
    code: '005930', date: new URL(route.request().url()).searchParams.get('date'), session_open_ms: Date.now(), session_close_ms: null, is_open: true,
    snapshots: [{ kind: 'ob', venue: 'UN', t_ms: Date.now(), asks: Array.from({ length: 10 }, (_, i) => ({ price: 67300 + i * 100, qty: 100 + i })), bids: Array.from({ length: 10 }, (_, i) => ({ price: 67200 - i * 100, qty: 200 + i })), total_ask_qty: 1000, total_bid_qty: 2000 }],
    trades: [], brokers: [], programs: [], after_hours: [], expected: [], today_ask_peak: null, today_bid_peak: null,
  } }));
  await page.route(/^https?:\/\/[^/]+\/api\/trading\/accounts$/, route => route.fulfill({ json: { configured: true, accounts: [{ account_seq: 1, label: '토스증권 · ****1234' }] } }));
  let orders = withOrder ? [mkOrder('old')] : [];
  const commands: Record<string, unknown>[] = [];
  await page.route(/^https?:\/\/[^/]+\/api\/trading\/state\?/, route => route.fulfill({ json: {
    account_seq: 1, code: '005930', orders, recent_orders: [], buying_power: '20000000', sellable_quantity: '100', holding_quantity: '100', average_purchase_price: '66000', fetched_at_ms: Date.now(), events_connected: true, unresolved_commands: [],
  } }));
  await page.route(/^https?:\/\/[^/]+\/api\/trading\/orders(?:\/[^/]+\/(?:modify|cancel))?$/, async route => {
    const body = route.request().postDataJSON(); commands.push(body);
    expect(route.request().headers()['x-hoga-order']).toBe('1');
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/cancel')) orders = [];
    else orders = [mkOrder('replacement', String(body.price), path.endsWith('/modify') ? '30' : '0')];
    await route.fulfill({ json: { command_id: body.command_id, order_id: 'replacement', status: 'accepted' } });
  });
  await page.goto('/live');
  await page.getByRole('button', { name: '종목 검색 열기' }).click();
  const dialog = page.getByRole('dialog', { name: '종목 검색' });
  await dialog.getByRole('combobox', { name: '종목 검색' }).fill('삼성전자');
  await dialog.getByRole('option').first().click();
  await page.getByTestId('workspace-add-menu-button').click();
  await page.getByTestId('workspace-add-order').click();
  const window = page.getByTestId('order-window');
  await page.locator('[data-win]').filter({ has: window }).getByRole('button', { name: '창 최대화', exact: true }).click();
  await window.getByRole('combobox', { name: '주문 모드' }).selectOption(mode);
  await expect(window.getByRole('button', { name: /매수 67,200원 주문 추가/ })).toBeEnabled();
  return { window, commands };
}

async function drag(page: Page, from: Locator, to: Locator) {
  const a = await from.boundingBox(), b = await to.boundingBox();
  expect(a).not.toBeNull(); expect(b).not.toBeNull();
  await page.mouse.move(a!.x + a!.width / 2, a!.y + a!.height / 2);
  await page.mouse.down();
  await page.mouse.move(b!.x + b!.width / 2, b!.y + b!.height / 2, { steps: 12 });
  await page.mouse.up();
}

test('빈 주문 영역·확인 접수·아이콘 없는 잔량 표시', async ({ page }, testInfo) => {
  const { window, commands } = await setup(page);
  const add = window.getByRole('button', { name: /매수 67,200원 주문 추가/ });
  await expect(add).toHaveText('');
  await add.click(); expect(commands).toHaveLength(0);
  await window.getByRole('button', { name: '주문 접수', exact: true }).click();
  await expect(window.getByRole('button', { name: '매수 67,200원 1건 상세 정정' })).toBeVisible();
  expect(commands[0]).toMatchObject({ code: '005930', account_seq: 1, side: 'BUY', price: 67200, quantity: 10 });
  await expect(window).not.toContainText('⠿');
  await window.screenshot({ path: testInfo.outputPath('order-window.png') });
});

test('수량 영역을 직접 끌어 정정·드래그 아웃 취소', async ({ page }) => {
  const { window, commands } = await setup(page, true);
  const original = window.getByRole('button', { name: '매수 67,200원 1건 상세 정정' });
  await expect(original).toHaveText('70주');
  await window.getByRole('checkbox', { name: '즉시 주문' }).check();
  await drag(page, original, window.getByRole('button', { name: /매수 67,000원 주문 추가/ }));
  await expect(window.getByRole('button', { name: '매수 67,000원 1건 상세 정정' })).toBeVisible();
  expect(commands[0]).toMatchObject({ price: 67000, quantity: null });
  await expect(window.getByRole('group', { name: '주문 확인' })).toHaveCount(0);
  await drag(page, window.getByRole('button', { name: '매수 67,000원 1건 상세 정정' }), window.getByText('주문을 호가 영역 밖으로 끌어 취소', { exact: true }));
  await expect(window.getByText('미체결 0건 · 0주', { exact: true })).toBeVisible();
  expect(commands).toHaveLength(2);
});


test('로컬 모의 계좌: 실제 백엔드 부분 체결·드래그 정정·취소·전체 취소', async ({ page }, testInfo) => {
  test.setTimeout(60_000);
  const realRequests: string[] = [];
  page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/trading')) realRequests.push(request.url()); });
  const headers = { 'X-Hoga-Order': '1' };
  const reset = await page.request.post(`${API_URL}/api/paper-trading/reset`, { headers, data: {
    account_seq: 1, command_id: `init-${Date.now()}`, code: '005930', cash: 10_000_000,
    holding_quantity: 0, average_purchase_price: 67200, confirmed: true,
  } });
  expect(reset.ok()).toBeTruthy();
  // Drain retained liquidity from any earlier repeat, then replenish with a new frame.
  expect((await page.request.post(`${API_URL}/api/test/paper-book?code=005930&ask=67300&quantity=0`)).ok()).toBeTruthy();
  await page.request.get(`${API_URL}/api/paper-trading/state?account_seq=1&code=005930`);
  expect((await page.request.post(`${API_URL}/api/test/paper-book?code=005930&ask=67300&quantity=30`)).ok()).toBeTruthy();
  const { window } = await setup(page, false, 'paper');
  await expect(window.getByRole('combobox', { name: '주문 모드' })).toHaveValue('paper');
  await window.getByRole('checkbox', { name: '즉시 주문' }).check();
  await window.getByRole('spinbutton', { name: '신규 주문 수량' }).fill('50');
  await window.getByRole('button', { name: /매수 67,300원 주문 추가/ }).click();
  const partial = window.getByRole('button', { name: '매수 67,300원 1건 상세 정정' });
  await expect(partial).toHaveText('20주');
  await expect(window.getByText(/보유 30주 · 평균 매입 67,300원/)).toBeVisible();
  await page.request.post(`${API_URL}/api/test/paper-book?code=005930&ask=67300&quantity=40`);
  await expect(partial).toHaveText('10주');
  await drag(page, partial, window.getByRole('button', { name: /매수 67,200원 주문 추가/ }));
  const moved = window.getByRole('button', { name: '매수 67,200원 1건 상세 정정' });
  await expect(moved).toHaveText('10주');
  await drag(page, moved, window.getByText('주문을 호가 영역 밖으로 끌어 취소', { exact: true }));
  await expect(window.getByText('미체결 0건 · 0주', { exact: true })).toBeVisible();
  await window.getByRole('spinbutton', { name: '신규 주문 수량' }).fill('5');
  await window.getByRole('button', { name: /매수 67,200원 주문 추가/ }).click();
  await expect(window.getByRole('button', { name: '매수 67,200원 1건 상세 정정' })).toHaveText('5주');
  await window.getByRole('button', { name: /매수 67,100원 주문 추가/ }).click();
  await expect(window.getByText('미체결 2건 · 10주', { exact: true })).toBeVisible();
  await window.getByRole('button', { name: '삼성전자 전체 취소', exact: true }).click();
  await window.getByRole('button', { name: '취소 접수', exact: true }).click();
  await expect(window.getByText('미체결 0건 · 0주', { exact: true })).toBeVisible();
  await expect(window.getByText(/보유 40주 · 평균 매입 67,300원/)).toBeVisible();
  expect(realRequests).toEqual([]);
  await window.screenshot({ path: testInfo.outputPath('paper-order-window.png') });
});
