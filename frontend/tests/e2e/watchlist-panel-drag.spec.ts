/// <reference types="vite/client" />
import { test, expect, type Page, type Locator } from '@playwright/test';
import { installLiveMocks } from './helpers/liveMocks';
import { apiExact, apiPrefix } from './helpers/apiRoutes';
import type { WatchlistFolderItemsChange, WatchlistItemRef } from '../../src/api/watchlist';

const A = 'f_0000000a', B = 'f_0000000b';
const names: Record<string, string> = { '005930': '삼성전자', '000660': 'SK하이닉스', '035420': 'NAVER', '051910': 'LG화학' };
const code = (code: string): WatchlistItemRef => ({ kind: 'code', code });
const group = (page: Page, id: string) => page.getByTestId(`watchlist-group-${id}`);
const row = (page: Page, id: string, symbol: string) => group(page, id).getByTestId(`watchlist-row-${symbol}`);
const handle = (page: Page, id: string, symbol: string) => row(page, id, symbol).getByRole('button', { name: `${names[symbol] ?? symbol} 이동`, exact: true });

async function setup(page: Page, initial: Record<string, WatchlistItemRef[]> = {
  [A]: [code('005930'), code('000660')], [B]: [code('035420'), code('051910')],
}) {
  await installLiveMocks(page);
  let folders = [A, B];
  let items = structuredClone(initial);
  const requests: WatchlistFolderItemsChange[][] = [];
  let fail = false;
  const json = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  await page.route(apiPrefix('live/quotes'), (r) => r.fulfill(json({ phase: 'open', quotes: [] })));
  await page.route(apiExact('watchlist'), (r) => r.fulfill(json({
    folders: folders.map((id, order) => ({ id, order, name: id === A ? '스윙' : '반도체' })),
    entries: Object.entries(items).flatMap(([folder_id, refs]) => refs.flatMap((i, order) => i.kind === 'code' ? [{
      code: i.code, name: names[i.code] ?? i.code, folder_id, order,
      registered_at_kst_date: '20260908', last_success_date: null,
    }] : [])),
    memos: Object.entries(items).flatMap(([folder_id, refs]) => refs.flatMap((i, order) => i.kind === 'memo' ? [{
      id: i.id, text: '관찰 메모', folder_id, order,
    }] : [])), next_run_at_ms: 0,
  })));
  await page.route(apiExact('watchlist/items/transaction'), async (r) => {
    const changes = r.request().postDataJSON().changes as WatchlistFolderItemsChange[];
    requests.push(changes);
    if (fail || changes.some((c) => JSON.stringify(items[c.folder_id]) !== JSON.stringify(c.before))) {
      return r.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ detail: { message: '목록이 변경되었습니다. 다시 시도하세요.' } }) });
    }
    items = { ...items, ...Object.fromEntries(changes.map((c) => [c.folder_id, c.after])) };
    return r.fulfill({ status: 204, body: '' });
  });
  for (const id of [A, B]) await page.route(apiExact(`watchlist/folders/${id}/items/order`), async (r) => {
    items[id] = r.request().postDataJSON().ordered_items;
    return r.fulfill({ status: 204, body: '' });
  });
  await page.route(apiExact('watchlist/folders/order'), async (r) => {
    folders = r.request().postDataJSON().ordered_ids;
    return r.fulfill({ status: 204, body: '' });
  });
  await page.goto('/live');
  if (!(await page.getByRole('button', { name: '관심종목 편집' }).isVisible())) await page.getByRole('button', { name: /관심종목 패널 토글/ }).click();
  await expect(group(page, A)).toBeVisible();
  return { requests, items: () => items, folders: () => folders, fail: () => { fail = true; },
    change: (id: string, refs: WatchlistItemRef[]) => { items[id] = refs; } };
}
async function point(locator: Locator, fraction = 0.5) {
  const box = await locator.boundingBox();
  if (!box) throw new Error('Drag surface is missing');
  return { x: box.x + box.width / 2, y: box.y + box.height * fraction };
}
async function start(page: Page, locator: Locator) {
  await expect(page.getByTestId('watchlist-drag-ghost')).toHaveCount(0);
  await locator.hover();
  const p = await point(locator);
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  await page.mouse.move(p.x + 7, p.y, { steps: 3 });
  await expect(page.getByTestId('watchlist-drag-ghost')).toBeVisible();
}
async function over(page: Page, locator: Locator, fraction = 0.5) {
  const p = await point(locator, fraction);
  await page.mouse.move(p.x, p.y, { steps: 12 });
}
async function move(page: Page, source: Locator, target: Locator, fraction = 0.5) {
  await start(page, source);
  await over(page, target, fraction);
  await page.mouse.up();
  await expect(page.getByTestId('watchlist-drag-ghost')).toHaveCount(0);
}
const codes = (refs: WatchlistItemRef[]) => refs.map((i) => i.kind === 'code' ? i.code : i.id);

