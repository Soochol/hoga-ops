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
const handle = (page: Page, id: string, symbol: string) => row(page, id, symbol);

async function setup(page: Page, initial: Record<string, WatchlistItemRef[]> = {
  [A]: [code('005930'), code('000660')], [B]: [code('035420'), code('051910')],
}) {
  await installLiveMocks(page);
  let folders = Object.keys(initial);
  const folderRequests: string[][] = [];
  let items = structuredClone(initial);
  const requests: WatchlistFolderItemsChange[][] = [];
  let fail = false;
  const json = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  await page.route(apiPrefix('live/quotes'), (r) => r.fulfill(json({ phase: 'open', quotes: [] })));
  await page.route(apiExact('watchlist'), (r) => r.fulfill(json({
    folders: folders.map((id, order) => ({ id, order, name: id === A ? '스윙' : id === B ? '반도체' : '배당' })),
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
    folderRequests.push([...folders]);
    return r.fulfill({ status: 204, body: '' });
  });
  await page.goto('/live');
  if (!(await page.getByRole('button', { name: '관심종목 편집' }).isVisible())) await page.getByRole('button', { name: /관심종목 패널 토글/ }).click();
  await expect(group(page, A)).toBeVisible();
  return { requests, folderRequests, items: () => items, folders: () => folders, fail: () => { fail = true; },
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
  await expect(page.getByRole('button', { name: '실행 취소', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '실행 취소', exact: true }).click();
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
  await row(page, A, '005930').click();
  await row(page, A, '000660').click({ modifiers: ['Shift'] });
  await expect(row(page, A, '005930')).toHaveAttribute('aria-pressed', 'true');
  await expect(row(page, A, '000660')).toHaveAttribute('aria-pressed', 'true');
  await start(page, handle(page, A, '005930'));
  await expect(page.getByTestId('watchlist-drag-ghost')).toContainText('2종목');
  await over(page, row(page, B, '035420'), 0.8);
  await expect(page.getByRole('status').filter({ hasText: '기존 1종목과 합침' })).toBeVisible();
  await page.mouse.up();
  await expect.poll(() => codes(state.items()[B])).toEqual(['035420', '005930', '000660']);
  expect(state.items()[A]).toEqual([]);
  await page.getByRole('button', { name: '실행 취소', exact: true }).click();
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
  await expect(page.getByRole('button', { name: '실행 취소', exact: true })).toBeVisible();
  const changed = [code('051910'), code('005930'), code('035420')];
  state.change(B, changed);
  await page.getByRole('button', { name: '실행 취소', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '되돌리기를 완료하지 못했습니다' })).toBeVisible();
  expect(state.items()[B]).toEqual(changed);
});

test('그룹 헤더로 순서를 옮기고 드롭 후 목록이 돌아온다', async ({ page }) => {
  const state = await setup(page);
  await start(page, group(page, A).getByTestId('watchlist-group-header'));
  await expect(row(page, A, '005930')).toBeHidden();
  await over(page, group(page, B).getByTestId('watchlist-group-header'), 0.8);
  await page.mouse.up();
  await expect.poll(state.folders).toEqual([B, A]);
  await expect(row(page, A, '005930')).toBeVisible();
});

for (const scenario of [
  { name: '첫 그룹', source: A, count: 8 },
  { name: '아래쪽 그룹', source: B, count: 8, drop: true },
  { name: '스크롤 후 아래쪽 그룹', source: B, count: 30, drop: true },
  { name: '스크롤에 고정된 헤더', source: A, count: 30, sticky: true },
  { name: '이미 접힌 그룹', source: B, count: 8, collapsed: true },
]) {
  test(`그룹 헤더가 접히는 동안 잡은 좌표를 유지한다: ${scenario.name}`, async ({ page }) => {
    await page.routeWebSocket(/\/api\/ws/, (ws) => ws.onMessage(() => {}));
    const state = await setup(page, {
      [A]: Array.from({ length: scenario.count }, (_, i) => code(String(100000 + i))),
      [B]: [code('035420'), code('051910')],
    });
    const panel = page.getByTestId('watchlist-scroll');
    if (scenario.collapsed) {
      await group(page, A).getByRole('button', { name: '스윙 접기', exact: true }).click();
      await group(page, B).getByRole('button', { name: '반도체 접기', exact: true }).click();
    }
    if (scenario.sticky) await panel.evaluate((el) => { el.scrollTop = 150; });
    const header = group(page, scenario.source).getByTestId('watchlist-group-header');
    await header.scrollIntoViewIfNeeded();
    const rect = await header.boundingBox();
    if (!rect) throw new Error('Group header missing');
    if (scenario.count === 30) expect(await panel.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    const rows = page.locator('[data-testid^="watchlist-row-"]');
    const rowCount = await rows.count();
    const savedScroll = await panel.evaluate((el) => el.scrollTop);
    const savedCollapse = await page.evaluate(() => localStorage.getItem('watchlist.collapsed'));
    // Grab away from the centre to verify the original grab point, not a snap-to-centre.
    const grab = { x: rect.width * 0.37, y: rect.height * 0.75 };
    const origin = { x: rect.x + grab.x, y: rect.y + grab.y };
    await page.mouse.move(origin.x, origin.y);
    await page.mouse.down();
    const ghost = page.getByTestId('watchlist-drag-ghost');
    for (const delta of [{ x: 7, y: 0 }, { x: 39, y: 34 }, { x: -21, y: -29 }]) {
      const cursor = { x: origin.x + delta.x, y: origin.y + delta.y };
      await page.mouse.move(cursor.x, cursor.y, { steps: 4 });
      await expect(ghost).toBeVisible();
      await expect(rows).toHaveCount(0);
      if (delta.x === 7 && delta.y === 0) {
        await expect.poll(async () => Math.abs((await header.boundingBox())!.y - rect.y)).toBeLessThan(1);
        await expect(page.locator('[data-panel-group-drop]')).toHaveCount(0);
      }
      await expect.poll(async () => {
        const box = await ghost.boundingBox();
        if (!box) return Infinity;
        return Math.max(Math.abs(box.x + grab.x - cursor.x), Math.abs(box.y + grab.y - cursor.y),
          Math.abs(box.width - rect.width), Math.abs(box.height - rect.height));
      }).toBeLessThan(1);
    }
    if (scenario.drop) {
      await over(page, group(page, A).getByTestId('watchlist-group-header'));
      await page.mouse.up();
      await expect.poll(state.folders).toEqual([B, A]);
    } else {
      await page.keyboard.press('Escape');
      expect(state.folders()).toEqual([A, B]);
    }
    await expect(ghost).toHaveCount(0);
    await expect(rows).toHaveCount(rowCount);
    if (!scenario.drop) expect(await panel.evaluate((el) => el.scrollTop)).toBe(savedScroll);
    expect(await page.evaluate(() => localStorage.getItem('watchlist.collapsed'))).toBe(savedCollapse);
  });
}

for (const release of ['바로 놓기', '위쪽 빈 공간', '아래쪽 빈 공간', 'Esc']) {
  test(`그룹 드래그 취소는 저장하지 않는다: ${release}`, async ({ page }) => {
    const C = 'f_0000000c';
    const state = await setup(page, {
      [A]: Array.from({ length: 8 }, (_, i) => code(String(100000 + i))),
      [B]: [code('035420')], [C]: [code('051910')],
    });
    await start(page, group(page, B).getByTestId('watchlist-group-header'));
    await expect(page.locator('[data-panel-group-drop]')).toHaveCount(0);
    if (release === '바로 놓기') await page.screenshot({ path: '/tmp/hoga-watchlist-anchored-groups.png' });
    if (release !== '바로 놓기') {
      await over(page, group(page, A).getByTestId('watchlist-group-header'), 0.2);
      await expect(group(page, A).locator('[data-panel-group-drop="before"]')).toBeVisible();
      if (release !== 'Esc') {
        const panel = (await page.getByTestId('watchlist-scroll').boundingBox())!;
        const top = (await group(page, A).getByTestId('watchlist-group-header').boundingBox())!;
        const bottom = (await group(page, C).getByTestId('watchlist-group-header').boundingBox())!;
        const y = release === '위쪽 빈 공간' ? (panel.y + top.y) / 2 : bottom.y + bottom.height + 16;
        expect(y).toBeGreaterThan(panel.y);
        expect(y).toBeLessThan(panel.y + panel.height);
        await page.mouse.move(panel.x + panel.width / 2, y, { steps: 8 });
        await expect(page.locator('[data-panel-group-drop]')).toHaveCount(0);
      }
    }
    if (release === 'Esc') await page.keyboard.press('Escape');
    else await page.mouse.up();
    await expect(page.getByTestId('watchlist-drag-ghost')).toHaveCount(0);
    expect(state.folders()).toEqual([A, B, C]);
    expect(state.folderRequests).toHaveLength(0);
    await expect(row(page, B, '035420')).toBeVisible();
  });
}

for (const side of ['before', 'after'] as const) {
  test(`그룹 헤더의 ${side} 삽입선에 놓은 위치로 저장한다`, async ({ page }) => {
    const C = 'f_0000000c';
    const state = await setup(page, { [A]: [code('005930')], [B]: [code('035420')], [C]: [code('051910')] });
    await start(page, group(page, C).getByTestId('watchlist-group-header'));
    await over(page, group(page, A).getByTestId('watchlist-group-header'), side === 'before' ? 0.2 : 0.8);
    await expect(group(page, A).locator(`[data-panel-group-drop="${side}"]`)).toBeVisible();
    await page.mouse.up();
    await expect.poll(state.folders).toEqual(side === 'before' ? [C, A, B] : [A, C, B]);
    expect(state.folderRequests).toHaveLength(1);
  });
}

test('그룹이 많아도 원래 슬롯을 유지하고 화면 밖 그룹으로 스크롤할 수 있다', async ({ page }) => {
  const ids = [A, B, ...Array.from({ length: 28 }, (_, i) => `f_${(i + 100).toString(16).padStart(8, '0')}`)];
  const state = await setup(page, Object.fromEntries(ids.map((id, i) => [id, [code(String(100000 + i))]])));
  const panel = page.getByTestId('watchlist-scroll');
  const header = group(page, ids[20]).getByTestId('watchlist-group-header');
  await header.hover();
  const rect = (await header.boundingBox())!;
  const savedScroll = await panel.evaluate((el) => el.scrollTop);
  await start(page, header);
  await expect.poll(async () => Math.abs((await header.boundingBox())!.y - rect.y)).toBeLessThan(1);
  const compactScroll = await panel.evaluate((el) => el.scrollTop);
  expect(compactScroll).toBeGreaterThan(0);
  const bounds = (await panel.boundingBox())!;
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height - 12, { steps: 8 });
  await expect.poll(() => panel.evaluate((el) => el.scrollTop)).toBeGreaterThan(compactScroll + 10);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('watchlist-drag-ghost')).toHaveCount(0);
  expect(state.folderRequests).toHaveLength(0);
  expect(await panel.evaluate((el) => el.scrollTop)).toBe(savedScroll);
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


test('아이콘 없이 클릭·드래그·키보드 우클릭 메뉴를 각각 사용할 수 있다', async ({ page }, testInfo) => {
  const state = await setup(page);
  const first = row(page, A, '005930');
  const header = group(page, A).getByTestId('watchlist-group-header');
  await expect(first.getByRole('button', { name: /이동|행 메뉴/ })).toHaveCount(0);
  await expect(header.getByRole('button', { name: /그룹 이동|그룹 메뉴/ })).toHaveCount(0);
  await row(page, A, '000660').click();
  const activeCode = () => page.evaluate(async () => {
    const path = '/src/state/livePage.ts';
    const { useLivePageStore } = await import(path);
    return useLivePageStore.getState().activeCode;
  });
  await expect.poll(activeCode).toBe('000660');
  await start(page, first.getByText('삼성전자', { exact: true }));
  await over(page, row(page, A, '000660'), 0.8);
  await page.mouse.up();
  await expect.poll(() => codes(state.items()[A])).toEqual(['000660', '005930']);
  await expect.poll(activeCode).toBe('000660');
  await first.focus();
  await page.keyboard.press('Shift+F10');
  await expect(page.getByRole('menu', { name: '삼성전자 관심 그룹', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(first).toBeFocused();
  await header.focus();
  await page.keyboard.press('Shift+F10');
  await expect(page.getByRole('menu', { name: '스윙', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(header).toBeFocused();
  await group(page, A).screenshot({ path: testInfo.outputPath('panel-without-handles.png') });
});

for (const modifier of ['Control', 'Meta'] as const) {
  test(`${modifier}+클릭은 새 탭을 열고 현재 차트·선택·시작점을 유지한다`, async ({ page, context }) => {
    await setup(page);
    const first = row(page, A, '005930'), second = row(page, A, '000660'), third = row(page, B, '035420');
    await first.click();
    await second.click({ modifiers: ['Alt'] });
    await expect(second).toHaveAttribute('aria-pressed', 'true');
    const tabOpened = context.waitForEvent('page');
    await third.click({ modifiers: [modifier] });
    const newTab = await tabOpened;
    await expect(newTab).toHaveURL(/\/live\?code=035420&workspaceTransfer=[\w-]+$/);
    await newTab.waitForLoadState('domcontentloaded');
    await expect.poll(() => newTab.evaluate(async () => {
      const path = '/src/state/livePage.ts';
      const { useLivePageStore } = await import(path);
      return useLivePageStore.getState().activeCode;
    })).toBe('035420');
    await expect(first).toHaveAttribute('aria-current', 'true');
    await expect(second).toHaveAttribute('aria-pressed', 'true');
    await expect(third).toHaveAttribute('aria-pressed', 'false');
    await expect(page).toHaveURL(/\/live$/);
    await newTab.close();
    await first.click({ modifiers: ['Shift'] });
    await expect(first).toHaveAttribute('aria-pressed', 'true');
    await expect(second).toHaveAttribute('aria-pressed', 'true');
    await expect(third).toHaveAttribute('aria-pressed', 'false');
  });
}

test('Shift 범위와 Alt 개별 선택은 차트를 유지하고 키보드로 범위를 조절한다', async ({ page }) => {
  await setup(page);
  const first = row(page, A, '005930'), second = row(page, A, '000660'), third = row(page, B, '035420');
  await expect(page.getByTestId('watchlist-panel').getByRole('button', { name: '다중 선택' })).toHaveCount(0);
  await expect(first.getByRole('checkbox')).toHaveCount(0);
  await first.click();
  await third.click({ modifiers: ['Shift'] });
  for (const selected of [first, second, third]) await expect(selected).toHaveAttribute('aria-pressed', 'true');
  await expect(third).not.toHaveAttribute('aria-current', 'true');
  await second.click({ modifiers: ['Alt'] });
  await expect(second).toHaveAttribute('aria-pressed', 'false');
  await third.focus();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('watchlist-selection-actions')).toHaveCount(0);
  await first.focus();
  await page.keyboard.press('Shift+ArrowDown');
  await expect(second).toBeFocused();
  await expect(second).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Shift+ArrowDown');
  await expect(third).toBeFocused();
  await expect(third).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Shift+ArrowUp');
  await expect(third).toHaveAttribute('aria-pressed', 'false');
  await expect(first).toHaveAttribute('aria-current', 'true');
  await page.screenshot({ path: '/tmp/hoga-watchlist-shift-selection.png' });
});

test('선택한 여러 그룹 소속만 한 번에 삭제하고 다른 소속과 메모를 유지한다', async ({ page }) => {
  const state = await setup(page, { [A]: [code('005930'), { kind: 'memo', id: 'm_00000001' }, code('000660')], [B]: [code('035420'), code('005930')] });
  const requests: unknown[] = [];
  await page.route(apiExact('watchlist/items/remove'), async route => {
    const request = route.request().postDataJSON() as { changes: WatchlistFolderItemsChange[]; orphan_codes: string[] };
    requests.push(request);
    for (const c of request.changes) state.change(c.folder_id, c.after);
    await route.fulfill({ status: 204 });
  });
  await row(page, A, '005930').click();
  await row(page, A, '000660').click({ modifiers: ['Shift'] });
  await row(page, B, '035420').click({ modifiers: ['Alt'] });
  await expect(page.getByTestId('watchlist-selection-actions')).toContainText('3개 선택');
  await row(page, A, '005930').click({ button: 'right' });
  await page.getByRole('menuitem', { name: '선택 항목 삭제' }).click();
  const dialog = page.getByRole('dialog', { name: '삭제' });
  await expect(dialog).toContainText('2종목은 관심종목에서 빠집니다');
  expect(requests).toHaveLength(0);
  await dialog.getByRole('button', { name: '삭제', exact: true }).click();
  await expect(row(page, A, '005930')).toHaveCount(0);
  await expect(row(page, B, '005930')).toBeVisible();
  await expect(page.getByTestId('watchlist-memo-m_00000001')).toContainText('관찰 메모');
  await expect(row(page, B, '005930')).toBeFocused();
  expect(requests).toHaveLength(1);
  expect(codes(state.items()[A])).toEqual(['m_00000001']);
  expect(codes(state.items()[B])).toEqual(['005930']);
});

test('우클릭 그룹 이동도 다중 선택을 옮기고 되돌릴 수 있다', async ({ page }) => {
  const state = await setup(page);
  await row(page, A, '005930').click();
  await row(page, A, '000660').click({ modifiers: ['Shift'] });
  await row(page, A, '005930').focus();
  await page.keyboard.press('Shift+F10');
  await page.getByRole('menuitem', { name: '선택 항목 이동…' }).click();
  await page.getByRole('dialog', { name: '선택 항목 이동' }).getByRole('button', { name: '반도체' }).click();
  await expect.poll(() => codes(state.items()[B])).toEqual(['035420', '051910', '005930', '000660']);
  expect(state.items()[A]).toEqual([]);
  await page.getByRole('button', { name: '실행 취소', exact: true }).click();
  await expect.poll(() => codes(state.items()[A])).toEqual(['005930', '000660']);
});

test('전체 선택을 도구 버튼으로 삭제하면 남아 있는 패널 버튼에 포커스한다', async ({ page }) => {
  const state = await setup(page);
  await page.route(apiExact('watchlist/items/remove'), async route => {
    const request = route.request().postDataJSON() as { changes: WatchlistFolderItemsChange[] };
    for (const change of request.changes) state.change(change.folder_id, change.after);
    await route.fulfill({ status: 204 });
  });
  await row(page, A, '005930').click();
  await row(page, B, '051910').click({ modifiers: ['Shift'] });
  await page.getByTestId('watchlist-selection-actions').getByRole('button', { name: '삭제', exact: true }).click();
  await page.getByRole('dialog', { name: '삭제' }).getByRole('button', { name: '삭제', exact: true }).click();
  await expect(row(page, A, '005930')).toHaveCount(0);
  await expect(row(page, B, '051910')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '새 그룹 만들기' })).toBeFocused();
  await expect(page.getByTestId('watchlist-selection-actions')).toHaveCount(0);
});
