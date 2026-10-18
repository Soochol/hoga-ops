import { expect, test, type Page } from '@playwright/test';
import { installLiveMocks } from './helpers/liveMocks';
import { installLiveWs } from './helpers/liveWs';

const CODE = '098460';

async function setup(page: Page, { code = CODE, venue = 'KRX', history = 'empty' }: { code?: string; venue?: string; history?: 'empty' | 'provided' | 'real' } = {}) {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.addInitScript(({ code, venue }) => {
    localStorage.setItem('live.venue.v1', JSON.stringify({ venue }));
    if (!sessionStorage.getItem('live.workspace.v1')) {
      sessionStorage.setItem('live.workspace.v1', JSON.stringify({
        schema_version: 2,
        windows: [{ id: 'trade-only', kind: 'trade', group: 1, rect: { x: 0, y: 0, w: 0.22, h: 0.45 } }],
        zOrder: ['trade-only'], groupSymbols: { 1: { code, name: code === '222800' ? '심텍' : '고영' } },
      }));
    }
  }, { code, venue });
  if (history === 'empty') await page.route('**/api/live/program-trades/history?**', route => route.fulfill({ json: { code, date: '', venue, rows: [], next_key: null, latest_at_ms: null } }));
  await installLiveMocks(page);
  const ws = await installLiveWs(page);
  await page.route(/^https?:\/\/[^/]+\/api\/live\/series\?/, route => {
    const params = new URL(route.request().url()).searchParams;
    return route.fulfill({ json: {
      code: params.get('code'), date: params.get('date'), session_open_ms: Date.now(), session_close_ms: null, is_open: true,
      snapshots: [], trades: [], brokers: [], programs: [], after_hours: [], expected: [], ask_peak_today: null, bid_peak_today: null,
    } });
  });
  await page.goto('/live');
  await page.getByTestId('workspace-add-menu-button').click();
  await page.getByTestId('workspace-add-program-trade').click();
  const window = page.getByTestId('program-trade-window');
  await expect(window).toBeVisible();
  await ws.waitForSubscribe(code);
  return { ws, window };
}

test('프로그램 체결은 차트 없이 세 열로 수신분 증감을 표시하고 거래소·새로고침을 분리한다', async ({ page }, testInfo) => {
  const { ws, window } = await setup(page);
  const time = Date.now();
  ws.pushLive(CODE, { kind: 'program', venue: 'KRX', t_ms: time, price: 125500, net_qty: 500000, event_delta_qty: 1200 });
  ws.pushLive(CODE, { kind: 'program', venue: 'KRX', t_ms: time + 1, price: 125400, net_qty: 900000, event_delta_qty: -300 });
  ws.pushLive(CODE, { kind: 'program', venue: 'KRX', t_ms: time + 2, price: 125300, event_delta_qty: 0 });
  ws.pushLive(CODE, { kind: 'program', venue: 'NXT', t_ms: time + 3, price: 125200, event_delta_qty: 777 });
  const table = window.getByRole('table', { name: '프로그램 체결 내역' });
  await expect(table.getByRole('columnheader')).toHaveText(['시간', '현재가(원)', '순매수 증감(주)']);
  await expect(table.getByRole('row')).toHaveCount(3);
  await expect(table.getByRole('row').nth(1)).toContainText('125,400−300');
  await expect(table.getByText('+1,200')).toHaveClass(/text-price-up/);
  await expect(table.getByText('−300')).toHaveClass(/text-price-down/);
  await expect(window.getByText('최근 체결')).toHaveCount(0);
  await window.screenshot({ path: testInfo.outputPath('program-trade-window.png') });
  await page.getByTestId('live-venue-picker').click();
  await page.getByTestId('live-venue-option-NXT').click();
  await expect(table.getByRole('row')).toHaveCount(2);
  await expect(table.getByText('+777')).toBeVisible();
  await expect(table.getByText('−300')).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId('program-trade-window')).toBeVisible();
});

test('프로그램 체결은 처음 200행을 표시하고 하단 휠로 버퍼의 이전 수신을 펼친다', async ({ page }) => {
  const { ws, window } = await setup(page);
  const time = Date.now();
  ws.pushLive(CODE, { kind: 'program', venue: 'KRX', t_ms: time, price: 125500, net_qty: 999999 });
  await expect(window.getByRole('table')).toHaveCount(0);
  ws.pushBatch(CODE, Array.from({ length: 205 }, (_, i) => ({ kind: 'program', venue: 'KRX', t_ms: time + i + 1,
    price: 125500, event_delta_qty: i + 1 })), []);
  const table = window.getByRole('table');
  await expect(table.getByRole('row')).toHaveCount(201);
  await expect(table.getByRole('row').nth(1)).toContainText('+205');
  await expect(table.getByRole('row').last()).toContainText('+6');
  await expect(table.getByText('+5', { exact: true })).toHaveCount(0);
  await table.getByRole('row').nth(1).hover();
  await page.mouse.wheel(0, 10000);
  await expect(table.getByRole('row')).toHaveCount(206);
  await expect(table.getByText('+1', { exact: true })).toBeVisible();
});

