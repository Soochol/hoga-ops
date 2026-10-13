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
    snapshots: [{ kind: 'ob', venue: new URL(route.request().url()).searchParams.get('venue') ?? 'UN', t_ms: Date.now(), asks: Array.from({ length: 10 }, (_, i) => ({ price: 67300 + i * 100, qty: 100 + i })), bids: Array.from({ length: 10 }, (_, i) => ({ price: 67200 - i * 100, qty: 200 + i })), total_ask_qty: 1000, total_bid_qty: 2000 }],
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
    const operationId = `replacement-${commands.length}`;
    if (path.endsWith('/cancel')) orders = [];
    else orders = [{ ...mkOrder(operationId, String(body.price), path.endsWith('/modify') ? '30' : '0'),
      side: body.side ?? orders[0]?.side ?? 'BUY', quantity: String(body.quantity ?? orders[0]?.quantity ?? 100) }];
    await route.fulfill({ json: { command_id: body.command_id, order_id: operationId, status: 'accepted' } });
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

test('왼쪽 매도·오른쪽 매수 즉시 주문, 상하단 정보·신규 확인창 없음', async ({ page }, testInfo) => {
  const { window, commands } = await setup(page);
  const add = window.getByRole('button', { name: /매수 67,200원 주문 추가/ });
  await expect(add).toHaveText('');
  const sellBox = await window.getByRole('button', { name: /매도 67,200원 주문 추가/ }).boundingBox();
  const buyBox = await add.boundingBox();
  expect(sellBox!.x).toBeLessThan(buyBox!.x);
  await expect(window.locator('.order-topline,.order-quote,.order-footer,.order-position,.order-cancel-zone,.order-status,.order-history')).toHaveCount(0);
  await expect(window.getByRole('checkbox', { name: '즉시 주문' })).toHaveCount(0);
  await add.click();
  await expect(window.getByRole('group', { name: '주문 확인' })).toHaveCount(0);
  await expect(window.getByRole('button', { name: '주문 접수', exact: true })).toHaveCount(0);
  await expect(window.getByRole('button', { name: '매수 67,200원 1건 상세 정정' })).toBeVisible();
  expect(commands[0]).toMatchObject({ code: '005930', account_seq: 1, side: 'BUY', price: 67200, quantity: 10 });
  await expect(window).not.toContainText('⠿');
  await window.screenshot({ path: testInfo.outputPath('order-window.png') });
});

test('공통 수량·환산 금액·상단 계좌 가용 금액과 수량', async ({ page }, testInfo) => {
  const { window, commands } = await setup(page);
  await expect(window.getByRole('combobox', { name: '수량 방향' })).toHaveCount(0);
  await expect(window.getByLabel('주문 기준 금액')).toHaveCount(0);
  await expect(window.getByRole('button', { name: '매도 25%' })).toHaveCount(0);
  await expect(window.getByLabel('매수 가능 금액')).toHaveText('매수 가능 20,000,000원');
  await expect(window.getByLabel('매도 가능 수량')).toHaveText('매도 가능 100주');
  const preset = window.getByRole('button', { name: '50주', exact: true });
  await preset.click();
  await expect(preset).toHaveAttribute('aria-pressed', 'true');
  const buy = window.getByRole('button', { name: /매수 67,200원 주문 추가/ });
  await buy.hover();
  await expect(window.getByLabel('예상 주문 금액')).toHaveText('예상 3,360,000원67,200원 기준');
  const summary = window.getByTestId('book-summary');
  await expect(summary.getByText('매수 가능', { exact: true })).toHaveCount(0);
  await expect(summary.getByText('매도 가능', { exact: true })).toHaveCount(0);
  for (const label of ['KRX종가', '상승VI', '하강VI', '250일']) await expect(summary.getByText(label, { exact: true })).toBeVisible();
  const summaryBox = await summary.boundingBox();
  const bidBox = await window.locator('[data-order-price="67200"]').boundingBox();
  expect(summaryBox!.y + summaryBox!.height).toBeLessThanOrEqual(bidBox!.y + 1);
  await buy.click();
  await expect(window.getByRole('button', { name: '매수 67,200원 1건 상세 정정' })).toHaveText('50주');
  expect(commands[0]).toMatchObject({ side: 'BUY', quantity: 50 });
  await drag(page, window.getByRole('button', { name: '매수 67,200원 1건 상세 정정' }), window.getByRole('combobox', { name: '주문 모드' }));
  const sell = window.getByRole('button', { name: /매도 67,300원 주문 추가/ });
  await expect(sell).toBeEnabled();
  await sell.focus();
  await expect(window.getByLabel('예상 주문 금액')).toHaveText('예상 3,365,000원67,300원 기준');
  await sell.click();
  await expect(window.getByRole('button', { name: '매도 67,300원 1건 상세 정정' })).toHaveText('50주');
  expect(commands[2]).toMatchObject({ side: 'SELL', quantity: 50 });
  await window.screenshot({ path: testInfo.outputPath('unified-order-controls.png') });
});

