import { expect, test, type Page } from '@playwright/test';
import { installLiveMocks } from './helpers/liveMocks';
import { installLiveWs } from './helpers/liveWs';

const CODE = '222800';
const PATH = '/api/live/trades/history';
const URL_PATTERN = '**/api/live/trades/history?**';
const baseTime = () => Date.now() - 180000;
const makeRow = (i: number, base: number) => ({ event_id: `ka10003:row-${i}`, t_ms: base + i * 1000,
  price: 125500 + i, qty: i, side: i % 2 === 0 ? 1 : -1, cum_volume: i * 10 });

async function setup(page: Page, history: 'empty' | 'provided' | 'real' = 'empty') {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.addInitScript(() => {
    localStorage.setItem('live.venue.v1', JSON.stringify({ venue: 'UN' }));
    sessionStorage.setItem('live.workspace.v1', JSON.stringify({ schema_version: 2,
      windows: [{ id: 'trade-only', kind: 'trade', group: 1, rect: { x: 0, y: 0, w: 0.25, h: 0.45 } }],
      zOrder: ['trade-only'], groupSymbols: { 1: { code: '222800', name: '심텍' } },
    }));
  });
  await installLiveMocks(page);
  const ws = await installLiveWs(page);
  await page.route('**/api/live/series?**', route => {
    const params = new URL(route.request().url()).searchParams;
    return route.fulfill({ json: { code: params.get('code'), date: params.get('date'), session_open_ms: Date.now(),
      session_close_ms: null, is_open: true, snapshots: [], trades: [], brokers: [], programs: [], after_hours: [],
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