test('프로그램 과거 페이지 조회 중 휠은 중복 요청을 만들지 않고 새 수신에도 읽던 위치를 유지한다', async ({ page }) => {
  const base = Date.now() - 3600000;
  const makeRow = (i: number) => ({ event_id: `event-${String(i).padStart(5, '0')}`, t_ms: base + i * 1000,
    price: 125500, event_delta_qty: i });
  const requests: (string | null)[] = [];
  let release: (() => void) | undefined;
  await page.route(/^https?:\/\/[^/]+\/api\/live\/program-trades\/history\?/, async route => {
    const params = new URL(route.request().url()).searchParams;
    const before = params.get('next_key');
    requests.push(before);
    if (before === '300') await new Promise<void>(resolve => { release = resolve; });
    const top = before === null ? 500 : before === '300' ? 300 : 100;
    const rows = Array.from({ length: Math.min(top, 200) }, (_, i) => makeRow(top - i));
    await route.fulfill({ json: { code: CODE, date: params.get('date'), venue: params.get('venue'), rows,
      next_key: top > 200 ? String(top - 200) : null, latest_at_ms: base + 500000 } });
  });
  const { ws, window } = await setup(page, { history: 'provided' });
  const table = window.getByRole('table');
  await expect(table.getByRole('row')).toHaveCount(201);
  // An overlapping live report is the same event, not another row.
  ws.pushLive(CODE, { kind: 'program', venue: 'KRX', ...makeRow(500) });
  await expect(table.getByRole('row')).toHaveCount(201);
  await table.getByRole('row').nth(1).hover();
  await page.mouse.wheel(0, 10000);
  await expect.poll(() => requests).toEqual([null, '300']);
  for (let i = 0; i < 5; i++) await page.mouse.wheel(0, 500);
  expect(requests).toEqual([null, '300']);
  release!();
  await expect(table.getByRole('row')).toHaveCount(401);
  const scroller = window.getByLabel('프로그램 체결 목록');
  const anchor = table.getByText('+301', { exact: true });
  const beforeTop = (await anchor.boundingBox())!.y;
  ws.pushLive(CODE, { kind: 'program', venue: 'KRX', ...makeRow(501) });
  await expect(table.getByText('+501', { exact: true })).toHaveCount(1);
  await expect.poll(async () => (await anchor.boundingBox())!.y).toBeCloseTo(beforeTop, 0);
  await scroller.hover();
  await page.mouse.wheel(0, 10000);
  await expect(table.getByText('+1', { exact: true })).toHaveCount(1);
  await expect(table.getByRole('row')).toHaveCount(502);
  expect(requests).toEqual([null, '300', '100']);
});

test('이전 프로그램 조회 실패는 반복 휠로 재요청하지 않고 재시도로 복구한다', async ({ page }) => {
  const base = Date.now() - 100000;
  let attempts = 0;
  await page.route(/^https?:\/\/[^/]+\/api\/live\/program-trades\/history\?/, route => {
    attempts += 1;
    if (attempts === 1) return route.fulfill({ status: 503, json: { detail: 'temporary failure' } });
    return route.fulfill({ json: { code: CODE, date: new URL(route.request().url()).searchParams.get('date'), venue: 'KRX',
      rows: [{ event_id: 'saved', t_ms: base, price: 125000, event_delta_qty: 900 }], next_key: null, latest_at_ms: base } });
  });
  const { window } = await setup(page, { history: 'provided' });
  const retry = window.getByRole('button', { name: '이전 내역 조회 실패 · 재시도' });
  await expect(retry).toBeVisible();
  await window.hover();
  for (let i = 0; i < 3; i++) await page.mouse.wheel(0, 500);
  expect(attempts).toBe(1);
  await retry.click();
  await expect(window.getByText('+900', { exact: true })).toBeVisible();
  expect(attempts).toBe(2);
});

test('스크롤바가 없어도 휠로 과거 페이지를 조회하고 마지막 페이지에서 멈춘다', async ({ page }) => {
  // Isolate wheel handling from automatic sentinel loading.
  await page.addInitScript(() => Object.defineProperty(globalThis, 'IntersectionObserver', { value: undefined }));
  const base = Date.now() - 501000;
  const requests: (string | null)[] = [];
  await page.route('**/api/live/program-trades/history?**', route => {
    const params = new URL(route.request().url()).searchParams;
    const key = params.get('next_key');
    requests.push(key);
    const top = key === null ? 501 : Number(key);
    const rows = Array.from({ length: Math.min(200, top) }, (_, i) => ({ event_id: `ka90008:verify-${top - i}`,
      t_ms: base + (top - i) * 1000, price: 125500, event_delta_qty: top - i }));
    return route.fulfill({ json: { code: CODE, date: params.get('date'), venue: 'KRX', rows,
      next_key: top > 200 ? String(top - 200) : null, latest_at_ms: base + 501000 } });
  });
  const { window } = await setup(page, { history: 'provided' });
  await page.setViewportSize({ width: 1440, height: 20000 });
  const table = window.getByRole('table');
  const scroller = window.getByLabel('프로그램 체결 목록');
  await expect(table.getByRole('row')).toHaveCount(201);
  await expect.poll(() => scroller.evaluate(el => el.scrollHeight <= el.clientHeight)).toBe(true);
  expect(requests).toEqual([null]);
  await scroller.hover();
  await page.mouse.wheel(0, 500);
  await expect(table.getByRole('row')).toHaveCount(401);
  await page.mouse.wheel(0, 100000);
  await expect(table.getByRole('row')).toHaveCount(502);
  await expect(table.getByText('+1', { exact: true })).toBeVisible();
  for (let i = 0; i < 3; i++) await page.mouse.wheel(0, 500);
  expect(requests).toEqual([null, '301', '101']);
});

