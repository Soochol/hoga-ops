import { test, expect, type Locator, type Page } from '@playwright/test';
import type { HeatmapResponse } from '../../src/api/heatmap';
import { installLiveMocks } from './helpers/liveMocks';
import { installLiveWs } from './helpers/liveWs';
import { apiExact, apiPrefix } from './helpers/apiRoutes';

const A = 'f_0000000a', B = 'f_0000000b', C = 'f_0000000c', D = 'f_0000000d', E = 'f_0000000e';
const card = (page: Page, id: string) => page.getByTestId(`heatmap-board-group-${id}`);
const grip = (page: Page, id: string) => card(page, id).getByRole('button', { name: /그룹 순서 이동/ });
const stock = (page: Page, id: string, code: string) => card(page, id).getByTestId(`heatmap-row-${code}`);
const domOrder = (page: Page) => page.getByTestId('heatmap-board').locator('[data-testid^="heatmap-board-group-"]')
  .evaluateAll(nodes => nodes.map(node => node.getAttribute('data-testid')?.replace('heatmap-board-group-', '')));

async function setup(page: Page) {
  await installLiveMocks(page);
  const ws = await installLiveWs(page);
  let data: HeatmapResponse = {
    folders: [
      { id: A, name: '공통 반도체', order: 0 }, { id: B, name: '숨은 배당', order: 1 },
      { id: C, name: '공통 빈 그룹', order: 2 },
      { id: D, name: '아주 긴 그룹 이름을 가진 전기차 배터리 소재와 장비', order: 3 },
    ],
    entries: [
      { code: '005930', name: '삼성전자', folder_id: A, order: 0 },
      { code: '000660', name: 'SK하이닉스', folder_id: A, order: 1 },
      { code: '035420', name: 'NAVER', folder_id: B, order: 0 },
      { code: '051910', name: 'LG화학', folder_id: D, order: 0 },
    ], capture_markers: {}, next_run_at_ms: 0,
  };
  const folderRequests: string[][] = [];
  const stockRequests: { path: string; body: unknown }[] = [];
  let reads = 0;
  let fail = false;
  let saveGate: Promise<void> | null = null;
  await page.route(apiPrefix('live/quotes'), route => route.fulfill({ json: {
    phase: 'open', quotes: data.entries.map((entry, index) => ({
      code: entry.code, price: 10000, change_won: index * 100, change_pct: index,
    })),
  } }));
  await page.route(apiExact('heatmap'), route => { reads++; return route.fulfill({ json: data }); });
  await page.route(apiExact('heatmap/folders/order'), async route => {
    const ids: string[] = route.request().postDataJSON().ordered_ids;
    folderRequests.push(ids);
    if (saveGate) await saveGate;
    if (fail || ids.length !== data.folders.length || new Set(ids).size !== ids.length
      || ids.some(id => !data.folders.some(folder => folder.id === id))) {
      return route.fulfill({ status: 409, json: { detail: { code: 'folder_set_mismatch', message: '목록 변경' } } });
    }
    data = { ...data, folders: data.folders.map(folder => ({ ...folder, order: ids.indexOf(folder.id) })) };
    return route.fulfill({ status: 204, body: '' });
  });
  for (const path of ['heatmap/reorder', 'heatmap/move']) await page.route(apiExact(path), route => {
    const body = route.request().postDataJSON();
    stockRequests.push({ path, body });
    if (path.endsWith('/reorder')) data = { ...data, entries: data.entries.map(entry => entry.folder_id === body.folder_id
      ? { ...entry, order: body.ordered_codes.indexOf(entry.code) } : entry) };
    else data = { ...data, entries: data.entries.map(entry => body.codes.includes(entry.code) && entry.folder_id === body.from_folder_id
      ? { ...entry, folder_id: body.folder_id, order: data.entries.filter(e => e.folder_id === body.folder_id).length } : entry) };
    return route.fulfill({ status: 204, body: '' });
  });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/heatmap');
  await expect(card(page, A)).toBeVisible();
  await expect.poll(ws.connectionCount).toBe(1);
  return {
    folderRequests, stockRequests, errors, data: () => data, reads: () => reads,
    hold: () => { let release!: () => void; saveGate = new Promise(resolve => { release = resolve; }); return release; },
    fail: () => { fail = true; },
    change: async (update: (current: HeatmapResponse) => HeatmapResponse) => {
      data = update(data);
      const before = reads;
      ws.pushEvent({ type: 'heatmap_changed' });
      await expect.poll(() => reads).toBeGreaterThan(before);
    },
  };
}