test('같은 그룹 재정렬과 되돌리기', async ({ page }) => {
  const state = await setup(page);
  await move(page, handle(page, A, '005930'), row(page, A, '000660'), 0.8);
  await expect.poll(() => codes(state.items()[A])).toEqual(['000660', '005930']);
  await expect(page.getByRole('button', { name: '실행취소', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '실행취소', exact: true }).click();
  await expect.poll(() => codes(state.items()[A])).toEqual(['005930', '000660']);
});

test('다른 그룹의 행 사이에 정확히 삽입하고 목적지를 안내한다', async ({ page }) => {
  const state = await setup(page);
  await start(page, handle(page, A, '005930'));
  await over(page, row(page, B, '035420'), 0.8);
  await expect(page.getByRole('status').filter({ hasText: '반도체 · NAVER 아래로 이동' })).toBeVisible();
  await page.screenshot({ path: '/tmp/hoga-watchlist-drag-destination.png' });
  await page.mouse.up();
  await expect.poll(() => codes(state.items()[B])).toEqual(['035420', '005930', '051910']);
  expect(codes(state.items()[A])).toEqual(['000660']);
  expect(state.requests).toHaveLength(1);
});

test('그룹 헤더는 맨 아래, 빈 그룹에도 이동 가능', async ({ page }) => {
  const state = await setup(page, { [A]: [code('005930'), code('000660')], [B]: [] });
  await move(page, handle(page, A, '005930'), group(page, B).getByTestId('watchlist-group-header'));
  await expect.poll(() => codes(state.items()[B])).toEqual(['005930']);
  await move(page, handle(page, A, '000660'), group(page, B).getByTestId('watchlist-group-header'));
  await expect.poll(() => codes(state.items()[B])).toEqual(['005930', '000660']);
});

test('메모 앞뒤 위치를 선택하고 메모 내용을 유지한다', async ({ page }) => {
  const state = await setup(page, { [A]: [code('005930')], [B]: [code('035420'), { kind: 'memo', id: 'm_00000001' }, code('051910')] });
  await start(page, handle(page, A, '005930'));
  await over(page, page.getByTestId('watchlist-memo-m_00000001'), 0.2);
  await expect(page.getByRole('status').filter({ hasText: '메모 위로 이동' })).toBeVisible();
  await page.mouse.up();
  await expect.poll(() => codes(state.items()[B])).toEqual(['035420', '005930', 'm_00000001', '051910']);
  await expect(page.getByTestId('watchlist-memo-m_00000001')).toContainText('관찰 메모');
});

test('다중 선택 이동은 중복을 합치고 되돌리기는 원래 양쪽 소속을 복원한다', async ({ page }) => {
  const initial = { [A]: [code('005930'), code('000660')], [B]: [code('035420'), code('005930')] };
  const state = await setup(page, initial);
  await page.getByRole('button', { name: '다중 선택' }).click();
  await row(page, A, '005930').getByRole('checkbox').check();
  await row(page, A, '000660').getByRole('checkbox').check();
  await start(page, handle(page, A, '005930'));
  await expect(page.getByTestId('watchlist-drag-ghost')).toContainText('2종목');
  await over(page, row(page, B, '035420'), 0.8);
  await expect(page.getByRole('status').filter({ hasText: '기존 1종목과 합침' })).toBeVisible();
  await page.mouse.up();
  await expect.poll(() => codes(state.items()[B])).toEqual(['035420', '005930', '000660']);
  expect(state.items()[A]).toEqual([]);
  await page.getByRole('button', { name: '실행취소', exact: true }).click();
  await expect.poll(state.items).toEqual(initial);
  await expect(page.getByTestId('watchlist-drag-ghost')).toHaveCount(0);
  await page.screenshot({ path: '/tmp/hoga-watchlist-drag-selection.png' });
});

test('접힌 그룹에 머무르면 펼쳐지고 취소하면 원래 접힘 상태로 돌아간다', async ({ page }) => {
  const state = await setup(page);
  await page.getByRole('button', { name: '반도체 접기' }).click();
  await start(page, handle(page, A, '005930'));
  await over(page, group(page, B).getByTestId('watchlist-group-header'));
  await expect(row(page, B, '035420')).toBeVisible({ timeout: 2500 });
  await page.keyboard.press('Escape');
  await expect(row(page, B, '035420')).toBeHidden();
  expect(state.requests).toHaveLength(0);
});

test('정렬 중에도 그룹 간 이동하고 같은 그룹 수동 재정렬은 제한한다', async ({ page }) => {
  const state = await setup(page);
  await page.getByRole('button', { name: '스윙 정렬', exact: true }).click();
  await move(page, handle(page, A, '005930'), row(page, A, '000660'), 0.8);
  expect(state.requests).toHaveLength(0);
  await page.getByRole('button', { name: '반도체 정렬', exact: true }).click();
  await start(page, handle(page, A, '005930'));
  await over(page, row(page, B, '035420'), 0.8);
  await expect(page.getByRole('status').filter({ hasText: '정렬 기준에 따라 배치' })).toBeVisible();
  await page.mouse.up();
  await expect.poll(() => codes(state.items()[B])).toContain('005930');
});

test('패널 바깥 드롭은 저장하지 않고 클릭은 차트를 연다', async ({ page }) => {
  const state = await setup(page);
  await start(page, handle(page, A, '005930'));
  await page.mouse.move(20, 20, { steps: 10 });
  await page.mouse.up();
  expect(state.requests).toHaveLength(0);
  await expect(page.getByTestId('watchlist-drag-ghost')).toHaveCount(0);
  await row(page, A, '000660').click();
  await expect(row(page, A, '000660')).toHaveAttribute('aria-current', 'true');
  expect(state.requests).toHaveLength(0);
});

test('저장 실패를 안내하며 원래 소속을 유지한다', async ({ page }) => {
  const state = await setup(page);
  state.fail();
  await move(page, handle(page, A, '005930'), row(page, B, '035420'));
  await expect(page.getByRole('status').filter({ hasText: '이동을 완료하지 못했습니다' })).toBeVisible();
  expect(codes(state.items()[A])).toContain('005930');
  expect(codes(state.items()[B])).not.toContain('005930');
});

test('이동 이후 다른 변경이 있으면 되돌리기가 덮어쓰지 않는다', async ({ page }) => {
  const state = await setup(page);
  await move(page, handle(page, A, '005930'), row(page, B, '035420'), 0.8);
  await expect(page.getByRole('button', { name: '실행취소', exact: true })).toBeVisible();
  const changed = [code('051910'), code('005930'), code('035420')];
  state.change(B, changed);
  await page.getByRole('button', { name: '실행취소', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '되돌리기를 완료하지 못했습니다' })).toBeVisible();
  expect(state.items()[B]).toEqual(changed);
});