// Opt-in: the separate verification server uses the existing token read-only,
// without keys, token issuance or a second vendor WS connection.
test('통합 심텍의 실제 ka90008 과거 내역을 스크롤로 연속 조회한다', async ({ page }, testInfo) => {
  test.skip(process.env.HOGA_VERIFY_KA90008_LIVE !== '1', 'Explicit live-data verification only');
  const pages: { rows: { t_ms: number; event_id: string }[]; next_key: string | null }[] = [];
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', async response => {
    if (new URL(response.url()).pathname === '/api/live/program-trades/history' && response.ok()) pages.push(await response.json());
  });
  const { window } = await setup(page, { code: '222800', venue: 'UN', history: 'real' });
  const table = window.getByRole('table');
  await expect(table).toBeVisible();
  await expect.poll(() => pages.length).toBeGreaterThanOrEqual(1);
  await expect(table.getByRole('row')).toHaveCount(pages[0].rows.length + 1);
  const firstOldest = Math.min(...pages[0].rows.map(row => row.t_ms));
  for (let i = 0; i < 3 && pages.at(-1)?.next_key; i++) {
    const count = pages.length;
    await window.getByLabel('프로그램 체결 목록').hover();
    await page.mouse.wheel(0, 100000);
    await expect.poll(() => pages.length).toBeGreaterThan(count);
  }
  expect(pages.length).toBeGreaterThanOrEqual(2);
  const ids = new Set(pages.flatMap(page => page.rows.map(row => row.event_id)));
  await expect(table.getByRole('row')).toHaveCount(ids.size + 1);
  const oldest = Math.min(...pages.flatMap(page => page.rows.map(row => row.t_ms)));
  expect(oldest).toBeLessThan(firstOldest);
  expect(firstOldest - oldest).toBeGreaterThan(15 * 60_000);
  expect(errors).toEqual([]);
  await window.screenshot({ path: testInfo.outputPath('simtech-un-live-history.png') });
  await testInfo.attach('live-history-pages', { body: JSON.stringify({ pages: pages.map(p => ({ count: p.rows.length, oldest: Math.min(...p.rows.map(r => r.t_ms)), hasMore: !!p.next_key })), totalUniqueRows: ids.size, errors }), contentType: 'application/json' });
});

test('체결·프로그램 체결 헤더는 좁은 창에서도 창 이름과 종목명을 한 줄로 유지한다', async ({ page }, testInfo) => {
  await setup(page);
  for (const kind of ['trade', 'program-trade']) {
    const frame = page.locator(`.live-window-${kind}`);
    await expect(frame).toBeVisible();
    const id = await frame.getAttribute('data-win');
    await page.getByTestId('live-window-list-button').click();
    await page.getByTestId(`live-window-list-focus-${id}`).click();
    for (const width of [280, 480, 300]) {
      const bounds = (await frame.boundingBox())!;
      const handle = await frame.locator('[data-handle="e"]').boundingBox();
      await page.mouse.move(handle!.x + handle!.width / 2, handle!.y + handle!.height / 2);
      await page.mouse.down();
      await page.mouse.move(handle!.x + handle!.width / 2 + width - bounds.width, handle!.y + handle!.height / 2, { steps: 5 });
      await page.mouse.up();
      await expect.poll(async () => (await frame.boundingBox())!.width).toBeCloseTo(width, 0);
      await expect.poll(() => frame.locator('.live-data-title').evaluate(title => {
        const kind = title.querySelector('.live-data-title-kind')!.getBoundingClientRect();
        const name = title.querySelector('.live-symbol-name')!.getBoundingClientRect();
        return { centerDifference: Math.abs((kind.top + kind.bottom) / 2 - (name.top + name.bottom) / 2), nameVisible: name.width > 0 };
      })).toEqual({ centerDifference: 0, nameVisible: true });
      await expect(frame.locator('.live-data-title .live-symbol-name')).toHaveText('고영');
      await expect(frame.getByRole('button', { name: '창 최대화', exact: true })).toBeVisible();
      await expect(frame.getByRole('button', { name: '항상 위', exact: true })).toBeVisible();
      await expect(frame.getByRole('button', { name: '종목 고정', exact: true })).toBeVisible();
    }
    await frame.screenshot({ path: testInfo.outputPath(`${kind}-single-line-header.png`) });
  }
});
