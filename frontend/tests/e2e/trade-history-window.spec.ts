import { expect, test, type Page } from '@playwright/test';
import { installLiveMocks } from './helpers/liveMocks';
import { installLiveWs } from './helpers/liveWs';

const CODE = '222800';
const PATH = '/api/live/trades/history';
const URL_PATTERN = '**/api/live/trades/history?**';
const baseTime = () => Date.now() - 180000;
const makeRow = (i: number, base: number) => ({ event_id: `ka10003:row-${i}`, t_ms: base + i * 1000,
  price: 125500 + i, qty: i, side: i % 2 === 0 ? 1 : -1, cum_volume: i * 10 });

async function setup(page: Page, history: 'empty' | 'provided' | 'real' = 'empty', minAmountManwon = 0, withBooks = false) {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.addInitScript(({ amount, withBooks }) => {
    localStorage.setItem('live.venue.v1', JSON.stringify({ venue: 'UN' }));
    if (!sessionStorage.getItem('live.workspace.v1')) sessionStorage.setItem('live.workspace.v1', JSON.stringify({ schema_version: 2,
      windows: [{ id: 'trade-only', kind: 'trade', group: 1, tradeMinAmountManwon: amount, rect: { x: 0, y: 0, w: 0.25, h: 0.45 } },
        ...(withBooks ? [
          { id: 'book-inline', kind: 'book', group: 1, rect: { x: 0.25, y: 0, w: 0.35, h: 0.9 } },
          { id: 'order-inline', kind: 'order', group: 1, rect: { x: 0.6, y: 0, w: 0.4, h: 0.9 } },
        ] : [])],
      zOrder: withBooks ? ['trade-only', 'book-inline', 'order-inline'] : ['trade-only'], groupSymbols: { 1: { code: '222800', name: '심텍' } },
    }));
  }, { amount: minAmountManwon, withBooks });
  await installLiveMocks(page);
  const ws = await installLiveWs(page);
  await page.route('**/api/live/series?**', route => {
    const params = new URL(route.request().url()).searchParams;
    // Route handlers use Node's clock, which page.clock does not freeze.
    const date = params.get('date')!;
    const bookMs = Date.parse(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}T10:00:00+09:00`);
    return route.fulfill({ json: { code: params.get('code'), date, session_open_ms: bookMs,
      session_close_ms: null, is_open: true, snapshots: withBooks ? [{ kind: 'ob', venue: params.get('venue'), t_ms: bookMs,
        asks: Array.from({ length: 10 }, (_, i) => ({ price: 125600 + i * 100, qty: 100 + i })),
        bids: Array.from({ length: 10 }, (_, i) => ({ price: 125500 - i * 100, qty: 200 + i })),
        total_ask_qty: 1000, total_bid_qty: 2000 }] : [], trades: [], brokers: [], programs: [], after_hours: [],
      expected: [], ask_peak_today: null, bid_peak_today: null } });
  });
  if (history === 'empty') await page.route(URL_PATTERN, route => route.fulfill({ json: {
    code: CODE, date: new URL(route.request().url()).searchParams.get('date'), venue: 'UN', rows: [],
    next_key: null, latest_at_ms: null, latest_volume: null, prev_close: null,
  } }));
  await page.goto('/live');
  const window = page.getByTestId('trade-window');
  await expect(window).toBeVisible();
  await ws.waitForSubscribe(CODE);
  return { window, ws };
}

for (const failed of [false, true]) {
  test(`10호가·호가주문은 체결창의 초기 조회를 공유하고 실시간 체결을 합친다 (${failed ? '조회 실패' : '정상 조회'})`, async ({ page }) => {
    await page.clock.install({ time: new Date('2026-10-21T01:00:00Z') });
    // The tape's explicit scrolling pagination is tested below; here the two
    // books must not request older pages merely to populate nine rows.
    await page.addInitScript(() => Object.defineProperty(globalThis, 'IntersectionObserver', { value: undefined }));
    await page.route('**/api/trading/v2/accounts', route => route.fulfill({ json: { configured: false, accounts: [] } }));
    let batches = 0;
    const base = Date.parse('2026-10-21T00:59:00Z');
    await page.route(URL_PATTERN, route => {
      batches++;
      if (failed) return route.fulfill({ status: 503, json: { detail: 'unavailable' } });
      return route.fulfill({ json: { code: CODE, date: '20261021', venue: 'UN',
        rows: Array.from({ length: 12 }, (_, i) => makeRow(12 - i, base)), next_key: 'older',
        latest_at_ms: base + 12000, latest_volume: 120, prev_close: 125000 } });
    });
    const { ws } = await setup(page, 'provided', 0, true);
    const bookRows = page.locator('[data-win="book-inline"] .book-trade-row');
    const orderRows = page.getByTestId('order-window').locator('.order-trade');
    if (failed) {
      await expect(page.getByRole('button', { name: '이전 내역 조회 실패 · 재시도' })).toBeVisible();
      await expect(bookRows).toHaveCount(0);
      await expect(orderRows).toHaveCount(0);
    } else {
      for (const rows of [bookRows, orderRows]) {
        await expect(rows).toHaveCount(12);
        await expect(rows.first().locator('span').last()).toHaveText('12');
        await expect(rows.last().locator('span').last()).toHaveText('1');
      }
      expect(batches).toBe(1);
    }
    ws.pushBatch(CODE, [
      { kind: 'trade', venue: 'UN', t_ms: base + 12000, cum_volume: 120,
        trades: [{ price: 125512, qty: 12, side: 1 }] },
      { kind: 'trade', venue: 'UN', t_ms: base + 12000, cum_volume: 133,
        trades: [{ price: 125600, qty: 13, side: -1 }] },
    ], []);
    for (const rows of [bookRows, orderRows]) {
      await expect(rows.first().locator('span').last()).toHaveText('13');
      await expect(rows.nth(1).locator('span').last()).toHaveText('12');
    }
    if (!failed) {
      await expect(bookRows).toHaveCount(13);
      await expect(orderRows.last().locator('span').last()).toHaveText('1');
      expect(batches).toBe(1);
    }
  });
}

for (const kind of ['book', 'order'] as const) {
  test(`${kind}: 체결 가격·수량·빈 공간 더블클릭은 체결창 하나만 열고 기존 창을 앞으로 가져온다`, async ({ page }) => {
    await page.clock.install({ time: new Date('2026-10-21T01:00:00Z') });
    await page.route('**/api/trading/v2/accounts', route => route.fulfill({ json: { configured: false, accounts: [] } }));
    let commands = 0;
    await page.route('**/api/trading/**/commands', route => { commands++; return route.abort(); });
    await page.route(URL_PATTERN, route => route.fulfill({ json: {
      code: CODE, date: '20261021', venue: 'UN', rows: [makeRow(12, Date.parse('2026-10-21T00:59:00Z'))],
      next_key: null, latest_at_ms: null, latest_volume: null, prev_close: 125000,
    } }));
    await setup(page, 'provided', 0, true);
    const source = page.locator(`[data-win="${kind}-inline"]`);
    const original = page.locator('[data-win="trade-only"]');
    await original.getByRole('button', { name: /창 닫기$/ }).click();
    const tapes = page.getByTestId('trade-window');
    await expect(tapes).toHaveCount(0);
    const triggers = source.getByRole('button', { name: '체결창 열기', exact: true });
    const first = triggers.locator(kind === 'book' ? '.book-trade-row' : '.order-trade').first();
    await expect(first.locator('span').last()).toHaveText('12');
    await first.locator('span').first().click();
    await source.locator(kind === 'book' ? '.book-strength-row' : '.order-strength').dblclick();
    await expect(tapes).toHaveCount(0);
    await first.locator('span').first().dblclick();
    await expect(tapes).toHaveCount(1);
    await expect(tapes).toHaveAttribute('data-mode', 'latest');
    const tapeFrame = page.locator('.live-window-trade');
    const id = await tapeFrame.getAttribute('data-win');
    await expect(tapeFrame.locator('[data-handle="move"]')).toHaveAttribute('data-focused', '');
    await expect(tapeFrame).toContainText('심텍');
    await source.locator('[data-handle="move"]').click({ position: { x: 180, y: 12 } });
    await first.locator('span').last().dblclick();
    await expect(tapes).toHaveCount(1);
    await expect(tapeFrame).toHaveAttribute('data-win', id!);
    await expect(tapeFrame.locator('[data-handle="move"]')).toHaveAttribute('data-focused', '');
    await source.locator('[data-handle="move"]').click({ position: { x: 180, y: 12 } });
    await triggers.dblclick({ position: { x: 6, y: kind === 'book' ? 180 : 200 } });
    await expect(tapes).toHaveCount(1);
    await expect(tapeFrame.locator('[data-handle="move"]')).toHaveAttribute('data-focused', '');
    expect(await triggers.first().getAttribute('title')).toBeNull();
    expect(await triggers.first().getAttribute('data-tooltip')).toBeNull();
    expect(commands).toBe(0);
  });
}

for (const kind of ['book', 'order'] as const) {
  test(`${kind}: 체결 세로 스크롤은 사다리를 고정하고 읽던 목록을 유지한 뒤 맨 위에서 최신으로 복귀한다`, async ({ page }) => {
    await page.clock.install({ time: new Date('2026-10-21T01:00:00Z') });
    await page.route('**/api/trading/v2/accounts', route => route.fulfill({ json: { configured: false, accounts: [] } }));
    let requests = 0;
    const base = Date.parse('2026-10-21T00:59:00Z');
    await page.route(URL_PATTERN, route => {
      requests++;
      return route.fulfill({ json: { code: CODE, date: '20261021', venue: 'UN',
        rows: Array.from({ length: 40 }, (_, i) => makeRow(40 - i, base)),
        next_key: 'older', latest_at_ms: base + 40000, latest_volume: 400, prev_close: 125000 } });
    });
    // A separate tape must not automatically fetch older pages during this book test.
    await page.addInitScript(() => Object.defineProperty(globalThis, 'IntersectionObserver', { value: undefined }));
    const { ws } = await setup(page, 'provided', 0, true);
    const source = page.locator(`[data-win="${kind}-inline"]`);
    const scroll = source.getByTestId('book-trade-list');
    const selector = kind === 'book' ? '.book-trade-row' : '.order-trade';
    await expect(scroll.locator(selector)).toHaveCount(40);
    await source.locator('[data-handle="move"]').click({ position: { x: 180, y: 12 } });
    const price = source.locator('.book-price-value').first();
    const before = await price.boundingBox();
    expect(before).not.toBeNull();
    expect(await scroll.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
    await scroll.hover();
    await page.mouse.wheel(0, 240);
    await expect(scroll).toHaveAttribute('data-reading', 'true');
    const position = await scroll.evaluate(el => el.scrollTop);
    expect(position).toBeGreaterThan(0);
    const previousText = await scroll.textContent();
    ws.pushBatch(CODE, [{ kind: 'trade', venue: 'UN', t_ms: base + 41000, cum_volume: 1399,
      trades: [{ price: 125700, qty: 999, side: 1 }] }], []);
    const other = page.locator(`[data-win="${kind === 'book' ? 'order' : 'book'}-inline"]`).getByTestId('book-trade-list');
    await expect(other).toContainText('999'); // prove the new execution reached the app
    await expect(scroll).toHaveText(previousText!);
    expect(await scroll.evaluate(el => el.scrollTop)).toBe(position);
    expect((await price.boundingBox())?.y).toBe(before!.y);
    // The end of the inner list must not scroll the surrounding price ladder.
    await scroll.evaluate(el => { el.scrollTop = el.scrollHeight; });
    await page.mouse.wheel(0, 300);
    expect((await price.boundingBox())?.y).toBe(before!.y);
    await scroll.evaluate(el => { el.scrollTop = 0; });
    await expect(scroll).toHaveAttribute('data-reading', 'false');
    await expect(scroll.locator(selector).first()).toContainText('999');
    expect(requests).toBe(1);
    await scroll.dblclick();
    await expect(page.getByTestId('trade-window')).toHaveCount(1);
  });
}

async function openTradeSettings(page: Page) {
  await page.getByRole('button', { name: '체결창 설정', exact: true }).click();
  return page.getByRole('dialog', { name: '체결창 설정', exact: true });
}

test('헤더 메뉴 설정은 넓은 창에서도 접근하며 금액 경계·실시간·새로고침에 동일하게 적용한다', async ({ page }, testInfo) => {
  const base = baseTime();
  await page.route(URL_PATTERN, route => route.fulfill({ json: {
    code: CODE, date: new URL(route.request().url()).searchParams.get('date'), venue: 'UN',
    rows: [126, 125, 124].map(i => ({ ...makeRow(i, base - 126000), price: 80000 })), next_key: null,
    latest_at_ms: base, latest_volume: 1260, prev_close: 79000,
  } }));
  const { window, ws } = await setup(page, 'provided');
  const table = window.getByRole('table');
  await expect(table.getByRole('row')).toHaveCount(4);
  await page.getByRole('button', { name: '창 최대화', exact: true }).click();
  const settings = await openTradeSettings(page);
  await expect(settings).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('trade-settings-popover.png') });
  await settings.getByRole('textbox', { name: '최소 금액 직접 입력' }).fill('2500');
  await page.keyboard.press('Escape');
  await expect(settings).toBeHidden();
  await expect(page.getByRole('button', { name: '원래 크기로 복원', exact: true })).toBeVisible();
  const reopened = await openTradeSettings(page);
  await expect(reopened.getByRole('textbox', { name: '최소 금액 직접 입력' })).toHaveValue('1,000');
  await reopened.getByRole('button', { name: '1천만', exact: true }).click();
  await expect(settings).toBeHidden();
  await expect(page.getByLabel('체결금액 1,000만원 이상 표시')).toBeVisible();
  await expect(table.getByRole('row')).toHaveCount(3);
  await expect(table.getByRole('cell', { name: '125', exact: true })).toBeVisible();
  await expect(table.getByRole('cell', { name: '124', exact: true })).toHaveCount(0);
  ws.pushBatch(CODE, [
    { kind: 'trade', venue: 'UN', t_ms: base + 1000, cum_volume: 1261, trades: [{ t_ms: base + 1000, price: 80000, qty: 1, side: -1 }] },
    { kind: 'trade', venue: 'UN', t_ms: base + 2000, cum_volume: 3761, trades: [{ t_ms: base + 2000, price: 80000, qty: 2500, side: 1 }] },
  ], []);
  await expect(table.getByRole('cell', { name: '2,500', exact: true })).toBeVisible();
  await expect(table.getByRole('cell', { name: '1', exact: true })).toHaveCount(0);
  await expect(table.getByRole('cell', { name: '2,500', exact: true })).toHaveAttribute('data-testid', 'trade-qty-highlighted');
  await page.reload();
  await expect(page.getByLabel('체결금액 1,000만원 이상 표시')).toBeVisible();
  await expect(window.getByRole('table').getByRole('row')).toHaveCount(3);
  await openTradeSettings(page);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: '체결창 설정' })).toBeHidden();
  await expect(page.getByRole('button', { name: '체결창 설정', exact: true })).toBeFocused();
  await window.locator('xpath=ancestor::*[@data-win][1]').getByRole('button', { name: /창 닫기$/ }).click();
  await expect(page.getByTestId('trade-window')).toHaveCount(0);
  await page.reload();
  await page.getByTestId('workspace-add-menu-button').click();
  await page.getByTestId('workspace-add-trade').click();
  await expect(page.getByLabel('체결금액 1,000만원 이상 표시')).toBeVisible();
  const remembered = await openTradeSettings(page);
  await expect(remembered.getByRole('textbox', { name: '최소 금액 직접 입력' })).toHaveValue('1,000');
});

test('일치 없는 과거 페이지도 휠로 이어 조회하며 빈 결과에서 전체 표시로 복귀한다', async ({ page }) => {
  const base = baseTime();
  const requests: (string | null)[] = [];
  await page.route(URL_PATTERN, route => {
    const params = new URL(route.request().url()).searchParams;
    const key = params.get('next_key');
    requests.push(key);
    const qty = key === 'oldest' ? 2000 : 1;
    return route.fulfill({ json: { code: CODE, date: params.get('date'), venue: 'UN',
      rows: [{ ...makeRow(key === 'oldest' ? 1 : key ? 2 : 3, base), price: 80000, qty }],
      next_key: key === 'oldest' ? null : key ? 'oldest' : 'older', latest_at_ms: base + 3000, latest_volume: 30, prev_close: 79000,
    } });
  });
  const { window } = await setup(page, 'provided', 10000);
  await expect(window.getByText('1억원 이상 체결 없음 · 새 체결 수신 대기')).toBeVisible();
  expect(requests).toEqual([null]);
  const settings = await openTradeSettings(page);
  await settings.getByRole('button', { name: '1억', exact: true }).click();
  const scroller = window.getByLabel('체결 목록', { exact: true });
  await scroller.hover();
  await page.mouse.wheel(0, 500);
  await expect.poll(() => requests).toEqual([null, 'older']);
  await expect(window.getByText('이전 내역 조회 중…')).toBeHidden();
  await page.mouse.wheel(0, 500);
  await expect(window.getByRole('cell', { name: '2,000', exact: true })).toBeVisible();
  await expect(window.getByRole('cell', { name: '1', exact: true })).toHaveCount(0);
  const highSettings = await openTradeSettings(page);
  await highSettings.getByRole('textbox', { name: '최소 금액 직접 입력' }).fill('100,000');
  await highSettings.getByRole('textbox', { name: '최소 금액 직접 입력' }).press('Enter');
  await expect(window.getByText('10억원 이상 체결 없음 · 새 체결 수신 대기')).toBeVisible();
  await window.getByRole('button', { name: '전체 체결 보기' }).click();
  await expect(page.getByLabel('체결금액 10억원 이상 표시')).toHaveCount(0);
  await expect(window.getByRole('table').getByRole('row')).toHaveCount(4);
});

test('스크롤바 없는 체결창도 휠로 조회하고 조회 중 반복 휠과 REST/WS 경계 중복을 막는다', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(globalThis, 'IntersectionObserver', { value: undefined }));
  const base = baseTime();
  const requests: (string | null)[] = [];
  let release: (() => void) | undefined;
  await page.route(URL_PATTERN, async route => {
    const params = new URL(route.request().url()).searchParams;
    const key = params.get('next_key');
    requests.push(key);
    if (key) await new Promise<void>(resolve => { release = resolve; });
    return route.fulfill({ json: { code: CODE, date: params.get('date'), venue: 'UN',
      rows: (key ? [2, 1] : [4, 3]).map(i => makeRow(i, base)), next_key: key ? null : 'older+/=',
      latest_at_ms: base + 4000, latest_volume: 40, prev_close: 125000 } });
  });
  const { window, ws } = await setup(page, 'provided');
  const table = window.getByRole('table', { name: '체결 내역' });
  const scroller = window.getByLabel('체결 목록', { exact: true });
  await expect(table.getByRole('row')).toHaveCount(3);
  await expect.poll(() => scroller.evaluate(el => el.scrollHeight <= el.clientHeight)).toBe(true);
  await expect(table.getByText('4', { exact: true })).toHaveClass(/text-price-up/);
  await expect(table.getByText('3', { exact: true })).toHaveClass(/text-price-down/);
  ws.pushLive(CODE, { kind: 'trade', venue: 'UN', t_ms: base + 4000, cum_volume: 40,
    trades: [{ t_ms: base + 4000, price: 125504, qty: 4, side: 1 }] });
  await expect(table.getByRole('row')).toHaveCount(3);
  await scroller.hover();
  await page.mouse.wheel(0, 500);
  await expect.poll(() => requests).toEqual([null, 'older+/=']);
  for (let i = 0; i < 5; i++) await page.mouse.wheel(0, 500);
  expect(requests).toHaveLength(2);
  ws.pushLive(CODE, { kind: 'trade', venue: 'UN', t_ms: base + 4000, cum_volume: 45,
    trades: [{ t_ms: base + 4000, price: 125600, qty: 9, side: -1 }] });
  await expect(table.getByText('9', { exact: true })).toBeVisible();
  release!();
  await expect(table.getByRole('row')).toHaveCount(6);
  for (let i = 0; i < 3; i++) await page.mouse.wheel(0, 500);
  expect(requests).toHaveLength(2);
});

test('이전 체결 페이지를 읽던 위치는 새 실시간 체결이 들어와도 유지한다', async ({ page }) => {
  const base = baseTime();
  await page.route(URL_PATTERN, route => {
    const params = new URL(route.request().url()).searchParams;
    const top = params.has('next_key') ? 30 : 60;
    return route.fulfill({ json: { code: CODE, date: params.get('date'), venue: 'UN',
      rows: Array.from({ length: 30 }, (_, i) => makeRow(top - i, base)), next_key: top === 60 ? 'older' : null,
      latest_at_ms: base + 60000, latest_volume: 600, prev_close: 125000 } });
  });
  const { window, ws } = await setup(page, 'provided');
  const table = window.getByRole('table');
  await expect(table.getByRole('row')).toHaveCount(31);
  await window.getByLabel('체결 목록', { exact: true }).hover();
  await page.mouse.wheel(0, 100000);
  await expect(table.getByRole('row')).toHaveCount(61);
  const anchor = table.locator('[data-tape-event="ka10003:row-31"]');
  const before = (await anchor.boundingBox())!.y;
  ws.pushLive(CODE, { kind: 'trade', venue: 'UN', t_ms: base + 61000, cum_volume: 610,
    trades: [{ t_ms: base + 61000, price: 125600, qty: 777, side: 1 }] });
  await expect(table.getByText('777', { exact: true })).toHaveCount(1);
  await expect.poll(async () => (await anchor.boundingBox())!.y).toBeCloseTo(before, 0);
});

test('체결 과거 조회 실패는 명시적 재시도로 복구하고 거래소 전환 시 이전 행을 비운다', async ({ page }) => {
  const base = baseTime();
  let attempts = 0;
  await page.route(URL_PATTERN, route => {
    const params = new URL(route.request().url()).searchParams;
    attempts++;
    if (attempts === 1) return route.fulfill({ status: 503, json: { detail: 'temporary failure' } });
    const i = params.get('venue') === 'KRX' ? 8 : 7;
    return route.fulfill({ json: { code: CODE, date: params.get('date'), venue: params.get('venue'),
      rows: [makeRow(i, base)], next_key: null, latest_at_ms: base + i * 1000, latest_volume: i * 10, prev_close: 125000 } });
  });
  const { window } = await setup(page, 'provided');
  const retry = window.getByRole('button', { name: '이전 내역 조회 실패 · 재시도' });
  await expect(retry).toBeVisible();
  await window.getByLabel('체결 목록', { exact: true }).hover();
  for (let i = 0; i < 3; i++) await page.mouse.wheel(0, 500);
  expect(attempts).toBe(1);
  await retry.click();
  await expect(window.getByRole('cell').filter({ hasText: /^7$/ })).toBeVisible();
  await page.getByTestId('live-venue-picker').click();
  await page.getByTestId('live-venue-option-KRX').click();
  await expect(window.getByRole('cell').filter({ hasText: /^8$/ })).toBeVisible();
  await expect(window.getByRole('cell').filter({ hasText: /^7$/ })).toHaveCount(0);
});

test('체결창의 최근 200행을 넘는 버퍼도 하단 휠로 펼친다', async ({ page }) => {
  const { window, ws } = await setup(page);
  const base = baseTime() - 300000;
  ws.pushBatch(CODE, Array.from({ length: 205 }, (_, i) => ({ kind: 'trade', venue: 'UN',
    t_ms: base + i * 1000, cum_volume: (i + 1) * 10,
    trades: [{ t_ms: base + i * 1000, price: 125000, qty: i + 1, side: 1 }] })), []);
  const table = window.getByRole('table');
  await expect(table.getByRole('row')).toHaveCount(201);
  await window.getByLabel('체결 목록', { exact: true }).hover();
  await page.mouse.wheel(0, 100000);
  await expect(table.getByRole('row')).toHaveCount(206);
  await expect(table.getByText('1', { exact: true })).toBeVisible();
});

test('통합 심텍 실제 ka10003 API를 스크롤로 연속 조회한다', async ({ page }, testInfo) => {
  test.skip(process.env.HOGA_VERIFY_KA10003_LIVE !== '1', 'Explicit live-data verification only');
  const pages: { rows: { event_id: string; t_ms: number; cum_volume: number | null }[]; next_key: string | null }[] = [];
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', async response => {
    if (new URL(response.url()).pathname === PATH && response.ok()) pages.push(await response.json());
  });
  const { window } = await setup(page, 'real');
  const table = window.getByRole('table', { name: '체결 내역' });
  await expect(table).toBeVisible();
  await expect.poll(() => pages.length).toBeGreaterThanOrEqual(1);
  await expect(table.getByRole('row')).toHaveCount(pages[0].rows.length + 1);
  const oldestFirst = pages[0].rows.at(-1)!;
  for (let i = 0; i < 3 && pages.at(-1)?.next_key; i++) {
    const count = pages.length;
    await window.getByLabel('체결 목록', { exact: true }).hover();
    await page.mouse.wheel(0, 100000);
    await expect.poll(() => pages.length).toBeGreaterThan(count);
  }
  expect(pages.length).toBeGreaterThanOrEqual(2);
  const unique = new Map(pages.flatMap(p => p.rows).map(row => [row.event_id, row]));
  await expect(table.getByRole('row')).toHaveCount(unique.size + 1);
  const oldest = pages.at(-1)!.rows.at(-1)!;
  expect(oldest.t_ms < oldestFirst.t_ms || (oldest.cum_volume ?? Infinity) < (oldestFirst.cum_volume ?? -Infinity)).toBe(true);
  expect(errors).toEqual([]);
  await window.screenshot({ path: testInfo.outputPath('simtech-un-trade-history.png') });
  await testInfo.attach('real-trade-pages', { body: JSON.stringify({ rows: unique.size, pages: pages.map(p => ({
    count: p.rows.length, newest: p.rows[0]?.t_ms, oldest: p.rows.at(-1)?.t_ms, hasMore: !!p.next_key,
  })), errors }), contentType: 'application/json' });
});
