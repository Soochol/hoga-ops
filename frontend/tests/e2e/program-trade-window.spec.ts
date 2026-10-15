import { expect, test, type Page } from '@playwright/test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { installLiveMocks } from './helpers/liveMocks';
import { installLiveWs } from './helpers/liveWs';
import { DATA_DIR } from './worktreeEnv';

const CODE = '098460';

async function setup(page: Page) {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.addInitScript(() => {
    localStorage.setItem('live.venue.v1', JSON.stringify({ venue: 'KRX' }));
    if (!sessionStorage.getItem('live.workspace.v1')) {
      sessionStorage.setItem('live.workspace.v1', JSON.stringify({
        schema_version: 2,
        windows: [{ id: 'trade-only', kind: 'trade', group: 1, rect: { x: 0, y: 0, w: 0.22, h: 0.45 } }],
        zOrder: ['trade-only'], groupSymbols: { 1: { code: '098460', name: '고영' } },
      }));
    }
  });
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
  await ws.waitForSubscribe(CODE);
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
  await expect(table.getByRole('columnheader')).toHaveText(['수신시각', '현재가(원)', '순매수 증감(주)']);
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
  await page.route(/^https?:\/\/[^/]+\/api\/live\/program-trades\?/, async route => {
    const params = new URL(route.request().url()).searchParams;
    const before = params.get('before');
    requests.push(before);
    if (before === '300') await new Promise<void>(resolve => { release = resolve; });
    const top = before === null ? 500 : before === '300' ? 300 : 100;
    const rows = Array.from({ length: Math.min(top, 200) }, (_, i) => makeRow(top - i));
    await route.fulfill({ json: { code: CODE, date: params.get('date'), venue: params.get('venue'), rows,
      next_before: top > 200 ? top - 200 : null } });
  });
  const { ws, window } = await setup(page);
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
  await page.route(/^https?:\/\/[^/]+\/api\/live\/program-trades\?/, route => {
    attempts += 1;
    if (attempts === 1) return route.fulfill({ status: 503, json: { detail: 'temporary failure' } });
    return route.fulfill({ json: { code: CODE, date: new URL(route.request().url()).searchParams.get('date'), venue: 'KRX',
      rows: [{ event_id: 'saved', t_ms: base, price: 125000, event_delta_qty: 900 }], next_before: null } });
  });
  const { window } = await setup(page);
  const retry = window.getByRole('button', { name: '이전 내역 조회 실패 · 재시도' });
  await expect(retry).toBeVisible();
  await window.hover();
  for (let i = 0; i < 3; i++) await page.mouse.wheel(0, 500);
  expect(attempts).toBe(1);
  await retry.click();
  await expect(window.getByText('+900', { exact: true })).toBeVisible();
  expect(attempts).toBe(2);
});

test('스크롤바가 없어도 휠로 실제 저장 API를 조회하고 마지막 페이지에서 멈춘다', async ({ page }, testInfo) => {
  // Disable automatic sentinel loading to verify the wheel handler independently.
  await page.addInitScript(() => Object.defineProperty(globalThis, 'IntersectionObserver', { value: undefined }));
  const now = Date.now();
  const date = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' }).format(now).replaceAll('-', '');
  const dir = join(DATA_DIR, 'program_trade_ticks', date, 'KRX');
  const path = join(dir, `${CODE}.jsonl`);
  await mkdir(dir, { recursive: true });
  const rows = Array.from({ length: 501 }, (_, i) => ({
    event_id: `verify-${String(i + 1).padStart(5, '0')}`, t_ms: now - 501000 + i * 1000,
    price: 125500, event_delta_qty: i + 1,
  }));
  await writeFile(path, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  const requests: (string | null)[] = [];
  const errors: string[] = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname === '/api/live/program-trades') requests.push(url.searchParams.get('before'));
  });
  page.on('pageerror', error => errors.push(error.message));
  try {
    const { window } = await setup(page);
    await page.setViewportSize({ width: 1440, height: 20000 });
    const table = window.getByRole('table');
    const scroller = window.getByLabel('프로그램 체결 목록');
    await expect(table.getByRole('row')).toHaveCount(201);
    await expect.poll(() => scroller.evaluate(el => el.scrollHeight <= el.clientHeight)).toBe(true);
    expect(requests).toEqual([null]);
    await scroller.hover();
    await page.mouse.wheel(0, 500);
    await expect(table.getByRole('row')).toHaveCount(401);
    expect(requests).toHaveLength(2);
    expect(Number(requests[1])).toBeGreaterThan(0);
    await page.mouse.wheel(0, 100000);
    await expect(table.getByRole('row')).toHaveCount(502);
    await expect(table.getByText('+1', { exact: true })).toBeVisible();
    expect(requests).toHaveLength(3);
    expect(Number(requests[2])).toBeLessThan(Number(requests[1]));
    for (let i = 0; i < 3; i++) await page.mouse.wheel(0, 500);
    expect(requests).toHaveLength(3);
    expect(errors).toEqual([]);
    await testInfo.attach('real-api-pagination', { body: JSON.stringify({ requests, rows: 501, errors }), contentType: 'application/json' });
  } finally {
    await rm(path, { force: true });
  }
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
      await expect(frame.getByTestId('window-header-spacer')).toBeHidden();
    }
    await frame.screenshot({ path: testInfo.outputPath(`${kind}-single-line-header.png`) });
  }
});