test('수량 영역을 직접 끌어 정정·드래그 아웃 취소', async ({ page }) => {
  const { window, commands } = await setup(page, true);
  const original = window.getByRole('button', { name: '매수 67,200원 1건 상세 정정' });
  await expect(original).toHaveText('70주');
  await drag(page, original, window.getByRole('button', { name: /매수 67,000원 주문 추가/ }));
  await expect(window.getByRole('button', { name: '매수 67,000원 1건 상세 정정' })).toBeVisible();
  expect(commands[0]).toMatchObject({ price: 67000, quantity: null });
  await expect(window.getByRole('group', { name: '주문 확인' })).toHaveCount(0);
  await drag(page, window.getByRole('button', { name: '매수 67,000원 1건 상세 정정' }), window.getByRole('combobox', { name: '주문 모드' }));
  await expect(window.locator('[data-drag-order]')).toHaveCount(0);
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
  await window.getByRole('spinbutton', { name: '신규 주문 수량' }).fill('50');
  await window.getByRole('button', { name: /매수 67,300원 주문 추가/ }).click();
  const partial = window.getByRole('button', { name: '매수 67,300원 1건 상세 정정' });
  await expect(partial).toHaveText('20주');
  await expect(window.locator('.order-position')).toHaveCount(0);
  await page.request.post(`${API_URL}/api/test/paper-book?code=005930&ask=67300&quantity=40`);
  await expect(partial).toHaveText('10주');
  await drag(page, partial, window.getByRole('button', { name: /매수 67,200원 주문 추가/ }));
  const moved = window.getByRole('button', { name: '매수 67,200원 1건 상세 정정' });
  await expect(moved).toHaveText('10주');
  await drag(page, moved, window.getByRole('combobox', { name: '주문 모드' }));
  await expect(window.locator('[data-drag-order]')).toHaveCount(0);
  await window.getByRole('spinbutton', { name: '신규 주문 수량' }).fill('5');
  await window.getByRole('button', { name: /매수 67,200원 주문 추가/ }).click();
  await expect(window.getByRole('button', { name: '매수 67,200원 1건 상세 정정' })).toHaveText('5주');
  await window.getByRole('button', { name: /매수 67,100원 주문 추가/ }).click();
  await expect(window.locator('[data-drag-order]')).toHaveCount(2);
  await window.getByRole('button', { name: /매수 67,200원 주문 추가/ }).focus();
  await page.keyboard.press('Control+Shift+Backspace');
  await window.getByRole('button', { name: '취소 접수', exact: true }).click();
  await expect(window.locator('[data-drag-order]')).toHaveCount(0);
  const state = await page.request.get(`${API_URL}/api/paper-trading/state?account_seq=1&code=005930`);
  expect((await state.json()).holding_quantity).toBe('40');
  await expect(window.locator('.order-topline,.order-quote,.order-footer,.order-position,.order-status,.order-history')).toHaveCount(0);
  expect(realRequests).toEqual([]);
  await window.screenshot({ path: testInfo.outputPath('paper-order-window.png') });
});


test('호가 경계 1px 밖 드롭은 즉시 취소하고 Esc로 중단할 수 있다', async ({ page }) => {
  const { window, commands } = await setup(page, true);
  const chip = window.getByRole('button', { name: '매수 67,200원 1건 상세 정정' });
  const a = await chip.boundingBox(), bounds = await window.locator('.order-ladder').boundingBox();
  expect(a).not.toBeNull(); expect(bounds).not.toBeNull();
  const x = a!.x + a!.width / 2, y = a!.y + a!.height / 2;
  await page.mouse.move(x, y); await page.mouse.down();
  await page.mouse.move(bounds!.x + bounds!.width + 1, y, { steps: 8 });
  expect(commands).toHaveLength(0);
  await expect(window.locator('.order-cancel-active')).toHaveCount(1);
  await page.keyboard.press('Escape'); await page.mouse.up();
  expect(commands).toHaveLength(0);
  expect(await window.locator('.order-ladder').boundingBox()).toEqual(bounds);
  await expect(chip).toHaveText('70주');
  await page.mouse.move(x, y); await page.mouse.down();
  await page.mouse.move(bounds!.x + bounds!.width + 1, y, { steps: 8 });
  expect(commands).toHaveLength(0);
  await page.mouse.up();
  await expect(window.locator('[data-drag-order]')).toHaveCount(0);
  expect(commands).toHaveLength(1);
  await expect(window.getByRole('group', { name: '주문 확인' })).toHaveCount(0);
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

test('주문창 폭을 줄여도 같은 설정·5열·잔량·상세 정보를 유지한다', async ({ page }) => {
  const { window, commands } = await setup(page);
  const controls = window.getByRole('group', { name: '공통 주문 수량' });
  const originalHeight = (await controls.boundingBox())!.height;
  for (const width of [699, 478, 360]) {
    await window.evaluate((el, nextWidth) => { (el as HTMLElement).style.width = `${nextWidth}px`; }, width);
    await expect(window.getByTestId('book-summary')).toBeVisible();
    await expect(window.locator('.order-depth')).toHaveCount(20);
    expect(await window.locator('.order-row').first().evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length)).toBe(5);
    await expect.poll(async () => (await controls.boundingBox())!.height).toBe(originalHeight);
    expect(await window.evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true);
    await window.evaluate(el => { el.scrollLeft = el.scrollWidth; });
    const buy = window.getByRole('button', { name: /매수 67,200원 주문 추가/ });
    await expect(buy).toBeInViewport();
    await expect(window.getByTestId('book-summary').getByText('250일', { exact: true })).toBeInViewport();
  }
  await window.getByRole('button', { name: /매수 67,200원 주문 추가/ }).click();
  const chip = window.getByRole('button', { name: '매수 67,200원 1건 상세 정정' });
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
