import { test, expect, type Page, type Locator } from '@playwright/test';
import { installLiveMocks } from './helpers/liveMocks';
import { installLiveWs } from './helpers/liveWs';
import { API_URL } from './worktreeEnv';

const mkOrder = (id: string, price = '67200', filled = '30') => ({
  orderId: id, symbol: '005930', side: 'BUY', orderType: 'LIMIT', timeInForce: 'DAY', status: 'PARTIAL_FILLED', price,
  quantity: '100', orderAmount: null, currency: 'KRW', orderedAt: '2026-10-13T10:00:00+09:00', canceledAt: null,
  execution: { filledQuantity: filled, averageFilledPrice: '67200', filledAmount: '2016000', commission: null, tax: null, filledAt: null, settlementDate: null },
});

async function setup(page: Page, withOrder = false, mode: 'paper' | 'live' = 'live', maximize = true, sameDepth = false) {
  await page.setViewportSize({ width: 1440, height: 1100 });
  await installLiveMocks(page);
  if (mode === 'live') await installLiveWs(page);
  await page.route(/^https?:\/\/[^/]+\/api\/symbols\/all$/, route => route.fulfill({ json: {
    symbols: [{ code: '005930', name: '삼성전자', market: 'KOSPI' }], status: 'fresh', fetched_at_ms: Date.now(), reason: null,
  } }));
  await page.route(/^https?:\/\/[^/]+\/api\/live\/quotes\?/, route => route.fulfill({ json: {
    phase: 'open', quotes: [{ code: '005930', price: 67200, baseline_price: 66000, change_pct: 1.81818, change_won: 1200 }],
  } }));
  await page.route(/^https?:\/\/[^/]+\/api\/live\/series\?/, route => mode === 'paper' ? route.continue() : route.fulfill({ json: {
    code: '005930', date: new URL(route.request().url()).searchParams.get('date'), session_open_ms: Date.now(), session_close_ms: null, is_open: true,
    snapshots: [{ kind: 'ob', venue: new URL(route.request().url()).searchParams.get('venue') ?? 'UN', t_ms: Date.now(), asks: Array.from({ length: 10 }, (_, i) => ({ price: 67300 + i * 100, qty: 100 + i })), bids: Array.from({ length: 10 }, (_, i) => ({ price: 67200 - i * 100, qty: (sameDepth ? 100 : 200) + i })), total_ask_qty: 1000, total_bid_qty: 2000 }],
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
    else orders = [{ ...mkOrder(operationId, String(body.price), path.endsWith('/modify') ? orders[0]?.execution.filledQuantity ?? '0' : '0'),
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
  if (maximize) await page.locator('[data-win]').filter({ has: window }).getByRole('button', { name: '창 최대화', exact: true }).click();
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

test('576px 주문창은 폰트·24px 호가·수량 한 줄을 유지하고 매수 가능을 설정 오른쪽에 표시한다', async ({ page }, testInfo) => {
  const { window, commands } = await setup(page, false, 'live', false);
  const frame = page.locator('[data-win]').filter({ has: window });
  await expect.poll(async () => (await frame.boundingBox())!.width).toBeCloseTo(576, 0);
  await expect.poll(() => window.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  const settings = (await window.getByRole('button', { name: '주문 설정', exact: true }).boundingBox())!;
  const buyingPower = window.getByLabel('매수 가능 금액');
  const cash = (await buyingPower.boundingBox())!;
  expect(cash.x).toBeGreaterThan(settings.x + settings.width);
  expect(cash.y + cash.height / 2).toBeCloseTo(settings.y + settings.height / 2, 0);
  expect(await buyingPower.evaluate(el => getComputedStyle(el).whiteSpace)).toBe('nowrap');
  for (const label of ['매입수량', '매입평단가', '평가수익', '예상금액', '주문수량']) await expect(window.getByText(label, { exact: true })).toHaveCount(0);
  const holdings = (await window.getByRole('group', { name: '보유 종목 정보' }).boundingBox())!;
  const inputs = (await window.getByRole('group', { name: '공통 주문 수량' }).boundingBox())!;
  expect(inputs.y + inputs.height / 2).toBeCloseTo(holdings.y + holdings.height / 2, 0);
  await expect(window.locator('.order-row').first()).toHaveCSS('height', '24px');
  const priceFont = await window.locator('.order-price > span').first().evaluate(el => getComputedStyle(el).fontSize);
  await window.screenshot({ path: testInfo.outputPath('compact-order-window.png') });
  const buy = window.getByRole('button', { name: /매수 67,200원 주문 추가/ });
  await buy.click();
  expect(commands).toHaveLength(0);
  await buy.dblclick();
  const chip = window.getByRole('button', { name: '매수 67,200원 1건 상세 정정' });
  await expect(chip).toHaveText('10주');
  expect(commands).toHaveLength(1);
  await drag(page, chip, window.getByRole('button', { name: /매수 67,100원 주문 추가/ }));
  const moved = window.getByRole('button', { name: '매수 67,100원 1건 상세 정정' });
  await expect(moved).toHaveText('10주');
  expect(commands).toHaveLength(2);
  await drag(page, moved, window.getByRole('combobox', { name: '주문 모드' }));
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
  await expect(window.getByRole('button', { name: '매수 67,200원 1건 상세 정정' })).toBeVisible();
  expect(commands).toHaveLength(1);
  expect(commands[0]).toMatchObject({ code: '005930', account_seq: 1, side: 'BUY', price: 67200, quantity: 10 });
  await expect(window).not.toContainText('⠿');
  await window.screenshot({ path: testInfo.outputPath('order-window.png') });
});

test('공통 수량·환산 금액·상단 보유 종목 매입 정보', async ({ page }, testInfo) => {
  const { window, commands } = await setup(page);
  await expect(window.getByRole('combobox', { name: '수량 방향' })).toHaveCount(0);
  await expect(window.getByLabel('주문 기준 금액')).toHaveCount(0);
  await expect(window.getByRole('button', { name: '매도 25%' })).toHaveCount(0);
  await expect(window.getByLabel('매수 가능 금액')).toHaveText('매수 가능20,000,000원');
  await expect(window.getByLabel('매도 가능 수량')).toHaveCount(0);
  await expect(window.getByLabel('매입수량')).toHaveText('100');
  await expect(window.getByLabel('매입평단가')).toHaveText('66,000');
  const valuation = window.getByLabel('보유 종목 평가 수익');
  await expect(valuation).toHaveText('120,000');
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
  expect(inputBox.y + inputBox.height / 2).toBeCloseTo(valuationBox.y + valuationBox.height / 2, 0);
  const preset = window.getByRole('button', { name: '50주', exact: true });
  await preset.click();
  await expect(preset).toHaveAttribute('aria-pressed', 'true');
  const buy = window.getByRole('button', { name: /매수 67,200원 주문 추가/ });
  await buy.hover();
  await expect(window.getByLabel('예상 주문 금액')).toHaveText('3,360,000원');
  await window.getByRole('button', { name: '종목 상세 정보', exact: true }).click();
  const popup = page.getByRole('dialog', { name: '종목 상세 정보', exact: true });
  const summary = popup.getByTestId('book-summary');
  await expect(summary.getByText('매수 가능', { exact: true })).toHaveCount(0);
  await expect(summary.getByText('매도 가능', { exact: true })).toHaveCount(0);
  for (const label of ['KRX종가', '상승VI', '하강VI', '250일']) await expect(summary.getByText(label, { exact: true })).toBeVisible();
  await popup.getByRole('button', { name: '종목 정보 닫기' }).click();
  await buy.dblclick();
  await expect(window.getByRole('button', { name: '매수 67,200원 1건 상세 정정' })).toHaveText('50주');
  expect(commands[0]).toMatchObject({ side: 'BUY', quantity: 50 });
  await drag(page, window.getByRole('button', { name: '매수 67,200원 1건 상세 정정' }), window.getByRole('combobox', { name: '주문 모드' }));
  const sell = window.getByRole('button', { name: /매도 67,300원 주문 추가/ });
  await expect(sell).toBeEnabled();
  await sell.focus();
  await expect(window.getByLabel('예상 주문 금액')).toHaveText('3,365,000원');
  await expect(valuation).toHaveText('120,000');
  await sell.click();
  expect(commands).toHaveLength(2);
  await expect(window.locator('[data-drag-order]')).toHaveCount(0);
  await sell.dblclick();
  await expect(window.getByRole('button', { name: '매도 67,300원 1건 상세 정정' })).toHaveText('50주');
  expect(commands[2]).toMatchObject({ side: 'SELL', quantity: 50 });
  await window.screenshot({ path: testInfo.outputPath('unified-order-controls.png') });
});

test('주문 설정 적용·취소와 백만원 금액을 클릭 호가의 정수 수량으로 환산', async ({ page }, testInfo) => {
  const { window, commands } = await setup(page);
  const settings = window.getByRole('button', { name: '주문 설정', exact: true });
  const frame = page.locator('[data-win]').filter({ has: window });
  const bounds = await frame.boundingBox();
  await settings.click();
  const dialog = page.getByRole('dialog', { name: '주문 설정', exact: true });
  await dialog.getByRole('spinbutton', { name: '수량 프리셋 1', exact: true }).fill('25');
  await dialog.getByRole('radio', { name: '금액', exact: true }).check();
  await dialog.getByRole('button', { name: '취소', exact: true }).click();
  await expect(window.getByRole('spinbutton', { name: '신규 주문 수량' })).toHaveValue('10');
  await settings.click();
  await expect(dialog.getByRole('spinbutton', { name: '수량 프리셋 1', exact: true })).toHaveValue('10');
  await dialog.getByRole('radio', { name: '금액', exact: true }).check();
  for (const [index, value] of [25, 75, 250].entries()) await dialog.getByRole('spinbutton', { name: `수량 프리셋 ${index + 1}`, exact: true }).fill(String(value));
  for (const [index, value] of [2, 6, 12].entries()) await dialog.getByRole('spinbutton', { name: `금액 프리셋 ${index + 1}`, exact: true }).fill(String(value));
  await dialog.getByRole('spinbutton', { name: '금액 프리셋 1', exact: true }).fill('1.5');
  await expect(dialog.getByRole('button', { name: '적용', exact: true })).toBeDisabled();
  await dialog.getByRole('spinbutton', { name: '금액 프리셋 1', exact: true }).fill('2');
  await page.screenshot({ path: testInfo.outputPath('order-settings-dialog.png') });
  await dialog.getByRole('button', { name: '적용', exact: true }).click();
  await expect(settings).toBeFocused();
  await expect(window.getByRole('spinbutton', { name: '신규 주문 금액' })).toHaveValue('2');
  await window.getByRole('button', { name: '6백만', exact: true }).click();
  await expect(window.getByLabel('예상 주문 수량')).toHaveText('89주');
  const buy = window.getByRole('button', { name: /매수 68,200원 주문 추가/ });
  await buy.hover();
  await expect(window.getByLabel('예상 주문 수량')).toHaveText('87주');
  await buy.dblclick();
  await expect(window.getByRole('button', { name: '매수 68,200원 1건 상세 정정' })).toHaveText('87주');
  expect(commands[0]).toMatchObject({ side: 'BUY', price: 68200, quantity: 87 });
  await settings.click();
  await dialog.getByRole('radio', { name: '수량', exact: true }).check();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(frame.getByRole('button', { name: '원래 크기로 복원', exact: true })).toBeVisible();
  expect(await frame.boundingBox()).toEqual(bounds);
  await expect(window.getByRole('spinbutton', { name: '신규 주문 금액' })).toHaveValue('6');
  await window.screenshot({ path: testInfo.outputPath('order-amount-controls.png') });
});

test('주문 방식·프리셋은 새로고침 후 유지하고 다른 주문창과 독립적이다', async ({ page }) => {
  const { window } = await setup(page);
  await window.getByRole('button', { name: '주문 설정', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '주문 설정', exact: true });
  await dialog.getByRole('radio', { name: '금액', exact: true }).check();
  await dialog.getByRole('spinbutton', { name: '수량 프리셋 1', exact: true }).fill('25');
  await dialog.getByRole('spinbutton', { name: '금액 프리셋 1', exact: true }).fill('2');
  await dialog.getByRole('button', { name: '적용', exact: true }).click();
  await page.reload();
  await expect(window.getByRole('spinbutton', { name: '신규 주문 금액' })).toHaveValue('2');
  await expect(window.getByRole('button', { name: '2백만', exact: true })).toBeVisible();
  await window.getByRole('button', { name: '주문 설정', exact: true }).click();
  await expect(dialog.getByRole('radio', { name: '금액', exact: true })).toBeChecked();
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
  await expect(page.getByTestId('order-window').first().getByRole('button', { name: '2백만', exact: true })).toBeVisible();
});

test('드래그 주문이 커서를 따라 떠다니며 정정 호가·드래그 아웃 취소를 표시한다', async ({ page }, testInfo) => {
  const { window, commands } = await setup(page, true);
  const original = window.getByRole('button', { name: '매수 67,200원 1건 상세 정정' });
  await expect(original).toHaveText('70주');
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
  await expect(preview).toHaveText('70주');
  await expect(preview).toHaveCSS('pointer-events', 'none');
  expect(await preview.evaluate(el => getComputedStyle(el).fontSize)).toBe(await original.evaluate(el => getComputedStyle(el).fontSize));
  await expect(original).toHaveCSS('opacity', '0.35');
  await expect(destination.locator('..')).toHaveClass(/order-drag-destination/);
  expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-order-price]')?.dataset.orderPrice, { x, y })).toBe('67000');
  expect(commands).toHaveLength(0);
  await page.screenshot({ path: testInfo.outputPath('order-drag-modify.png') });
  const before = (await preview.boundingBox())!;
  // A movement within the same target row must still move the preview (no state change).
  await page.mouse.move(x, y + 3);
  expect((await preview.boundingBox())!.y).toBeGreaterThan(before.y);
  await page.mouse.up();
  const moved = window.getByRole('button', { name: '매수 67,000원 1건 상세 정정' });
  await expect(moved).toBeVisible();
  await expect(preview).toHaveCount(0);
  await expect(moved).toHaveCSS('opacity', '1');
  expect(commands[0]).toMatchObject({ price: 67000, quantity: null });
  await expect(window.getByRole('group', { name: '주문 확인' })).toHaveCount(0);
  const movedBox = (await moved.boundingBox())!;
  const outside = (await window.getByRole('combobox', { name: '주문 모드' }).boundingBox())!;
  await page.mouse.move(movedBox.x + movedBox.width / 2, movedBox.y + movedBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(outside.x + outside.width / 2, outside.y + outside.height / 2, { steps: 12 });
  await expect(preview).toHaveText('70주');
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
  await window.getByRole('button', { name: /매수 67,300원 주문 추가/ }).dblclick();
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
  await window.getByRole('button', { name: /매수 67,200원 주문 추가/ }).dblclick();
  await expect(window.getByRole('button', { name: '매수 67,200원 1건 상세 정정' })).toHaveText('5주');
  await window.getByRole('button', { name: /매수 67,100원 주문 추가/ }).dblclick();
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
  await expect(page.getByRole('status', { name: '주문 드래그 미리보기' })).toHaveText('70주');
  await expect(page.getByRole('status', { name: '주문 드래그 미리보기' })).toHaveClass(/order-drag-preview-cancel/);
  await page.keyboard.press('Escape'); await page.mouse.up();
  await expect(page.getByRole('status', { name: '주문 드래그 미리보기' })).toHaveCount(0);
  await expect(window.locator('.order-drag-destination,.order-cancel-active')).toHaveCount(0);
  await expect(chip).toHaveCSS('opacity', '1');
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

test('기본·압축·스크롤에서 보유·수량·프리셋·금액 한 줄과 정보 팝오버를 유지한다', async ({ page }, testInfo) => {
  const { window, commands } = await setup(page, false, 'live', true, true);
  const controls = window.locator('.order-quantity-controls');
  const originalHeight = (await controls.boundingBox())!.height;
  const baseFont = await window.locator('.order-price > span').first().evaluate(el => getComputedStyle(el).fontSize);
  for (const width of [576, 559, 480, 360]) {
    await window.evaluate((el, nextWidth) => { (el as HTMLElement).style.width = `${nextWidth}px`; el.scrollLeft = 0; }, width);
    if (width < 560) await expect(window).toHaveClass(/order-compact/);
    else await expect(window).not.toHaveClass(/order-compact/);
    await expect(window.locator('.order-depth')).toHaveCount(20);
    expect(await window.locator('.order-row').first().evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length)).toBe(5);
    await expect.poll(async () => (await controls.boundingBox())!.height).toBe(originalHeight);
    expect(await window.locator('.order-price > span').first().evaluate(el => getComputedStyle(el).fontSize)).toBe(baseFont);
    const fields = [window.getByLabel('매입수량'), window.getByLabel('매입평단가'), window.getByLabel('보유 종목 평가 수익'), window.getByRole('spinbutton', { name: '신규 주문 수량' }), window.getByRole('button', { name: '50주', exact: true }), window.getByLabel('예상 주문 금액')];
    const boxes = await Promise.all(fields.map(field => field.boundingBox()));
    for (const box of boxes) expect(box!.y + box!.height / 2).toBeCloseTo(boxes[0]!.y + boxes[0]!.height / 2, 0);
    expect(await window.evaluate(el => el.scrollWidth > el.clientWidth)).toBe(width < 480);
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
  await window.evaluate(el => { (el as HTMLElement).style.width = '560px'; });
  await expect(window).not.toHaveClass(/order-compact/);
  await expect(page.getByRole('dialog', { name: '종목 상세 정보', exact: true })).toHaveCount(0);
  await window.evaluate(el => { (el as HTMLElement).style.width = '360px'; el.scrollLeft = el.scrollWidth; });
  await expect(window).toHaveClass(/order-compact/);
  await window.evaluate(el => { el.scrollLeft = el.scrollWidth; });
  await expect(window.getByRole('button', { name: /매수 67,200원 주문 추가/ })).toBeInViewport();
  await window.getByRole('button', { name: /매수 67,200원 주문 추가/ }).dblclick();
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