async function center(locator: Locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error('Missing drag target');
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}
async function start(page: Page, source: Locator) {
  await source.scrollIntoViewIfNeeded();
  const p = await center(source);
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  await page.mouse.move(p.x + 7, p.y, { steps: 3 });
}
async function target(page: Page, locator: Locator) {
  const p = await center(locator);
  await page.mouse.move(p.x, p.y, { steps: 12 });
}
async function moveGroup(page: Page, from: string, to: string) {
  await expect(grip(page, from)).toBeEnabled();
  await start(page, grip(page, from));
  await expect(page.getByTestId('heatmap-group-drag-ghost')).toBeVisible();
  await target(page, card(page, to));
  await expect(card(page, to).locator('[data-heatmap-group-drop]')).toBeVisible();
  await page.mouse.up();
  await expect(page.getByTestId('heatmap-group-drag-ghost')).toHaveCount(0);
}

test('multi-column pointer reorder persists full group order and keeps stock sort separate', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 950 });
  const state = await setup(page);
  const entries = structuredClone(state.data().entries);
  const boxes = await Promise.all([card(page, A).boundingBox(), card(page, D).boundingBox()]);
  expect(boxes[0]?.x).not.toBe(boxes[1]?.x);
  await page.getByRole('button', { name: '종목 정렬', exact: true }).click();
  await expect(page.getByRole('button', { name: '종목 정렬', exact: true })).toContainText('상승순');
  await moveGroup(page, D, A);
  await expect.poll(() => domOrder(page)).toEqual([D, A, B, C]);
  await expect.poll(() => state.folderRequests).toEqual([[D, A, B, C]]);
  await moveGroup(page, C, D);
  await expect.poll(() => domOrder(page)).toEqual([C, D, A, B]);
  await expect.poll(() => state.folderRequests).toHaveLength(2);
  expect(state.data().entries).toEqual(entries);
  expect(state.stockRequests).toEqual([]);
  await page.reload();
  await expect.poll(() => domOrder(page)).toEqual([C, D, A, B]);
  await expect(page.getByRole('button', { name: '종목 정렬', exact: true })).toContainText('상승순');
  await page.screenshot({ path: '/tmp/hoga-heatmap-group-drag-wide.png' });
  expect(state.errors).toEqual([]);
});

test('search reorder includes hidden groups without changing their relative order', async ({ page }) => {
  const state = await setup(page);
  await page.getByTestId('heatmap-search').fill('공통');
  await expect.poll(() => domOrder(page)).toEqual([A, C]);
  await moveGroup(page, C, A);
  await expect.poll(() => state.folderRequests).toEqual([[C, A, B, D]]);
  await page.getByTestId('heatmap-search').fill('');
  await expect.poll(() => domOrder(page)).toEqual([C, A, B, D]);
  await page.reload();
  await expect.poll(() => domOrder(page)).toEqual([C, A, B, D]);
});

test('narrow keyboard move restores focus; Escape, outside drop and automatic group sort do not save', async ({ page }) => {
  await page.setViewportSize({ width: 440, height: 740 });
  const state = await setup(page);
  await grip(page, A).focus();
  await page.keyboard.press('Space');
  await page.keyboard.press('ArrowDown');
  await expect(card(page, B).locator('[data-heatmap-group-drop="after"]')).toBeVisible();
  await page.keyboard.press('Enter');
  await expect.poll(() => state.folderRequests).toEqual([[B, A, C, D]]);
  await expect(grip(page, A)).toBeFocused();
  await page.keyboard.press('Space');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('heatmap-group-drag-ghost')).toHaveCount(0);
  await expect(grip(page, A)).toBeFocused();
  await start(page, grip(page, A));
  await page.mouse.move(2, 2, { steps: 10 });
  await page.mouse.up();
  await expect(page.getByTestId('heatmap-group-drag-ghost')).toHaveCount(0);
  await grip(page, C).click();
  expect(state.folderRequests).toHaveLength(1);
  await page.getByRole('button', { name: '그룹 정렬', exact: true }).click();
  await expect(grip(page, A)).toBeDisabled();
  await expect(grip(page, A)).toHaveAttribute('data-tooltip', /자동 정렬.*수동 정렬/);
  await page.getByRole('button', { name: '그룹 정렬', exact: true }).click();
  await page.getByRole('button', { name: '그룹 정렬', exact: true }).click();
  await expect(grip(page, A)).toBeEnabled();
  await page.screenshot({ path: '/tmp/hoga-heatmap-group-drag-narrow.png' });
  expect(state.folderRequests).toHaveLength(1);
  expect(state.errors).toEqual([]);
});