test('그룹 핸들로만 순서를 옮기고 드롭 후 목록이 돌아온다', async ({ page }) => {
  const state = await setup(page);
  await start(page, page.getByRole('button', { name: '스윙 그룹 이동', exact: true }));
  await expect(row(page, A, '005930')).toBeHidden();
  await over(page, group(page, B));
  await page.mouse.up();
  await expect.poll(state.folders).toEqual([B, A]);
  await expect(row(page, A, '005930')).toBeVisible();
});

test('가장자리에서 자동 스크롤하며 멀어지면 멈춘다', async ({ page }) => {
  await setup(page, { [A]: [code('005930'), ...Array.from({ length: 50 }, (_, i) => code(String(100000 + i)))], [B]: [] });
  const panel = page.getByTestId('watchlist-scroll');
  await start(page, handle(page, A, '005930'));
  const rect = await panel.boundingBox();
  if (!rect) throw new Error('Panel missing');
  await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height - 20, { steps: 12 });
  await expect(page.getByRole('status').filter({ hasText: '아래로 스크롤' })).toBeVisible();
  await expect.poll(() => panel.evaluate((e) => e.scrollTop)).toBeGreaterThan(60);
  await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
  await expect(page.getByRole('status').filter({ hasText: '아래로 스크롤' })).toBeHidden();
  const stopped = await panel.evaluate((e) => e.scrollTop);
  await page.waitForTimeout(150); // RAF settling guard: no movement away from either edge.
  expect(await panel.evaluate((e) => e.scrollTop)).toBe(stopped);
  await page.mouse.move(rect.x + rect.width / 2, rect.y + 15);
  await expect(page.getByRole('status').filter({ hasText: '위로 스크롤' })).toBeVisible();
  await expect.poll(() => panel.evaluate((e) => e.scrollTop)).toBeLessThan(stopped);
  await page.keyboard.press('Escape');
});

test('메모와 종목이 섞인 그룹에서 양쪽 드래그가 유지된다', async ({ page }) => {
  const state = await setup(page, { [A]: [code('005930'), { kind: 'memo', id: 'm_00000001' }, code('000660')], [B]: [] });
  const memo = page.getByTestId('watchlist-memo-m_00000001');
  await move(page, handle(page, A, '000660'), memo, 0.2);
  await expect.poll(() => codes(state.items()[A])).toEqual(['005930', '000660', 'm_00000001']);
  await move(page, memo, row(page, A, '005930'), 0.2);
  await expect.poll(() => codes(state.items()[A])).toEqual(['m_00000001', '005930', '000660']);
  await expect(memo).toContainText('관찰 메모');
});
