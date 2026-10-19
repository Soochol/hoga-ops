import { test, expect, type Page, type Locator } from '@playwright/test';
import { installLiveMocks } from './helpers/liveMocks';
import { installLiveWs } from './helpers/liveWs';

const mkOrder = (id: string, price = '67200', filled = '30') => ({
  orderId: id, symbol: '005930', side: 'BUY', orderType: 'LIMIT', timeInForce: 'DAY', status: 'PARTIAL_FILLED', price,
  quantity: '100', orderAmount: null, currency: 'KRW', orderedAt: '2026-10-13T10:00:00+09:00', canceledAt: null,
  execution: { filledQuantity: filled, averageFilledPrice: '67200', filledAmount: '2016000', commission: null, tax: null, filledAt: null, settlementDate: null },
});

async function setup(page: Page, withOrder: boolean | ReturnType<typeof mkOrder>[] = false, maximize = true, sameDepth = false, priceOffset = 0, accountCount = 1, market: { time?: number; venue?: 'KRX' | 'NXT' | 'UN'; averagePrice?: string; holdingQuantity?: string; sellableQuantity?: string } = {}) {
  await page.setViewportSize({ width: 1440, height: 1100 });
  // Existing order/WS fixtures exercise integrated trading. Venue tests switch explicitly.
  await page.addInitScript(venue => localStorage.setItem('live.venue.v1', JSON.stringify({ venue })), market.venue ?? 'UN');
  await installLiveMocks(page);
  // Legacy fixtures explicitly exercise the v2-404 compatibility path.
  await page.route('**/api/trading/v2/accounts', route => route.fulfill({ status: 404, json: { detail: 'legacy fixture' } }));
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
    const balances = { account_seq: 1, code: '005930', buying_power: '20000000', sellable_quantity: market.sellableQuantity ?? '100', holding_quantity: market.holdingQuantity ?? '100', average_purchase_price: market.averagePrice ?? '66000', fetched_at_ms: Date.now() };
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

async function multiBrokerSetup(page: Page) {
  await page.route(/^https?:\/\/[^/]+\/api\//, route => route.fulfill({ status: 404, json: { detail: 'not mocked' } }));
  await page.route('**/config.json', route => route.fulfill({ json: { api_url: '' } }));
  const { window } = await setup(page);
  const toss = `acc_${'a'.repeat(32)}`, kiwoom = `acc_${'b'.repeat(32)}`;
  const commands: { path: string; body: Record<string, unknown> }[] = [];
  await page.route('**/api/trading/v2/accounts', route => route.fulfill({ json: { configured: true, accounts: [
    { account_ref: toss, broker: 'toss', environment: 'real', label: '토스증권 · ****1234', routes: ['SOR'], order_enabled: true },
    { account_ref: kiwoom, broker: 'kiwoom', environment: 'real', label: '키움증권 · 실전 · ****5678',
      routes: ['KRX', 'NXT', 'SOR'], order_enabled: true, blocked_reason: null },
  ] } }));
  await page.route('**/api/trading/v2/state?*', route => {
    const url = new URL(route.request().url());
    return route.fulfill({ json: { account_ref: url.searchParams.get('account_ref'), code: '005930',
      orders: [], recent_orders: [], unresolved_commands: [], events_connected: false, fetched_at_ms: Date.now(),
      buying_power: '20000000', sellable_quantity: '100', holding_quantity: '100', average_purchase_price: '66000' } });
  });
  await page.route('**/api/trading/v2/orders', route => {
    commands.push({ path: new URL(route.request().url()).pathname, body: route.request().postDataJSON() });
    expect(route.request().headers()['x-hoga-order']).toBe('1');
    return route.fulfill({ json: { command_id: commands.at(-1)!.body.command_id, order_ref: 'ord_fixture', status: 'accepted' } });
  });
  await page.reload();
  await expect(window.getByRole('combobox', { name: '주문 계좌' })).toHaveValue(toss);
  return { window, toss, kiwoom, commands };
}

test('증권사 계좌 전환은 키움 주문을 활성화하고 토스 주문을 유지한다', async ({ page }, testInfo) => {
  const { window, toss, kiwoom, commands } = await multiBrokerSetup(page);
  const account = window.getByRole('combobox', { name: '주문 계좌' });
  const buy = window.getByRole('button', { name: /매수 67,200원 주문 추가/ });
  await account.selectOption(kiwoom);
  await expect(buy).toBeEnabled();
  await expect(window.getByRole('combobox', { name: '주문 거래소' })).toHaveValue('SOR');
  await expect(account.locator('option:checked')).toHaveText('키움증권 · ****5678');
  expect(commands).toHaveLength(0);
  await page.screenshot({ path: testInfo.outputPath('kiwoom-enabled.png') });
  await account.selectOption(toss);
  await expect(buy).toBeEnabled();
  await buy.dblclick();
  await expect.poll(() => commands.length).toBe(1);
  expect(commands[0].body).toMatchObject({ account_ref: toss, route: 'SOR', code: '005930', side: 'BUY' });
  expect(commands[0].body).not.toHaveProperty('account_seq');
});

test('키움 주문의 가짜 응답은 선택 거래소와 계좌 식별자를 전송한다', async ({ page }, testInfo) => {
  const { window, kiwoom, commands } = await multiBrokerSetup(page);
  await window.getByRole('combobox', { name: '주문 계좌' }).selectOption(kiwoom);
  const route = window.getByRole('combobox', { name: '주문 거래소' });
  await expect(route).toBeVisible();
  await route.selectOption('KRX');
  await expect(window.getByLabel('주문 경로')).toContainText('주문 KRX');
  const buy = window.getByRole('button', { name: /매수 67,200원 주문 추가/ });
  await expect(buy).toBeEnabled();
  await buy.dblclick();
  await expect.poll(() => commands.length).toBe(1);
  expect(commands[0].body).toMatchObject({ account_ref: kiwoom, route: 'KRX', code: '005930' });
  await page.screenshot({ path: testInfo.outputPath('kiwoom-route.png') });
});

for (const theme of ['obsidian', 'ledger']) {
  test(`주문 불가 사유와 공통 알림은 좁은 주문창에서 안내하고 전송을 차단한다 (${theme})`, async ({ page }, testInfo) => {
    // All requests stay in these HTTP/WS mocks; no broker or backend is contacted.
    await page.route(/^https?:\/\/[^/]+\/api\//, route => route.fulfill({ status: 404, json: { detail: 'not mocked' } }));
    await page.route('**/config.json', route => route.fulfill({ json: { api_url: '' } }));
    const { window, commands } = await setup(page);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    // Keep the real mounted order window, at its supported compact width.
    await window.evaluate(el => { el.style.width = '504px'; });
    const quantity = window.getByRole('spinbutton', { name: '신규 주문 수량' });
    await quantity.fill('');
    const inline = window.getByRole('status', { name: '신규 주문 상태' });
    await expect(inline).toBeHidden();
    const toast = page.getByRole('alert', { name: '주문 알림', exact: true });
    await expect(toast).toBeHidden();
    const buy = window.getByRole('button', { name: /매수 67,200원 주문 추가/ });
    await expect(buy).toBeDisabled();
    // aria-disabled intentionally remains hit-testable to explain a blocked attempt.
    const box = (await buy.boundingBox())!;
    await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
    await expect(toast).toContainText('정수');
    expect(commands).toHaveLength(0);
    await buy.focus();
    await page.keyboard.press('Enter');
    await expect(toast).toHaveCount(1);
    expect(commands).toHaveLength(0);
    await toast.hover();
    await expect(toast.locator('.toast-progress')).toHaveCSS('animation-play-state', 'paused');
    await toast.getByRole('button', { name: '주문 알림 닫기' }).focus();
    await page.mouse.move(1, 1);
    await expect(toast.locator('.toast-progress')).toHaveCSS('animation-play-state', 'paused');
    await expect(inline).toBeHidden();
    await page.screenshot({ path: testInfo.outputPath(`order-unavailable-${theme}.png`) });
    await quantity.fill('5');
    await expect(inline).toBeHidden();
    await expect(buy).toBeEnabled();
    await buy.dblclick();
    await expect.poll(() => commands.length).toBe(1);
    expect(commands[0]).toMatchObject({ side: 'BUY', quantity: 5 });
  });
}

test('주문 API의 거래시간 거절은 공통 경고에 사유를 표시하고 재확인 주문을 만들지 않는다', async ({ page }, testInfo) => {
  await page.route(/^https?:\/\/[^/]+\/api\//, route => route.fulfill({ status: 404, json: { detail: 'not mocked' } }));
  await page.route('**/config.json', route => route.fulfill({ json: { api_url: '' } }));
  const { window } = await setup(page);
  let attempts = 0;
  await page.route(/^https?:\/\/[^/]+\/api\/trading\/orders$/, route => {
    attempts++;
    return route.fulfill({ status: 422, json: { detail: { code: 'order-hours-closed', message: '현재 해당 주문을 접수할 수 없는 시간입니다.' } } });
  });
  const buy = window.getByRole('button', { name: /매수 67,200원 주문 추가/ });
  const beforeSubmit = await buy.boundingBox();
  await buy.dblclick();
  const toast = page.getByRole('alert', { name: '주문 알림', exact: true });
  await expect(toast.getByText('주문 접수 불가', { exact: true })).toBeVisible();
  await expect(toast).toContainText('현재 해당 주문을 접수할 수 없는 시간입니다.');
  await expect(toast.getByRole('button', { name: '같은 요청 다시 확인' })).toHaveCount(0);
  await expect(window.getByRole('status', { name: '신규 주문 상태' })).toBeHidden();
  expect(await buy.boundingBox()).toEqual(beforeSubmit);
  expect(attempts).toBe(1);
  await page.screenshot({ path: testInfo.outputPath('order-hours-closed.png') });
  await toast.getByRole('button', { name: '주문 알림 닫기' }).click();
  await expect(toast).toBeHidden();
  expect(await buy.boundingBox()).toEqual(beforeSubmit);
});

test('주문접수 소리는 미리듣기·성공 응답에서만 재생하고 켜기 설정을 복원한다', async ({ page }, testInfo) => {
  // Observe the real Web Audio buffer without replacing playback or autoplay policy.
  await page.addInitScript(() => {
    const observed = globalThis.window as unknown as {
      __orderSoundStates: string[]; __orderSoundDurations: number[]; __orderAudio: AudioContext;
    };
    observed.__orderSoundStates = [];
    observed.__orderSoundDurations = [];
    const start = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (when?: number) {
      observed.__orderSoundStates.push(this.context.state);
      observed.__orderSoundDurations.push(this.buffer!.duration);
      observed.__orderAudio = this.context as AudioContext;
      start.call(this, when);
    };
  });
  const soundStates = () => page.evaluate(() => (globalThis.window as unknown as { __orderSoundStates: string[] }).__orderSoundStates);
  const { window, commands } = await setup(page);
  const settings = window.getByRole('button', { name: '주문 설정', exact: true });
  const dialog = page.getByRole('dialog', { name: '주문 설정', exact: true });
  const checkbox = dialog.getByRole('checkbox', { name: '주문접수 소리', exact: true });
  await settings.click();
  await expect(checkbox).not.toBeChecked();
  await expect(dialog.getByRole('slider')).toHaveCount(0);
  await dialog.getByRole('button', { name: '소리 들어보기', exact: true }).click();
  await expect.poll(soundStates).toEqual(['running']);
  expect(await page.evaluate(() => (globalThis.window as unknown as { __orderSoundDurations: number[] }).__orderSoundDurations[0])).toBeCloseTo(0.33, 3);
  expect(commands).toHaveLength(0);
  await checkbox.check();
  await dialog.screenshot({ path: testInfo.outputPath('order-sound-settings.png') });
  await dialog.getByRole('button', { name: '닫기', exact: true }).click();

  await page.reload();
  await settings.click();
  await expect(checkbox).toBeChecked();
  await dialog.getByRole('button', { name: '닫기', exact: true }).click();
  expect(await soundStates()).toEqual([]);

  let accept!: () => void, attempts = 0;
  const accepted = new Promise<void>(resolve => { accept = resolve; });
  await page.route(/^https?:\/\/[^/]+\/api\/trading\/orders$/, async route => {
    attempts++;
    await accepted;
    const body = route.request().postDataJSON();
    await route.fulfill({ json: { command_id: body.command_id, order_id: 'sound-order', status: 'accepted' } });
  });
  const buy = window.getByRole('button', { name: /매수 67,200원 주문 추가/ });
  const receipt = page.getByRole('status', { name: '주문 접수 알림' });
  const beforeSubmit = await buy.boundingBox();
  await buy.dblclick();
  await expect.poll(() => attempts).toBe(1);
  await expect(receipt).toBeHidden();
  await buy.focus();
  await page.keyboard.press('Enter');
  expect(attempts).toBe(1);
  await expect(page.getByRole('alert', { name: '주문 알림', exact: true })).toBeHidden();
  await expect(window.getByRole('status', { name: '신규 주문 상태' })).toBeHidden();
  expect(await buy.boundingBox()).toEqual(beforeSubmit);
  expect(await soundStates()).toEqual([]);
  accept();
  await expect(receipt).toHaveText('주문 요청 접수됨');
  await expect(window.getByRole('status', { name: '신규 주문 상태' })).toBeHidden();
  expect(await buy.boundingBox()).toEqual(beforeSubmit);
  await expect.poll(soundStates).toEqual(['running']);

  await page.evaluate(async () => {
    const observed = globalThis.window as unknown as { __orderAudio: AudioContext };
    await observed.__orderAudio.suspend();
    globalThis.window.dispatchEvent(new Event('focus'));
  });
  await expect.poll(() => page.evaluate(() => (globalThis.window as unknown as { __orderAudio: AudioContext }).__orderAudio.state)).toBe('running');
  expect(await soundStates()).toEqual(['running']); // Recovery never replays a receipt.
  await buy.dblclick();
  await expect.poll(soundStates).toEqual(['running', 'running']);

  await settings.click();
  await checkbox.uncheck();
  await dialog.getByRole('button', { name: '닫기', exact: true }).click();
  const response = page.waitForResponse(response => new URL(response.url()).pathname === '/api/trading/orders');
  await buy.dblclick();
  await response;
  await expect(receipt).toHaveText('주문 요청 접수됨');
  expect(await soundStates()).toEqual(['running', 'running']);
});

test('오디오 재생 거절은 주문 접수를 유지하고 복구 후 다음 주문만 재생한다', async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    const observed = globalThis.window as unknown as { __soundBlocked: boolean; __soundStarts: number };
    observed.__soundBlocked = true; observed.__soundStarts = 0;
    const NativeAudio = globalThis.AudioContext;
    globalThis.AudioContext = class extends NativeAudio {
      get state(): AudioContextState { return observed.__soundBlocked ? 'suspended' : super.state; }
      resume() {
        return observed.__soundBlocked ? Promise.reject(new DOMException('Playback blocked', 'NotAllowedError')) : super.resume();
      }
    };
    const start = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (when?: number) {
      observed.__soundStarts++;
      start.call(this, when);
    };
  });
  const starts = () => page.evaluate(() => (globalThis.window as unknown as { __soundStarts: number }).__soundStarts);
  const { window, commands } = await setup(page);
  await window.getByRole('button', { name: '주문 설정', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '주문 설정', exact: true });
  await dialog.getByRole('checkbox', { name: '주문접수 소리', exact: true }).check();
  await dialog.getByRole('button', { name: '닫기', exact: true }).click();
  const buy = window.getByRole('button', { name: /매수 67,200원 주문 추가/ });
  await buy.dblclick();
  const receipt = page.getByRole('status', { name: '주문 접수 알림' });
  await expect(receipt).toHaveText('주문은 접수됐지만 알림음을 재생하지 못했습니다');
  await expect(page.getByRole('button', { name: '같은 요청 다시 확인' })).toHaveCount(0);
  expect(commands).toHaveLength(1);
  expect(await starts()).toBe(0);
  await receipt.screenshot({ path: testInfo.outputPath('order-sound-unavailable.png') });
  await page.evaluate(() => {
    (globalThis.window as unknown as { __soundBlocked: boolean }).__soundBlocked = false;
    globalThis.window.dispatchEvent(new Event('focus'));
  });
  expect(await starts()).toBe(0);
  await buy.dblclick();
  await expect(receipt).toHaveText('주문 요청 접수됨');
  await expect.poll(starts).toBe(1);
  expect(commands).toHaveLength(2);
});

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

test('종목별 주문수량 기억은 즉시 저장하고 계좌별로 복원하고 새로고침에는 설정만 남긴다', async ({ page }, testInfo) => {
  const { window, commands } = await setup(page, false, true, false, 0, 2);
  const quantity = window.getByRole('spinbutton', { name: '신규 주문 수량' });
  const account = window.getByRole('combobox', { name: '주문 계좌' });
  const settings = window.getByRole('button', { name: '주문 설정', exact: true });
  const dialog = page.getByRole('dialog', { name: '주문 설정', exact: true });
  const changeCode = async (name: string) => {
    await page.getByRole('button', { name: '종목 검색 열기' }).click();
    const search = page.getByRole('dialog', { name: '종목 검색', exact: true });
    await search.getByRole('combobox', { name: '종목 검색' }).fill(name);
    await search.getByRole('option').filter({ hasText: name }).first().click();
    await expect(page.getByRole('button', { name: `${name} 호가 주문 창 닫기`, exact: true })).toBeVisible();
  };
  await settings.click();
  const remember = dialog.getByRole('checkbox', { name: '종목별 주문수량 기억', exact: true });
  await expect(remember).not.toBeChecked();
  await remember.check();
  await dialog.getByRole('button', { name: '닫기', exact: true }).click();
  await settings.click();
  await expect(remember).toBeChecked();
  await remember.check();
  await dialog.screenshot({ path: testInfo.outputPath('remember-quantity-settings.png') });
  await dialog.getByRole('button', { name: '닫기', exact: true }).click();
  await quantity.fill('30');
  await account.selectOption('2');
  await expect(quantity).toHaveValue('');
  await quantity.fill('5');
  await changeCode('SK하이닉스');
  await expect(quantity).toHaveValue('');
  await quantity.fill('7');
  await changeCode('삼성전자');
  await expect(quantity).toHaveValue('5');
  await account.selectOption('1');
  await expect(quantity).toHaveValue('30');
  await quantity.clear();
  await changeCode('SK하이닉스');
  await expect(quantity).toHaveValue('');
  await changeCode('삼성전자');
  await expect(quantity).toHaveValue('');
  await expect(window.getByRole('button', { name: /매수 67,200원 주문 추가/ })).toBeDisabled();
  await quantity.fill('123');
  await page.reload();
  await expect(quantity).toHaveValue('10');
  await settings.click();
  await expect(remember).toBeChecked();
  expect(commands).toHaveLength(0);
});

test('고정한 호가 주문 창의 종목 이동은 수량을 비우고 입력 전에는 주문을 막는다', async ({ page }) => {
  const { window, commands } = await setup(page);
  const frame = page.locator('[data-win]').filter({ has: window });
  await frame.getByRole('button', { name: '종목 고정', exact: true }).click();
  await window.getByRole('spinbutton', { name: '신규 주문 수량' }).fill('123');
  await window.getByRole('button', { name: '보유종목', exact: true }).click();
  await page.getByRole('dialog', { name: '계좌 목록' }).getByRole('button', { name: 'SK하이닉스', exact: true }).click();
  await expect(page.getByRole('button', { name: 'SK하이닉스 호가 주문 창 닫기', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '삼성전자 10호가 창 닫기', exact: true })).toBeVisible();
  const quantity = window.getByRole('spinbutton', { name: '신규 주문 수량' });
  await expect(quantity).toHaveValue('');
  const buy = window.getByRole('button', { name: /매수 67,200원 주문 추가/ });
  await expect(buy).toBeDisabled();
  await quantity.fill('7');
  await expect(buy).toBeEnabled();
  await quantity.clear();
  await expect(quantity).toHaveValue('');
  await expect(buy).toBeDisabled();
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

for (const side of ['BUY', 'SELL'] as const) {
  test(`${side} 드래그 중 호가·잔량을 갱신하고 원래 칸이 사라져도 현재 커서의 가격으로 정정한다`, async ({ page }) => {
    const sourcePrice = side === 'BUY' ? 67200 : 67300;
    const targetPrice = side === 'BUY' ? 67000 : 67500;
    const nextPrice = targetPrice + 100;
    const label = side === 'BUY' ? '매수' : '매도';
    const { window, commands, ws } = await setup(page, [{ ...mkOrder('old', String(sourcePrice)), side }]);
    await ws.waitForSubscribe('005930');
    const source = (await window.getByLabel(`${label} ${sourcePrice.toLocaleString('ko-KR')}원 주문`, { exact: true }).boundingBox())!;
    const target = (await window.getByRole('button', { name: new RegExp(`${label} ${targetPrice.toLocaleString('ko-KR')}원 주문 추가`) }).boundingBox())!;
    const preview = page.getByRole('status', { name: '주문 드래그 미리보기' });
    await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
    await page.mouse.down();
    try {
      await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 12 });
      await expect(preview).toHaveText('70');
      const timestamp = Date.now();
      const frame = { kind: 'ob', venue: 'UN', t_ms: timestamp,
        asks: Array.from({ length: 10 }, (_, i) => ({ price: 67300 + i * 100, qty: 900 + i })),
        bids: Array.from({ length: 10 }, (_, i) => ({ price: 67200 - i * 100, qty: 900 + i })),
        total_ask_qty: 9000, total_bid_qty: 9100 };
      ws.pushLive('005930', frame);
      await expect(window.locator(`[data-order-price="${targetPrice}"] .order-depth-qty`)).toHaveText('902');
      await expect(window.getByLabel('매수총잔량 9,100')).toBeVisible();
      // Keep the mouse still while the source cells disappear, then prices shift.
      ws.pushLive('005930', { ...frame, t_ms: timestamp + 1,
        [side === 'BUY' ? 'bids' : 'asks']: Array.from({ length: 10 }, () => ({ price: 0, qty: 0 })) });
      await expect(window.locator(side === 'BUY' ? '.order-bid' : '.order-ask')).toHaveCount(0);
      await expect(preview).toHaveText('70');
      expect(commands).toHaveLength(0);
      ws.pushLive('005930', { ...frame, t_ms: timestamp + 2,
        asks: frame.asks.map(level => ({ ...level, price: level.price + 100 })),
        bids: frame.bids.map(level => ({ ...level, price: level.price + 100 })) });
      const destination = window.getByRole('button', { name: new RegExp(`${label} ${nextPrice.toLocaleString('ko-KR')}원 주문 추가`) });
      await expect(destination).toHaveClass(/order-drag-destination/);
      await expect(window.locator(`[data-order-price="${nextPrice}"] .order-depth-qty`)).toHaveText('902');
      await expect(preview).toHaveText('70');
      await page.mouse.up();
      await expect.poll(() => commands.length).toBe(1);
      expect(commands[0]).toMatchObject({ price: nextPrice, quantity: null });
      await expect(preview).toHaveCount(0);
    } finally {
      await page.keyboard.press('Escape');
      await page.mouse.up();
    }
  });
}

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

test('576px 압축형은 숫자만 있는 보유 정보와 주문 입력을 분리하고 호가 밀도를 유지한다', async ({ page }, testInfo) => {
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
  for (const label of ['보유', '평단가', '평가손익']) await expect(window.getByText(label, { exact: true })).toHaveCount(0);
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

test('보유·평단가의 마우스 없는 포커스 복원에는 매수금액을 표시하지 않고 Tab 이동에는 표시한다', async ({ page }) => {
  const { window, commands } = await setup(page, false, true, false, 0, 1,
    { holdingQuantity: '547', sellableQuantity: '547', averagePrice: '123830' });
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  await page.mouse.move(0, 0);
  const quantity = window.getByLabel('매입수량');
  const average = window.getByLabel('매입평단가');
  const tooltip = page.getByRole('tooltip');
  for (const target of [quantity, average]) {
    await target.focus();
    await expect(target).toBeFocused();
    expect(await target.evaluate(el => el.matches(':focus-visible'))).toBe(false);
    await page.clock.runFor(600);
    await expect(tooltip).toHaveCount(0);
  }
  // Keyboard users retain the same purchase-amount description.
  await page.keyboard.press('Shift+Tab');
  await expect(quantity).toBeFocused();
  await page.clock.runFor(500);
  await expect(tooltip).toHaveText('매수금액 67,735,010원');
  await page.keyboard.press('Tab');
  await expect(average).toBeFocused();
  await page.clock.runFor(500);
  await expect(tooltip).toHaveText('매수금액 67,735,010원');
  await page.keyboard.press('Escape');
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
        const textBox = el.querySelector('.book-price-amount')!.getBoundingClientRect();
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

test('두 호가창의 시고저는 빠진 중간 가격을 최근접 행에 표시하고 원래 호가가 돌아오면 복원한다', async ({ page }) => {
  const { window, ws, commands } = await setup(page, false, false);
  const book = page.locator('.book-panel');
  await ws.waitForSubscribe('005930');
  const t_ms = Date.now();
  ws.pushLive('005930', { kind: 'trade', venue: 'UN', t_ms,
    day_open: 67400, day_high: 68100, day_low: 66400,
    trades: [{ price: 67400, qty: 1, side: 1 }],
  });
  const frame = { kind: 'ob', venue: 'UN', t_ms: t_ms + 1,
    asks: [67600, 67900, 68200].map(price => ({ price, qty: 100 })),
    bids: [67200, 66900, 66300].map(price => ({ price, qty: 200 })),
    total_ask_qty: 300, total_bid_qty: 600,
  };
  ws.pushLive('005930', frame);
  const labels = [
    ['고', '고가 68,100원 · 가장 가까운 호가 68,200원', '68200'],
    ['저', '저가 66,400원 · 가장 가까운 호가 66,300원', '66300'],
    ['시', '시가 67,400원 · 가장 가까운 호가 67,200원', '67200'],
  ];
  for (const panel of [window, book]) {
    await expect(panel.locator('[data-price-badges]')).toHaveCount(3);
    for (const [label, name, price] of labels) {
      const badge = panel.getByRole('img', { name, exact: true });
      await expect(badge).toHaveText(label);
      await expect(badge.locator('../..')).toContainText(Number(price).toLocaleString('ko-KR'));
    }
  }
  const approximate = window.getByRole('img', { name: labels[2][1], exact: true });
  await approximate.hover();
  await expect(page.getByRole('tooltip')).toHaveText(labels[2][1]);
  await page.mouse.move(0, 0);
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  await approximate.focus();
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  await page.keyboard.press('Tab');
  await page.keyboard.press('Shift+Tab');
  await expect(approximate).toBeFocused();
  await expect(page.getByRole('tooltip')).toHaveText(labels[2][1]);
  await approximate.press('Escape');
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  ws.pushLive('005930', { ...frame, t_ms: t_ms + 2,
    asks: [67400, 67600, 67900, 68200].map(price => ({ price, qty: 100 })),
  });
  for (const panel of [window, book]) {
    await expect(panel.getByRole('img', { name: labels[2][1], exact: true })).toHaveCount(0);
    const exact = panel.getByRole('img', { name: '시가 67,400원', exact: true });
    await expect(exact).toBeVisible();
    await expect(exact.locator('../..')).toContainText('67,400');
  }
  ws.pushLive('005930', { kind: 'trade', venue: 'UN', t_ms: t_ms + 3,
    day_open: 67400, day_high: 90000, day_low: 1,
    trades: [{ price: 67400, qty: 1, side: 1 }],
  });
  for (const panel of [window, book]) {
    await expect(panel.locator('[data-price-badges]')).toHaveCount(1);
    await expect(panel.locator('[data-price-badges]')).toHaveText('시');
  }
  expect(commands).toHaveLength(0);
});

test('두 호가창의 가격 호버는 매수·매도 잔량 금액을 주문창 툴팁으로 표시한다', async ({ page }, testInfo) => {
  const { window, commands } = await setup(page, false, false);
  const book = page.locator('.book-panel');
  const tooltip = page.getByRole('tooltip');
  for (const [index, panel] of [window, book].entries()) {
    const frame = page.locator('[data-win]').filter({ has: panel });
    await frame.getByRole('button', { name: '창 최대화', exact: true }).click();
    for (const [price, text] of [
      ['67,300', '0.07억'],
      ['67,200', '0.13억'],
    ]) {
      const target = panel.locator('.book-price-amount').filter({ hasText: new RegExp(`^${price}$`) });
      await target.hover();
      await expect(tooltip).toHaveText(text);
      await expect(tooltip).toHaveClass(/order-tooltip/);
      if (index === 0) await expect(window.getByLabel('예상 주문 금액').locator('.order-field-value')).toHaveText('672,000원');
      await expect(target).toHaveAttribute('aria-describedby', await tooltip.getAttribute('id') as string);
      await page.screenshot({ path: testInfo.outputPath(`book-amount-${index}-${price}.png`) });
      await page.mouse.move(0, 0);
      await expect(tooltip).toHaveCount(0);
      await page.mouse.move(0, 0);
      await target.hover();
      await expect(tooltip).toHaveText(text);
      await page.mouse.move(0, 0);
      await expect(tooltip).toHaveCount(0);
    }
    await frame.getByRole('button', { name: '원래 크기로 복원', exact: true }).click();
  }
  expect(commands).toHaveLength(0);
});

test('두 호가창의 시고저 칩·상세 가격은 일반 포커스로 열리지 않고 키보드와 호버 툴팁을 유지한다', async ({ page }) => {
  await page.route(/^https?:\/\/[^/]+\/api\/live\/krx-previous-close\?/, route => {
    const as_of = new URL(route.request().url()).searchParams.get('as_of');
    return route.fulfill({ json: { code: '005930', as_of, session_date: as_of,
      date: '20261014', price: 66000, fetched_at_ms: Date.now() } });
  });
  const { window, ws, commands } = await setup(page, false, false);
  const book = page.locator('.book-panel');
  await ws.waitForSubscribe('005930');
  ws.pushLive('005930', { kind: 'trade', venue: 'UN', t_ms: Date.now(),
    day_open: 67400, day_high: 68100, day_low: 66400,
    trades: [{ price: 67400, qty: 1, side: 1 }] });
  await expect(window.getByRole('img', { name: '시가 67,400원', exact: true })).toBeVisible();
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  const tooltip = page.getByRole('tooltip');
  for (const panel of [window, book]) {
    const frame = page.locator('[data-win]').filter({ has: panel });
    await frame.getByRole('button', { name: '창 최대화', exact: true }).click();
    await page.clock.runFor(200);
    const targets = [
      { target: panel.getByRole('img', { name: '시가 67,400원', exact: true }), text: '시가 67,400원' },
      { target: panel.getByLabel('시작 가격 67,400원'), text: '전일 KRX 종가 대비 +2.12%' },
    ];
    for (const { target, text } of targets) {
      await target.scrollIntoViewIfNeeded();
      await page.clock.runFor(200);
      // End pointer interaction, then restore focus without hovering the target.
      await target.click();
      await page.mouse.move(0, 0);
      await target.evaluate(el => (el as HTMLElement).blur());
      await target.focus();
      expect(await target.evaluate(el => el.matches(':focus-visible'))).toBe(false);
      await page.clock.runFor(600);
      await expect(tooltip).toHaveCount(0);
      await page.keyboard.press('Tab');
      await page.keyboard.press('Shift+Tab');
      await expect(target).toBeFocused();
      expect(await target.evaluate(el => el.matches(':focus-visible'))).toBe(true);
      await page.clock.runFor(500);
      await expect(tooltip).toHaveText(text);
      await page.keyboard.press('Escape');
      await expect(tooltip).toHaveCount(0);
      await target.hover();
      await page.clock.runFor(499);
      await expect(tooltip).toHaveCount(0);
      await page.clock.runFor(1);
      await expect(tooltip).toHaveText(text);
      await page.mouse.move(0, 0);
      await expect(tooltip).toHaveCount(0);
    }
    await frame.getByRole('button', { name: '원래 크기로 복원', exact: true }).click();
  }
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

test('하단 양쪽 주문 취소는 주문 열에 정렬되고 해당 방향만 취소한다', async ({ page }, testInfo) => {
  const { window, commands } = await setup(page, [mkOrder('buy'), { ...mkOrder('sell', '67300'), side: 'SELL' }]);
  const row = window.getByRole('group', { name: '방향별 주문 취소' });
  await expect(row.getByRole('button')).toHaveCount(2);
  await expect(row.getByRole('button', { name: /전체/ })).toHaveCount(0);
  const sell = row.getByRole('button', { name: '매도 주문 취소', exact: true });
  const buy = row.getByRole('button', { name: '매수 주문 취소', exact: true });
  for (const width of [820, 640, 540]) {
    await window.evaluate((el, width) => { el.style.width = `${width}px`; }, width);
    await expect(window).toHaveClass(width >= 696 ? /order-spacious/ : width >= 560 ? /order-expanded/ : /order-compact/);
    await expect(sell).toBeEnabled(); await expect(buy).toBeEnabled();
    for (const [cancel, label] of [[sell, '매도'], [buy, '매수']] as const) {
      const lane = window.getByRole('button', { name: new RegExp(`${label} 66,300원 주문 추가`) });
      await expect.poll(async () => {
        const a = (await cancel.boundingBox())!, b = (await lane.boundingBox())!;
        return Math.abs((a.x + a.width / 2) - (b.x + b.width / 2));
      }).toBeLessThan(1);
      const a = (await cancel.boundingBox())!, b = (await lane.boundingBox())!;
      expect(a.y).toBeGreaterThanOrEqual(b.y + b.height);
      expect(a.y - (b.y + b.height)).toBeLessThanOrEqual(3);
      expect(await cancel.evaluate(el => {
        const range = document.createRange(); range.selectNodeContents(el);
        return range.getBoundingClientRect().width <= el.clientWidth;
      })).toBe(true);
    }
    await window.screenshot({ path: testInfo.outputPath(`order-side-cancel-${width}.png`) });
  }
  await sell.click();
  await expect(sell).toBeDisabled();
  await expect(buy).toBeEnabled();
  expect(commands).toHaveLength(1);
  expect(commands[0]).toMatchObject({ account_seq: 1, code: '005930', side: 'SELL' });
  await buy.click();
  await expect(buy).toBeDisabled();
  expect(commands).toHaveLength(2);
  expect(commands[1]).toMatchObject({ account_seq: 1, code: '005930', side: 'BUY' });
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
  test(`평가손익 숫자 전환은 앞선 보유 항목 위치를 유지한다 (${priceOffset})`, async ({ page }) => {
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
        if (i < 2) expect(after[i]!.width).toBeCloseTo(before[i]!.width, 1);
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
  await expect(valuation.locator('.order-meta')).toHaveCount(0);
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
  await sell.hover();
  await sell.focus();
  await expect(window.getByLabel('예상 주문 금액').locator('.order-field-value')).toHaveText('3,360,000원');
  await expect(valuation.locator('.order-field-value')).toHaveText('120,000');
  await sell.click();
  expect(commands).toHaveLength(2);
  await expect(window.locator('[data-drag-order]')).toHaveCount(0);
  await sell.dblclick();
  await expect(window.getByLabel('매도 67,300원 주문', { exact: true })).toHaveText('50');
  expect(commands[2]).toMatchObject({ side: 'SELL', quantity: 50 });
  await window.getByLabel('신규 주문 수량').fill('10');
  await expect(window.getByLabel('예상 주문 금액').locator('.order-field-value')).toHaveText('672,000원');
  await sell.hover();
  await expect(window.getByLabel('예상 주문 금액').locator('.order-field-value')).toHaveText('672,000원');
  await window.screenshot({ path: testInfo.outputPath('unified-order-controls.png') });
});

test('보유 63주 클릭은 미체결 매도 20주를 제외한 43주를 입력하고 주문을 전송하지 않는다', async ({ page }) => {
  const sell = { ...mkOrder('reserved-sell', '67300', '10'), side: 'SELL', quantity: '30' };
  const { window, commands } = await setup(page, [sell], false, false, 0, 1, { holdingQuantity: '63', sellableQuantity: '43' });
  const holding = window.getByLabel('매입수량');
  await expect(holding).toContainText('63');
  await expect(holding).toBeEnabled();
  await holding.click();
  await expect(window.getByLabel('신규 주문 수량')).toHaveValue('43');
  await window.getByRole('button', { name: '금액', exact: true }).click();
  await holding.click();
  await expect(window.getByLabel('신규 주문 수량')).toHaveValue('43');
  await expect(window.getByRole('button', { name: '금액', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(window.getByRole('button', { name: '100만', exact: true })).toBeVisible();
  await expect(holding).toContainText('63');
  expect(commands).toHaveLength(0);
});

test('압축형 주·금액 전환은 수량 한 칸을 유지하고 금액 버튼은 현재가로 한 번 환산한다', async ({ page }, testInfo) => {
  const { window, commands, ws } = await setup(page, false, false);
  await ws.waitForSubscribe('005930');
  const mode = window.getByRole('group', { name: '빠른 입력 방식' });
  await window.getByRole('spinbutton', { name: '신규 주문 수량' }).fill('37');
  await mode.getByRole('button', { name: '금액', exact: true }).click();
  await expect(window.getByRole('spinbutton', { name: '신규 주문 수량' })).toHaveValue('37');
  await window.getByRole('button', { name: '100만', exact: true }).click();
  await mode.getByRole('button', { name: '주', exact: true }).click();
  await expect(window.getByRole('spinbutton', { name: '신규 주문 수량' })).toHaveValue('14');
  await mode.getByRole('button', { name: '금액', exact: true }).click();
  await expect(window.getByRole('spinbutton', { name: '신규 주문 수량' })).toHaveValue('14');
  await expect(window.getByRole('spinbutton')).toHaveCount(1);
  ws.pushLive('005930', { kind: 'trade', venue: 'UN', t_ms: Date.now(), prev_close: 66000,
    trades: [{ price: 75000, qty: 1, side: 1 }] });
  await expect(window.getByRole('button', { name: '100만', exact: true })).toHaveAttribute('title', '현재가 75,000원 기준으로 수량 환산');
  await expect(window.getByRole('spinbutton', { name: '신규 주문 수량' })).toHaveValue('14');
  expect(commands).toHaveLength(0);
  const buy = window.getByRole('button', { name: /매수 68,200원 주문 추가/ });
  await buy.hover();
  await expect(window.getByLabel('예상 주문 금액').locator('.order-field-value')).toHaveText('1,050,000원');
  await window.screenshot({ path: testInfo.outputPath('compact-amount-controls.png') });
  await buy.dblclick();
  expect(commands).toHaveLength(1);
  expect(commands[0]).toMatchObject({ price: 68200, quantity: 14 });
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

test('주문 설정은 즉시 저장하고 버튼 앵커·바깥 클릭·재클릭·Escape로 닫는다', async ({ page }, testInfo) => {
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
    const navigation = dialog.getByRole('navigation', { name: '주문 설정 목차' });
    await navigation.getByRole('button', { name: '주문 알림', exact: true }).click();
    await expect(dialog.getByRole('button', { name: '소리 들어보기' })).toBeInViewport();
    await expect(dialog.getByRole('button', { name: '닫기', exact: true })).toBeInViewport();
    await navigation.getByRole('button', { name: '주문 입력', exact: true }).click();
    await expect(dialog.getByRole('spinbutton', { name: '수량 프리셋 1', exact: true })).toBeInViewport();
    await dialog.getByRole('spinbutton', { name: '수량 프리셋 1', exact: true }).fill('29');
    await settings.click();
    await expect(dialog).toHaveCount(0);
    await expect(settings).toHaveAttribute('aria-expanded', 'false');
    await settings.click();
    await expect(dialog.getByRole('spinbutton', { name: '수량 프리셋 1', exact: true })).toHaveValue('29');
    await dialog.getByRole('spinbutton', { name: '수량 프리셋 1', exact: true }).fill('31');
    // The buying-power label can be covered by the anchored popover.
    await window.getByRole('spinbutton', { name: '신규 주문 수량' }).click();
    await expect(dialog).toHaveCount(0);
    await settings.click();
    await expect(dialog.getByRole('spinbutton', { name: '수량 프리셋 1', exact: true })).toHaveValue('31');
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
  await expect(dialog.getByRole('button', { name: '닫기', exact: true })).toBeInViewport();
  await expect.poll(() => dialog.locator('.order-settings-body').evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
  await dialog.screenshot({ path: testInfo.outputPath('order-settings-short-viewport.png') });
  await dialog.getByRole('button', { name: '주문 설정 닫기' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(settings).toBeFocused();
  expect(commands).toHaveLength(0);
});

test('계좌 편집기 탐색·목록·푸터는 테마와 화면 폭에 맞춰 표시된다', async ({ page }, testInfo) => {
  const { window, commands } = await setup(page, [mkOrder('old')]);
  await page.route(/^https?:\/\/[^/]+\/api\/live\/quotes\?/, route => route.fulfill({ json: {
    phase: 'open', quotes: (new URL(route.request().url()).searchParams.get('codes') ?? '').split(',')
      .map(code => ({ code, price: code === '000660' ? 185000 : 67200 })),
  } }));
  for (const theme of ['toss-light', 'toss-dark']) {
    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 800 });
      const trigger = window.getByRole('button', { name: '미체결 주문', exact: true });
      await trigger.scrollIntoViewIfNeeded();
      await trigger.click();
      const panel = page.getByRole('dialog', { name: '계좌 목록' });
      await expect(panel.getByRole('heading', { name: '계좌 목록', exact: true })).toBeVisible();
      await expect(panel.getByRole('heading', { name: '미체결 주문 1건' })).toBeVisible();
      await expect(panel.getByText('취소 요청은 즉시 전송됩니다.', { exact: true })).toBeInViewport();
      const tabs = panel.getByRole('tablist', { name: '계좌 목록 종류' });
      await expect(tabs).toHaveAttribute('aria-orientation', width < 560 ? 'horizontal' : 'vertical');
      await panel.screenshot({ path: testInfo.outputPath(`order-editor-orders-${theme}-${width}.png`) });
      await panel.getByRole('tab', { name: '보유종목', exact: true }).click();
      await expect(panel.getByRole('heading', { name: '보유종목 1종목' })).toBeVisible();
      await expect(panel.getByRole('button', { name: 'SK하이닉스', exact: true })).toBeVisible();
      await expect(panel.getByRole('columnheader', { name: '수익', exact: true })).toBeVisible();
      const profit = panel.getByRole('row').filter({ hasText: 'SK하이닉스' }).getByRole('cell').nth(4);
      await expect(profit).toHaveText('+110,000원+2.78%');
      await expect(profit).toHaveClass(/text-price-up/);
      expect(await profit.locator('span').evaluateAll(values => {
        const amount = values[0].getBoundingClientRect(), percent = values[1].getBoundingClientRect();
        return percent.top >= amount.bottom && values.every(value => value.scrollWidth <= value.clientWidth);
      })).toBe(true);
      const bounds = (await panel.boundingBox())!;
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(800);
      if (width === 390) {
        expect(await panel.getByRole('tabpanel').evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true);
      }
      await panel.screenshot({ path: testInfo.outputPath(`order-editor-holdings-${theme}-${width}.png`) });
      await page.keyboard.press('Escape');
      await expect(panel).toHaveCount(0);
      await expect(window.getByRole('button', { name: '보유종목', exact: true })).toBeFocused();
    }
  }
  expect(commands).toHaveLength(0);
});

test('주문 설정은 즉시 저장하고 잘못된 입력은 제외하며 금액 프리셋으로 주문한다', async ({ page }, testInfo) => {
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
  await dialog.getByRole('button', { name: '닫기', exact: true }).click();
  await expect(window.getByRole('spinbutton', { name: '신규 주문 수량' })).toHaveValue('25');
  await settings.click();
  await expect(dialog.getByRole('spinbutton', { name: '수량 프리셋 1', exact: true })).toHaveValue('25');
  for (const [index, value] of [25, 75, 250].entries()) await dialog.getByRole('spinbutton', { name: `수량 프리셋 ${index + 1}`, exact: true }).fill(String(value));
  for (const [index, value] of [2, 6, 12].entries()) await dialog.getByRole('spinbutton', { name: `금액 프리셋 ${index + 1}`, exact: true }).fill(String(value));
  await dialog.getByRole('spinbutton', { name: '금액 프리셋 1', exact: true }).fill('1.5');
  await expect(dialog.getByRole('alert')).toContainText('양의 정수만 저장');
  await expect(dialog.getByRole('button', { name: '닫기', exact: true })).toBeEnabled();
  await dialog.getByRole('spinbutton', { name: '금액 프리셋 1', exact: true }).fill('2');
  await page.screenshot({ path: testInfo.outputPath('order-settings-dialog.png') });
  await dialog.getByRole('button', { name: '닫기', exact: true }).click();
  await expect(settings).toBeFocused();
  await window.getByRole('button', { name: '금액', exact: true }).click();
  await expect(window.getByRole('spinbutton', { name: '신규 주문 수량' })).toHaveValue('25');
  await window.getByRole('button', { name: '600만', exact: true }).click();
  await expect(window.getByRole('spinbutton', { name: '신규 주문 수량' })).toHaveValue('89');
  const buy = window.getByRole('button', { name: /매수 68,200원 주문 추가/ });
  await buy.hover();
  // The estimate uses the current quote; the actual order uses the clicked level.
  await expect(window.getByLabel('예상 주문 금액').locator('.order-field-value')).toHaveText('5,980,800원');
  await buy.dblclick();
  await expect(window.getByLabel('매수 68,200원 주문', { exact: true })).toHaveText('89');
  expect(commands[0]).toMatchObject({ side: 'BUY', price: 68200, quantity: 89 });
  await settings.click();
  await dialog.getByRole('spinbutton', { name: '수량 프리셋 1', exact: true }).fill('30');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(frame.getByRole('button', { name: '원래 크기로 복원', exact: true })).toBeVisible();
  expect(await frame.boundingBox()).toEqual(bounds);
  await expect(window.getByRole('spinbutton', { name: '신규 주문 수량' })).toHaveValue('89');
  await window.screenshot({ path: testInfo.outputPath('order-amount-controls.png') });
});

test('평단가 표시 체크박스는 즉시 저장하며 다른 주문 창에는 영향을 주지 않는다', async ({ page }, testInfo) => {
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
  await expect(first.locator('.order-average-marker')).toHaveCount(0);
  await dialog.getByRole('button', { name: '닫기', exact: true }).click();
  await settings.click();
  await expect(checkbox).not.toBeChecked();
  await checkbox.uncheck();
  await dialog.getByRole('button', { name: '닫기', exact: true }).click();
  await expect(first.locator('.order-average-marker')).toHaveCount(0);
  await expect(first.getByLabel('매입평단가')).toContainText('67,001');
  await page.reload();
  await expect(first.getByLabel('매입평단가')).toContainText('67,001');
  await expect(first.locator('.order-average-marker')).toHaveCount(0);
  await settings.click();
  await expect(checkbox).not.toBeChecked();
  await dialog.getByRole('button', { name: '닫기', exact: true }).click();
  await page.getByTestId('workspace-add-menu-button').click();
  await page.getByTestId('workspace-add-order').click();
  const second = page.getByTestId('order-window').nth(1);
  await expect(second.locator('.order-average-marker')).toHaveCount(1);
  await second.getByRole('button', { name: '주문 설정', exact: true }).click();
  await expect(checkbox).toBeChecked();
  await dialog.getByRole('button', { name: '닫기', exact: true }).click();
  await page.locator('[data-win]').filter({ has: page.getByTestId('order-window') }).nth(1)
    .getByRole('button', { name: '삼성전자 호가 주문 창 닫기', exact: true }).click();
  await settings.click();
  await checkbox.check();
  await dialog.getByRole('button', { name: '닫기', exact: true }).click();
  await expect(first.locator('.order-average-marker')).toHaveCount(1);
  expect(commands).toHaveLength(0);
});

test('빠른 입력 방식·프리셋은 새로고침 후 유지하고 다른 주문창과 독립적이다', async ({ page }) => {
  const { window } = await setup(page);
  await window.getByRole('button', { name: '금액', exact: true }).click();
  await window.getByRole('button', { name: '주문 설정', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '주문 설정', exact: true });
  await dialog.getByRole('spinbutton', { name: '수량 프리셋 1', exact: true }).fill('25');
  await dialog.getByRole('spinbutton', { name: '금액 프리셋 1', exact: true }).fill('2');
  await dialog.getByRole('button', { name: '닫기', exact: true }).click();
  await page.reload();
  await expect(window.getByRole('spinbutton', { name: '신규 주문 수량' })).toHaveValue('25');
  await expect(window.getByRole('button', { name: '200만', exact: true })).toBeVisible();
  await window.getByRole('button', { name: '200만', exact: true }).click();
  await expect(window.getByRole('spinbutton', { name: '신규 주문 수량' })).toHaveValue('29');
  await window.getByRole('button', { name: '주문 설정', exact: true }).click();
  await expect(dialog.getByRole('radio')).toHaveCount(0);
  await expect(window.getByRole('button', { name: '금액', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(dialog.getByRole('spinbutton', { name: '수량 프리셋 1', exact: true })).toHaveValue('25');
  await dialog.getByRole('button', { name: '닫기', exact: true }).click();
  const restore = page.locator('[data-win]').filter({ has: window }).getByRole('button', { name: '원래 크기로 복원', exact: true });
  if (await restore.count()) await restore.click();
  await page.getByTestId('workspace-add-menu-button').click();
  await page.getByTestId('workspace-add-order').click();
  const second = page.getByTestId('order-window').nth(1);
  await expect(second.getByRole('spinbutton', { name: '신규 주문 수량' })).toHaveValue('10');
  await expect(page.getByTestId('order-window').first().getByRole('spinbutton', { name: '신규 주문 수량' })).toHaveValue('29');
  await second.getByRole('button', { name: '주문 설정', exact: true }).click();
  await dialog.getByRole('spinbutton', { name: '수량 프리셋 1', exact: true }).fill('30');
  await dialog.getByRole('button', { name: '닫기', exact: true }).click();
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
      await expect(strip).toHaveText(`${ask}시간외종가 · 15:48:05${bid}`);
      await expect(strip.getByTestId('book-total-fill')).toBeVisible();
      expect(await strip.getByTestId('book-total-fill').evaluate(el => (el as HTMLElement).style.gridTemplateColumns)).toBe(`${ask}fr ${bid}fr`);
    }
  }
  expect(commands).toHaveLength(0);
});

test('VI처럼 호가가 줄어도 중앙 경계·체결 위치를 유지하고 빈 슬롯은 주문 대상이 아니다', async ({ page }, testInfo) => {
  const { window, ws, commands } = await setup(page, true);
  const book = page.locator('.book-panel');
  await ws.waitForSubscribe('005930');
  const ladder = window.locator('.order-ladder');
  const divider = window.locator('.order-divider');
  const initialY = (await divider.boundingBox())!.y;
  const frame = { kind: 'ob', venue: 'UN', t_ms: Date.now(),
    asks: Array.from({ length: 10 }, (_, i) => ({ price: 67300 + i * 100, qty: i === 0 ? 0 : 100 + i })),
    bids: Array.from({ length: 10 }, (_, i) => ({ price: 67200 - i * 100, qty: 200 + i })),
    total_ask_qty: 1000, total_bid_qty: 2000 };
  ws.pushLive('005930', { kind: 'trade', venue: 'UN', t_ms: frame.t_ms,
    fill_strength_pct: 75.14, trades: Array.from({ length: 9 }, (_, i) => ({ price: 67200, qty: 901 + i, side: 1 })) });
  let nextTimestamp = frame.t_ms;
  for (const [askCount, bidCount] of [[3, 3], [0, 3], [3, 0], [10, 10]]) {
    ws.pushLive('005930', { ...frame, t_ms: ++nextTimestamp,
      asks: frame.asks.map((level, i) => i < askCount ? level : { price: 0, qty: 0 }),
      bids: frame.bids.map((level, i) => i < bidCount ? level : { price: 0, qty: 0 }) });
    await expect(window.locator('[data-order-price]')).toHaveCount(askCount + bidCount);
    await expect(window.locator('.order-row')).toHaveCount(20);
    await expect(window.locator('.order-empty button, .order-empty [data-order-price]')).toHaveCount(0);
    await expect(window.locator('.order-row').nth(10)).toContainText('체결강도');
    await expect(window.locator('.order-row').nth(19).locator('.order-info')).toContainText('901');
    await expect(window.getByTestId('book-summary')).toBeVisible();
    await expect(book.locator('.book-price-value')).toHaveCount(askCount + bidCount);
    await expect(async () => {
      const centered = await book.evaluate(el => {
        const region = el.querySelector('.book-scroll-region')!.getBoundingClientRect();
        const dividers = [...el.querySelectorAll('[data-book-divider]')].map(node => node.getBoundingClientRect().y);
        return dividers.length === 3 && dividers.every(y => Math.abs(y - (region.y + region.height / 2)) < 1);
      });
      expect(centered).toBe(true);
    }).toPass();
    const bounds = (await ladder.boundingBox())!;
    expect((await divider.boundingBox())!.y).toBeCloseTo(bounds.y + bounds.height / 2, 1);
    if (askCount === 3 && bidCount === 3) {
      expect((await divider.boundingBox())!.y).toBeCloseTo(initialY, 1);
      const viewport = (await window.locator('.order-scroll').boundingBox())!;
      expect((await divider.boundingBox())!.y).toBeCloseTo(viewport.y + viewport.height / 2, 1);
      await expect(window.locator('.order-ask').last()).toHaveText('0');
      const empty = window.locator('.order-row').nth(19);
      await empty.dblclick();
      await drag(page, window.getByLabel('매수 67,200원 주문', { exact: true }), empty);
      expect(commands).toHaveLength(0);
      await window.screenshot({ path: testInfo.outputPath('order-partial-centered.png') });
    }
  }
  await page.setViewportSize({ width: 1440, height: 600 });
  await expect.poll(() => window.locator('.order-scroll').evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
  await expect(window.locator('.order-row').first()).toHaveCSS('height', '24px');
  await window.locator('.order-row').last().scrollIntoViewIfNeeded();
  await expect(window.locator('.order-row').last()).toBeInViewport();
  expect(commands).toHaveLength(0);
});

for (const venue of ['KRX', 'NXT', 'UN'] as const) {
  test(`${venue} 장중 0H는 두 호가창에 예상가만 표시하고 체결 재개 시 지운다`, async ({ page }) => {
    const { window, ws, commands } = await setup(page, false, false, false, 0, 1, { venue });
    const book = page.locator('.book-panel');
    await ws.waitForSubscribe('005930');
    const t_ms = Date.now();
    const expected = { kind: 'expected', venue, t_ms, expected_price: 121100, expected_qty: 5152 };
    ws.pushLive('005930', expected);
    for (const panel of [window, book]) {
      await expect(panel.getByTestId('book-expected-fill')).toHaveText('예상 체결가121,100원');
    }
    ws.pushLive('005930', { kind: 'ob', venue, t_ms: t_ms + 1,
      asks: [{ price: 67300, qty: 100 }], bids: [{ price: 67200, qty: 200 }],
      total_ask_qty: 100, total_bid_qty: 200,
    });
    for (const panel of [window, book]) {
      await expect(panel.getByTestId('book-expected-fill')).toHaveText('예상 체결가121,100원');
    }
    ws.pushLive('005930', { ...expected, venue: venue === 'KRX' ? 'NXT' : 'KRX', t_ms: t_ms + 2,
      expected_price: 999999, expected_qty: 999 });
    ws.pushLive('005930', { ...expected, t_ms: t_ms + 3, expected_price: 121200, expected_qty: 6000 });
    for (const panel of [window, book]) {
      await expect(panel.getByTestId('book-expected-fill')).toHaveText('예상 체결가121,200원');
    }
    ws.pushLive('005930', { kind: 'trade', venue, t_ms: t_ms + 4,
      trades: [{ price: 121100, qty: 1, side: 1 }] });
    for (const panel of [window, book]) await expect(panel.getByTestId('book-expected-fill')).toHaveCount(0);
    ws.pushLive('005930', expected);
    for (const panel of [window, book]) await expect(panel.getByTestId('book-expected-fill')).toHaveCount(0);
    expect(commands).toHaveLength(0);
  });
}

for (const venue of ['KRX', 'UN'] as const) {
  test(`${venue} 0H 거래량은 두 호가창의 0D 예상체결량을 덮어쓰지 않는다`, async ({ page }, testInfo) => {
    const { window, ws, commands } = await setup(page, false, false, false, 0, 1, { venue });
    const book = page.locator('.book-panel');
    const panels = [window, book];
    await ws.waitForSubscribe('005930');
    const t_ms = Date.now();
    const expected = { kind: 'expected', venue, t_ms, expected_price: 1241000, expected_qty: 3 };
    ws.pushLive('005930', expected);
    for (const panel of panels) {
      await expect(panel.getByTestId('book-expected-fill')).toHaveText('예상 체결가1,241,000원');
    }
    const frame = { kind: 'ob', venue, t_ms,
      asks: [{ price: 1240000, qty: 100 }], bids: [{ price: 1239000, qty: 200 }],
      total_ask_qty: 55619, total_bid_qty: 18449, expected_price: 1240000, expected_qty: 363789 };
    ws.pushLive('005930', frame);
    for (const panel of panels) {
      await expect(panel.getByTestId('book-expected-fill')).toHaveText('예상 체결가1,240,000원예상 체결량363,789');
    }
    for (const offset of [0, 1000]) {
      ws.pushLive('005930', { ...expected, t_ms: t_ms + offset });
      // A subsequent orderbook proves the WS batch was consumed before checking the banner.
      ws.pushLive('005930', { ...frame, t_ms: t_ms + offset, expected_price: 0, expected_qty: 0,
        total_ask_qty: 55620 + offset });
      await expect(book.getByTestId('book-total-strip')).toContainText((55620 + offset).toLocaleString('ko-KR'));
      for (const panel of panels) {
        await expect(panel.getByTestId('book-expected-fill')).toHaveText('예상 체결가1,240,000원예상 체결량363,789');
      }
    }
    // Small, genuine expected quantities and decreases remain valid.
    ws.pushLive('005930', { ...frame, t_ms: t_ms + 2000, expected_price: 1239000, expected_qty: 1 });
    for (const panel of panels) {
      await expect(panel.getByTestId('book-expected-fill')).toHaveText('예상 체결가1,239,000원예상 체결량1');
    }
    await book.screenshot({ path: testInfo.outputPath('expected-quantity-source.png') });
    ws.pushLive('005930', { kind: 'trade', venue, t_ms: t_ms + 3000,
      trades: [{ price: 1239000, qty: 1, side: 1 }] });
    for (const panel of panels) await expect(panel.getByTestId('book-expected-fill')).toHaveCount(0);
    expect(commands).toHaveLength(0);
  });
}

for (const venue of ['KRX', 'NXT', 'UN'] as const) {
  test(`${venue} 동시호가의 잔량 증감은 호가 옆에 표시하고 예상체결량과 구분한다`, async ({ page }, testInfo) => {
    const { window, ws, commands } = await setup(page, false, false, false, 0, 1, { venue });
    const book = page.locator('.book-panel');
    const panels = [window, book];
    await ws.waitForSubscribe('005930');
    const t_ms = Date.now();
    const frame = { kind: 'ob', venue, t_ms,
      asks: Array.from({ length: 10 }, (_, i) => i < 3 ? { price: 67300 + i * 100, qty: 100 + i } : { price: 0, qty: 0 }),
      bids: Array.from({ length: 10 }, (_, i) => i < 3 ? { price: 67200 - i * 100, qty: 200 + i } : { price: 0, qty: 0 }),
      total_ask_qty: 303, total_bid_qty: 603, expected_price: 67200, expected_qty: 323557 };
    ws.pushLive('005930', frame);
    for (const panel of panels) {
      await expect(panel.getByTestId('book-expected-fill')).toHaveText('예상 체결가67,200원예상 체결량323,557');
      await expect(panel.locator('.book-qty-delta')).toHaveCount(0);
    }
    const changed = { ...frame,
      asks: frame.asks.map((level, i) => i === 0 ? { ...level, qty: 125 } : level),
      bids: frame.bids.map((level, i) => i === 0 ? { ...level, qty: 160 } : level),
      total_ask_qty: 328, total_bid_qty: 563 };
    // Same-second 0D changes and a legacy 0H quantity must reach separate UI fields.
    const indication = { kind: 'expected', venue, t_ms, expected_price: 67300, expected_qty: 3 };
    ws.pushBatch('005930', [changed, indication], [changed, indication]);
    for (const panel of panels) {
      await expect(panel.locator('.book-qty-delta').getByText('+25', { exact: true })).toBeVisible();
      await expect(panel.locator('.book-qty-delta').getByText('−40', { exact: true })).toBeVisible();
      await expect(panel.getByTestId('book-expected-fill')).toHaveText('예상 체결가67,200원예상 체결량323,557');
    }
    await book.screenshot({ path: testInfo.outputPath('auction-quantity-deltas.png') });
    expect(commands).toHaveLength(0);
  });
}

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
  for (const panel of [window, book]) await expect(panel.getByTestId('book-expected-fill')).toBeVisible();
  ws.pushLive('005930', { kind: 'trade', venue: 'UN', t_ms: frame.t_ms + 2,
    trades: [{ price: 241000, qty: 1, side: 1 }] });
  for (const panel of [window, book]) await expect(panel.getByTestId('book-expected-fill')).toHaveCount(0);
  expect(commands).toHaveLength(0);
});

test('호가 주문 가격·잔량·총잔량 폰트는 기존 10호가창과 동일하다', async ({ page }) => {
  const { window } = await setup(page);
  await page.getByTestId('workspace-add-menu-button').click();
  await page.getByTestId('workspace-add-book').click();
  const book = page.locator('.book-panel');
  await expect(book.locator('.book-price-value').first()).toBeAttached();
  const dataFont = await book.locator('.book-price-value').first().evaluate(el => getComputedStyle(el).fontSize);
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
    expect(askBox.width).toBeCloseTo(bidBox.width, 1);
    const barWidth = (field: Locator) => field.evaluate(el => parseFloat(getComputedStyle(el, '::before').width));
    expect(await barWidth(ask)).toBeGreaterThan(0);
    expect(await barWidth(ask)).toBeCloseTo(await barWidth(bid), 1);
    expect(await ask.evaluate(el => getComputedStyle(el, '::before').right)).toBe('3px');
    expect(await bid.evaluate(el => getComputedStyle(el, '::before').left)).toBe('3px');
    const rowBox = (await window.locator('.order-row').first().boundingBox())!;
    const priceBox = (await window.locator('.order-price').first().boundingBox())!;
    expect(priceBox.x + priceBox.width / 2).toBeCloseTo(rowBox.x + rowBox.width / 2, 1);
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

for (const uncertain of [false, true]) {
  test(`묶음 취소 일부 실패 uncertain=${uncertain}는 확정 거절과 결과 불명확의 재확인을 구분한다`, async ({ page }) => {
    await page.route(/^https?:\/\/[^/]+\/api\//, route => route.fulfill({ status: 404, json: { detail: 'not mocked' } }));
    await page.route('**/config.json', route => route.fulfill({ json: { api_url: '' } }));
    const { window, commands } = await setup(page, [mkOrder('one'), mkOrder('two')]);
    const failures: Record<string, unknown>[] = [];
    await page.route(/\/api\/trading\/orders\/two\/cancel$/, async route => {
      if (failures.length) { await route.fallback(); return; }
      failures.push(route.request().postDataJSON());
      await route.fulfill({ status: uncertain ? 503 : 409, json: { detail: {
        code: uncertain ? 'order-outcome-unknown' : 'cancel-rejected', message: uncertain ? '취소 결과 확인 필요' : '취소 거절',
      } } });
    });
    const cell = window.getByRole('button', { name: /매수 67,200원 주문 추가/ });
    await drag(page, cell, window.getByRole('button', { name: '주문 설정', exact: true }));
    await expect(cell).toHaveText('70');
    await expect(page.getByRole('alert', { name: '주문 알림' })).toContainText('취소 미접수 1건');
    expect(commands).toHaveLength(1);
    const retry = page.getByRole('button', { name: '같은 요청 다시 확인' });
    if (uncertain) {
      await expect(retry).toBeEnabled();
      await retry.click();
    } else {
      await expect(retry).toHaveCount(0);
      await drag(page, cell, window.getByRole('button', { name: '주문 설정', exact: true }));
    }
    await expect(cell).toBeEmpty();
    expect(commands).toHaveLength(2);
    if (uncertain) expect(commands[1].command_id).toBe(failures[0].command_id);
    else expect(commands[1].command_id).not.toBe(failures[0].command_id);
  });
}

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

test('하단의 호가 밖 주문 뱃지는 숨기고 미체결 주문 목록에서 조회·취소한다', async ({ page }) => {
  const { window, commands } = await setup(page, [mkOrder('outside', '70000')]);
  await expect(window.locator('.order-outside')).toHaveCount(0);
  await expect(window.getByRole('button', { name: '호가 밖 매수 70,000원 주문', exact: true })).toHaveCount(0);
  await window.getByRole('button', { name: '미체결 주문', exact: true }).click();
  const panel = page.getByRole('dialog', { name: '계좌 목록' });
  await expect(panel.getByRole('cell', { name: '70,000', exact: true })).toBeVisible();
  await expect(panel.getByRole('cell', { name: '70', exact: true })).toBeVisible();
  expect(commands).toHaveLength(0);
  await panel.getByRole('button', { name: '삼성전자 매수 주문 1 취소', exact: true }).click();
  await expect(panel.getByRole('status')).toHaveText('삼성전자 취소 요청 접수됨');
  expect(commands).toHaveLength(1);
  expect(commands[0]).toMatchObject({ account_seq: 1, code: '005930' });
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

test('호가주문 고정 열은 자릿수·부호·금액과 % 전환에도 상단과 호가 위치를 유지한다', async ({ page }, testInfo) => {
  const { window, commands } = await setup(page, false, true, false, 57600, 1,
    { holdingQuantity: '267', averagePrice: '124901.64' });
  await page.mouse.move(0, 0);
  await page.evaluate(() => document.fonts.ready);
  await window.evaluate(el => { (el as HTMLElement).style.width = '576px'; });
  const bounds = (await window.boundingBox())!;
  const controls = (await window.locator('.order-quantity-controls').boundingBox())!;
  await page.screenshot({ path: testInfo.outputPath('compact-summary.png'),
    clip: { x: bounds.x, y: bounds.y, width: bounds.width, height: controls.y + controls.height - bounds.y } });
  const values = [
    ['.order-buying-power .order-field-value', '1원', '999,999,999,999원'],
    ['.order-holding-quantity .order-field-value', '1', '999,999,999'],
    ['[aria-label="매입평단가"] .order-field-value', '1', '9,999,999'],
    ['.order-profit-toggle .order-field-value', '1', '-999,999,999,999'],
    ['.order-estimate .order-field-value', '1원', '999,999,999,999원'],
    // Price/rate digit changes use real snapshots in the ladder layout tests.
    ['.order-depth-qty', '1', '999,999,999'],
    ['[data-testid="book-total-strip"] [aria-label^="매도총잔량"]', '1', '999,999,999'],
    ['[data-testid="book-total-strip"] [aria-label^="매수총잔량"]', '1', '99'],
  ];
  const anchors = [
    '.order-price', '.order-price small', '.order-depth', '.order-lane',
    '.order-overview-controls', '.order-holding-quantity', '[aria-label="매입평단가"]',
    '.order-profit-toggle', '.order-buying-power', '.order-buying-power .order-meta', '.order-buying-power .order-field-value',
  ];
  const measure = () => window.evaluate((el, selectors) => {
    const origin = el.querySelector('.order-row')!.getBoundingClientRect();
    return Object.fromEntries(selectors.flatMap(selector => {
      const node = el.querySelector(selector);
      if (!node) return [];
      const { x, y, width, height } = node.getBoundingClientRect();
      return [[selector, { x: x - origin.x, y: y - origin.y, width, height }]];
    }));
  }, anchors);
  const setDigits = async (long: boolean) => {
    await window.evaluate((el, { values, long }) => {
      // Stress only formatted text to isolate layout from polling, venues and order state.
      for (const [selector, shortText, longText] of values) {
        for (const node of el.querySelectorAll(selector)) {
          // Preserve day/average marker children while changing the formatted price text.
          const value = node.querySelector('.book-price-amount') ?? node;
          const text = [...value.childNodes].find(child => child.nodeType === Node.TEXT_NODE);
          if (text) text.textContent = long ? longText : shortText;
          else value.append(document.createTextNode(long ? longText : shortText));
        }
      }
    }, { values, long });
  };
  const results = [];
  for (const width of [800, 576, 504, 360, 320]) {
    await window.evaluate((el, width) => { (el as HTMLElement).style.width = `${width}px`; }, width);
    await expect(window).toHaveClass(width < 560 ? /order-compact/ : /order-expanded/);
    await setDigits(false);
    await expect(window.locator('.order-holdings-summary .order-meta')).toHaveCount(0);
    const gaps = await window.evaluate(el => {
      const cash = el.querySelector('.order-buying-power')!.getBoundingClientRect();
      const summary = el.querySelector('.order-holdings-summary')!.getBoundingClientRect();
      const fields = [...el.querySelectorAll('.order-holdings-summary > .order-field')].map(field => field.getBoundingClientRect());
      const overview = el.querySelector('.order-overview-controls')!;
      const style = getComputedStyle(overview);
      return { cashGap: cash.left - summary.right, cashBelow: cash.top >= summary.bottom + 7,
        cashRight: cash.right, contentRight: overview.getBoundingClientRect().right - parseFloat(style.paddingRight),
        items: fields.slice(1).map((field, i) => field.left - fields[i].right) };
    });
    expect(gaps.cashRight).toBeCloseTo(gaps.contentRight, 1);
    expect(gaps.cashBelow).toBe(width < 510);
    if (width >= 510) expect(gaps.cashGap).toBeGreaterThanOrEqual(8);
    for (const gap of gaps.items) expect(gap).toBeCloseTo(8, 1);
    const labelGaps = await window.evaluate(el => [...el.querySelectorAll('.order-buying-power, .order-estimate')].map(field => {
      const label = field.querySelector('.order-meta')!.getBoundingClientRect();
      const value = field.querySelector('.order-field-value')!;
      const text = value.getBoundingClientRect();
      const inline = Math.abs((label.top + label.bottom) / 2 - (text.top + text.bottom) / 2) < 4;
      return { inline, gap: inline ? text.left - label.right : text.left - label.left };
    }));
    for (const { inline, gap } of labelGaps) {
      if (inline) { expect(gap).toBeGreaterThanOrEqual(0); expect(gap).toBeLessThanOrEqual(6); }
      else expect(Math.abs(gap)).toBeLessThanOrEqual(1);
    }
    const before = await measure();
    const priceRight = await window.locator('.book-price-amount').first().evaluate(el => el.getBoundingClientRect().right);
    const profitToggle = window.getByRole('button', { name: '평가손익 표시 전환', exact: true });
    await profitToggle.dblclick();
    expect(await measure()).toEqual(before);
    await profitToggle.dblclick();
    expect(await measure()).toEqual(before);
    await setDigits(true);
    const after = await measure();
    // The badge follows the text's start; the price column and numeric right edge stay fixed.
    expect(await window.locator('.book-price-amount').first().evaluate(el => el.getBoundingClientRect().right)).toBeCloseTo(priceRight, 1);
    for (const selector of Object.keys(before)) {
      for (const coordinate of ['x', 'y', 'width', 'height'] as const) {
        expect(after[selector][coordinate], `${width}px ${selector} ${coordinate}`).toBeCloseTo(before[selector][coordinate], 1);
      }
    }
    expect(await window.evaluate((el, values) => values.every(([selector]) => [...el.querySelectorAll<HTMLElement>(selector)]
      .every(node => {
        if (!node.closest('.order-holdings-summary, .order-buying-power')) return node.scrollWidth <= node.clientWidth + 1;
        const style = getComputedStyle(node);
        const maxScroll = node.scrollWidth - node.clientWidth;
        node.scrollLeft = maxScroll;
        const reachable = maxScroll <= 1 || node.scrollLeft > 0;
        node.scrollLeft = 0;
        return style.textAlign === 'right' && style.overflowX === 'auto' && reachable;
      })), values), `${width}px full numeric values remain reachable`).toBe(true);
    await window.screenshot({ path: testInfo.outputPath(`stable-numbers-${width}.png`) });
    await setDigits(false);
    expect(await measure()).toEqual(before);
    results.push({ width, before, after });
  }
  await testInfo.attach('digit-layout', { body: JSON.stringify(results, null, 2), contentType: 'application/json' });
  expect(commands).toHaveLength(0);
});

test('호가주문 예상 체결가·체결량의 자릿수 변경은 배치를 유지한다', async ({ page }) => {
  const { window, ws, commands } = await setup(page);
  await ws.waitForSubscribe('005930');
  const frame = { kind: 'ob', venue: 'UN', t_ms: Date.now(),
    asks: [{ price: 67300, qty: 100 }], bids: [{ price: 67200, qty: 100 }],
    total_ask_qty: 100, total_bid_qty: 100, expected_price: 1, expected_qty: 1 };
  const banner = window.getByTestId('book-expected-fill');
  let sequence = 0;
  for (const width of [800, 360]) {
    await window.evaluate((el, width) => { (el as HTMLElement).style.width = `${width}px`; }, width);
    ws.pushLive('005930', { ...frame, t_ms: frame.t_ms + sequence++ });
    await expect(banner).toHaveText('예상 체결가1원예상 체결량1');
    const fields = [banner, banner.locator('span > .font-data').nth(0), banner.locator('span > .font-data').nth(1)];
    const before = await Promise.all(fields.map(field => field.boundingBox()));
    ws.pushLive('005930', { ...frame, t_ms: frame.t_ms + sequence++, expected_price: 9999999, expected_qty: 999999999 });
    await expect(banner).toHaveText('예상 체결가9,999,999원예상 체결량999,999,999');
    expect(await Promise.all(fields.map(field => field.boundingBox()))).toEqual(before);
    expect(await banner.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  }
  expect(commands).toHaveLength(0);
});

for (const tab of ['orders', 'holdings'] as const) {
  test(`계좌 ${tab} 표는 숫자 자릿수가 바뀌어도 열 위치를 유지한다`, async ({ page }, testInfo) => {
    const { window, commands } = await setup(page, true);
    const button = window.getByRole('button', { name: tab === 'orders' ? '미체결 주문' : '보유종목', exact: true });
    await button.click();
    const panel = page.getByRole('dialog', { name: '계좌 목록' });
    const table = panel.getByRole('table');
    await expect(table.locator('tbody tr')).toHaveCount(1);
    await page.evaluate(() => document.fonts.ready);
    const numericColumns = tab === 'orders' ? [2, 3] : [1, 2, 3, 4];
    const large = tab === 'orders' ? ['9,999,999', '999,999,999'] : ['999,999,999', '9,999,999', '999,999,999,999', '-100.00%'];
    const setDigits = (long: boolean) => table.evaluate((el, { numericColumns, large, long }) => {
      for (const row of el.querySelectorAll('tbody tr')) {
        const cells = row.querySelectorAll('td');
        numericColumns.forEach((column, index) => { cells[column].textContent = long ? large[index] : '1'; });
      }
    }, { numericColumns, large, long });
    const headers = () => table.getByRole('columnheader').evaluateAll(nodes => nodes.map(node => {
      const { x, y, width, height } = node.getBoundingClientRect();
      return { x, y, width, height };
    }));
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await setDigits(false);
      const before = await headers();
      const bounds = await panel.boundingBox();
      await setDigits(true);
      expect(await headers()).toEqual(before);
      expect(await panel.boundingBox()).toEqual(bounds);
      expect(await table.evaluate((el, numericColumns) => [...el.querySelectorAll('tbody tr')].every(row => {
        const cells = row.querySelectorAll('td');
        return numericColumns.every(column => cells[column].scrollWidth <= cells[column].clientWidth + 1);
      }), numericColumns)).toBe(true);
      if (width === 390) expect(await panel.getByRole('tabpanel').evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true);
      await panel.screenshot({ path: testInfo.outputPath(`stable-${tab}-${width}.png`) });
      await setDigits(false);
      expect(await headers()).toEqual(before);
    }
    expect(commands).toHaveLength(0);
  });
}

for (const price of [67_200, 1_469_000, 10_469_000, 99_990_000]) {
  test(`호가주문 ${price}원은 평단가 원과 4px 간격·작은 등락률·가격 정렬을 유지한다`, async ({ page }, testInfo) => {
    const { window, ws, commands } = await setup(page, false, false, true, price - 67_200, 1, { averagePrice: String(price) });
    await ws.waitForSubscribe('005930');
    ws.pushLive('005930', { kind: 'trade', venue: 'UN', t_ms: Date.now(),
      day_open: price, day_high: price + 1000, day_low: price - 900, trades: [] });
    const current = window.locator(`[data-order-price="${price}"] .order-price`);
    await expect(current.locator('[data-price-badges]')).toHaveText('시');
    await expect(current.locator('.order-average-marker')).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    for (const fontSize of [16, 24]) {
      await page.evaluate(size => { document.documentElement.style.fontSize = `${size}px`; }, fontSize);
      for (const width of [800, 576, 504, 360]) {
        await window.evaluate((el, width) => { (el as HTMLElement).style.width = `${width}px`; }, width);
        await expect(async () => {
          const geometry = await window.locator('.order-price').evaluateAll(rows => rows.map(row => {
            const box = row.getBoundingClientRect();
            const value = row.querySelector('.book-price-value')!.getBoundingClientRect();
            const amount = row.querySelector('.book-price-amount')!.getBoundingClientRect();
            const percent = row.querySelector('small')!.getBoundingClientRect();
            const dot = row.querySelector('.order-average-marker')?.getBoundingClientRect();
            const day = row.querySelector('[data-price-badges]')?.getBoundingClientRect();
            return { contained: value.left >= box.left - 0.1 && percent.right <= box.right + 0.1,
              gap: dot ? amount.left - dot.right : null,
              markersSeparated: !dot || !day || day.right + 1 <= dot.left,
              separated: amount.right <= percent.left,
              innerGap: percent.left - amount.right,
              leftGutter: value.left - box.left, rightGutter: box.right - percent.right,
              smaller: parseFloat(getComputedStyle(row.querySelector('small')!).fontSize) < parseFloat(getComputedStyle(row.querySelector('.book-price-value')!).fontSize),
              edge: amount.right };
          }));
          for (const row of geometry) {
            expect(row.contained).toBe(true); expect(row.separated).toBe(true);
            expect(row.innerGap).toBeCloseTo(2, 1);
            expect(row.leftGutter).toBeGreaterThanOrEqual(7.9); expect(row.rightGutter).toBeGreaterThanOrEqual(7.9);
            expect(row.leftGutter).toBeCloseTo(row.rightGutter, 1);
            expect(row.markersSeparated).toBe(true); expect(row.smaller).toBe(true);
            if (row.gap !== null) expect(row.gap).toBeCloseTo(4, 1);
          }
          expect(Math.max(...geometry.map(row => row.edge)) - Math.min(...geometry.map(row => row.edge))).toBeLessThan(0.5);
        }).toPass();
      }
    }
    expect(commands).toHaveLength(0);
    if (price === 10_469_000) {
      await page.evaluate(() => { document.documentElement.style.fontSize = '16px'; });
      await window.evaluate(el => { (el as HTMLElement).style.width = '576px'; });
      await window.screenshot({ path: testInfo.outputPath('ten-million-order-price.png') });
    }
  });
}