test('failed save preserves concurrent group rename/add/delete and stock membership updates', async ({ page }) => {
  const state = await setup(page);
  const release = state.hold();
  await moveGroup(page, C, A);
  await expect.poll(() => state.folderRequests).toHaveLength(1);
  await expect(grip(page, A)).toBeDisabled();
  await state.change(current => ({ ...current,
    folders: [...current.folders.filter(folder => folder.id !== B).map(folder => ({ ...folder, name: `${folder.name} 변경` })),
      { id: E, name: '새 그룹', order: 4 }],
    entries: [{ code: '035420', name: 'NAVER', folder_id: E, order: 0 }],
  }));
  await expect(card(page, E)).toContainText('NAVER');
  state.fail(); release();
  await expect(page.getByRole('status').filter({ hasText: '그룹 순서를 저장하지 못했습니다' })).toBeVisible();
  await expect.poll(() => domOrder(page)).toEqual([A, C, D, E]);
  await expect(card(page, E)).toContainText('NAVER');
  await expect(card(page, A)).toContainText('공통 반도체 변경');
  await expect(card(page, B)).toHaveCount(0);
  await expect(stock(page, A, '005930')).toHaveCount(0);
  await page.reload();
  await expect.poll(() => domOrder(page)).toEqual([A, C, D, E]);
  expect(state.errors).toEqual([]);
});

test('drop resolves latest canonical IDs when group structure changes during drag', async ({ page }) => {
  const state = await setup(page);
  await start(page, grip(page, C));
  await expect(page.getByTestId('heatmap-group-drag-ghost')).toBeVisible();
  await state.change(current => ({ ...current,
    folders: [...current.folders.filter(folder => folder.id !== B), { id: E, name: '새 그룹', order: 4 }],
    entries: current.entries.filter(entry => entry.folder_id !== B),
  }));
  await target(page, card(page, A));
  await page.mouse.up();
  await expect.poll(() => state.folderRequests).toEqual([[C, A, D, E]]);
  await expect.poll(() => domOrder(page)).toEqual([C, A, D, E]);
  await start(page, grip(page, C));
  await state.change(current => ({ ...current, folders: current.folders.filter(folder => folder.id !== C) }));
  await target(page, card(page, A));
  await page.mouse.up();
  await expect.poll(() => domOrder(page)).toEqual([A, D, E]);
  expect(state.folderRequests).toHaveLength(1);
});

test('stock pointer reorder and cross-group move remain separate from group dragging', async ({ page }) => {
  const state = await setup(page);
  await start(page, stock(page, A, '005930'));
  await target(page, stock(page, A, '000660'));
  await page.mouse.up();
  await expect.poll(() => state.stockRequests).toHaveLength(1);
  expect(state.stockRequests[0]).toEqual({ path: 'heatmap/reorder', body: { folder_id: A, ordered_codes: ['000660', '005930'] } });
  await start(page, stock(page, A, '005930'));
  await target(page, card(page, C));
  await page.mouse.up();
  await expect.poll(() => state.stockRequests).toHaveLength(2);
  await expect(stock(page, C, '005930')).toBeVisible();
  expect(state.folderRequests).toEqual([]);
  await stock(page, C, '005930').click({ button: 'right' });
  await expect(page.getByRole('menu')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByTestId(`heatmap-folder-name-${A}`).dblclick();
  await expect(page.getByRole('textbox', { name: '그룹 이름 수정' })).toBeVisible();
  await page.keyboard.press('Escape');
  expect(state.folderRequests).toEqual([]);
  expect(state.errors).toEqual([]);
});

test('scrolling during a group drag reaches offscreen destinations in a single column', async ({ page }) => {
  await page.setViewportSize({ width: 440, height: 900 });
  const state = await setup(page);
  const extra = Array.from({ length: 14 }, (_, i) => ({ id: `f_${(256 + i).toString(16).padStart(8, '0')}`, name: `빈 그룹 ${i}`, order: i + 4 }));
  await state.change(current => ({ ...current, folders: [...current.folders, ...extra] }));
  await expect(card(page, extra[13].id)).toHaveCount(1);
  const board = page.getByTestId('heatmap-board');
  await start(page, grip(page, A));
  const rect = await board.boundingBox();
  if (!rect) throw new Error('Missing board');
  await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height - 5, { steps: 8 });
  await expect.poll(() => board.evaluate(node => node.scrollTop)).toBeGreaterThan(0);
  await expect.poll(() => board.evaluate(node => node.scrollTop + node.clientHeight >= node.scrollHeight - 2)).toBe(true);
  await target(page, card(page, extra[13].id));
  await expect(card(page, extra[13].id).locator('[data-heatmap-group-drop="after"]')).toBeVisible();
  await page.screenshot({ path: '/tmp/hoga-heatmap-group-drag-scroll.png' });
  await page.mouse.up();
  await expect.poll(() => state.folderRequests).toEqual([[B, C, D, ...extra.map(folder => folder.id), A]]);
  await expect.poll(() => domOrder(page)).toEqual([B, C, D, ...extra.map(folder => folder.id), A]);
  expect(state.errors).toEqual([]);
});
