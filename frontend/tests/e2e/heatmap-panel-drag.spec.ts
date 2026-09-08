/// <reference types="vite/client" />
import { test, expect, type Page, type Locator } from '@playwright/test';
import { installLiveMocks } from './helpers/liveMocks';
import { apiExact, apiPrefix } from './helpers/apiRoutes';
import type { HeatmapFolderEntriesChange } from '../../src/api/heatmap';

const A = 'f_0000000a', B = 'f_0000000b';
const names: Record<string, string> = { '005930': '삼성전자', '000660': 'SK하이닉스', '035420': 'NAVER', '051910': 'LG화학' };
const code = (code: string) => code;
const group = (page: Page, id: string) => page.getByTestId(`heatmap-drawer-group-${id}`);
const row = (page: Page, id: string, symbol: string) => group(page, id).getByTestId(`heatmap-drawer-row-${symbol}`);
const handle = (page: Page, id: string, symbol: string) => row(page, id, symbol).getByRole('button', { name: `${names[symbol] ?? symbol} 이동`, exact: true });

async function setup(page: Page, initial: Record<string, string[]> = {
  [A]: [code('005930'), code('000660')], [B]: [code('035420'), code('051910')],
}) {
  await installLiveMocks(page);
  let folders = [A, B];
  let items = structuredClone(initial);
  const requests: HeatmapFolderEntriesChange[][] = [];
  let fail = false;
  let saveGate: Promise<void> | null = null;
  const json = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  await page.route(apiPrefix('live/quotes'), (r) => r.fulfill(json({ phase: 'open', quotes: [] })));
  await page.route(apiExact('heatmap'), (r) => r.fulfill(json({
    folders: folders.map((id, order) => ({ id, order, name: id === A ? '스윙' : '반도체' })),
    entries: Object.entries(items).flatMap(([folder_id, refs]) => refs.map((code, order) => ({
      code, name: names[code] ?? code, folder_id, order,
    }))), capture_markers: {}, next_run_at_ms: 0,
  })));
  await page.route(apiExact('heatmap/entries/transaction'), async (r) => {
    const changes = r.request().postDataJSON().changes as HeatmapFolderEntriesChange[];
    requests.push(changes);
    if (saveGate) await saveGate;
    if (fail || changes.some((c) => JSON.stringify(items[c.folder_id]) !== JSON.stringify(c.before))) {
      return r.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ detail: { message: '목록이 변경되었습니다. 다시 시도하세요.' } }) });
    }
    items = { ...items, ...Object.fromEntries(changes.map((c) => [c.folder_id, c.after])) };
    return r.fulfill({ status: 204, body: '' });
  });
  await page.route(apiExact('heatmap/folders/order'), async (r) => {
    folders = r.request().postDataJSON().ordered_ids;
    return r.fulfill({ status: 204, body: '' });
  });
  await page.goto('/live');
  await page.getByRole('button', { name: /히트맵 패널 토글/ }).click();
  await expect(group(page, A)).toBeVisible();
  return { requests, hold: () => { let release!: () => void; saveGate = new Promise<void>((resolve) => { release = resolve; }); return release; }, items: () => items, folders: () => folders, fail: () => { fail = true; },
    change: (id: string, refs: string[]) => { items[id] = refs; } };
}
async function point(locator: Locator, fraction = 0.5) {
  const box = await locator.boundingBox();
  if (!box) throw new Error('Drag surface is missing');
  return { x: box.x + box.width / 2, y: box.y + box.height * fraction };
}
async function start(page: Page, locator: Locator) {
  await expect(page.getByTestId('heatmap-drag-ghost')).toHaveCount(0);
  await locator.hover();
  const p = await point(locator);
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  await page.mouse.move(p.x + 7, p.y, { steps: 3 });
  await expect(page.getByTestId('heatmap-drag-ghost')).toBeVisible();
}
async function over(page: Page, locator: Locator, fraction = 0.5) {
  const p = await point(locator, fraction);
  await page.mouse.move(p.x, p.y, { steps: 12 });
}
async function move(page: Page, source: Locator, target: Locator, fraction = 0.5) {
  await start(page, source);
  await over(page, target, fraction);
  await page.mouse.up();
  await expect(page.getByTestId('heatmap-drag-ghost')).toHaveCount(0);
}
const codes = (refs: string[]) => refs;

test('같은 그룹 재정렬과 되돌리기', async ({ page }) => {
  const state = await setup(page);
  await move(page, handle(page, A, '005930'), row(page, A, '000660'), 0.8);
  await expect.poll(() => codes(state.items()[A])).toEqual(['000660', '005930']);
  await expect(page.getByRole('button', { name: '되돌리기', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '되돌리기', exact: true }).click();
  await expect.poll(() => codes(state.items()[A])).toEqual(['005930', '000660']);
});

test('다른 그룹의 행 사이에 정확히 삽입하고 목적지를 안내한다', async ({ page }) => {
  const state = await setup(page);
  await start(page, handle(page, A, '005930'));
  await over(page, row(page, B, '035420'), 0.8);
  await expect(page.getByRole('status').filter({ hasText: '반도체 · NAVER 아래로 이동' })).toBeVisible();
  await page.screenshot({ path: '/tmp/hoga-heatmap-drag-destination.png' });
  await page.mouse.up();
  await expect.poll(() => codes(state.items()[B])).toEqual(['035420', '005930', '051910']);
  expect(codes(state.items()[A])).toEqual(['000660']);
  expect(state.requests).toHaveLength(1);
});

test('그룹 헤더는 맨 아래, 빈 그룹에도 이동 가능', async ({ page }) => {
  const state = await setup(page, { [A]: [code('005930'), code('000660')], [B]: [] });
  await move(page, handle(page, A, '005930'), group(page, B).getByTestId('heatmap-group-header'));
  await expect.poll(() => codes(state.items()[B])).toEqual(['005930']);
  await move(page, handle(page, A, '000660'), group(page, B).getByTestId('heatmap-group-header'));
  await expect.poll(() => codes(state.items()[B])).toEqual(['005930', '000660']);
});

test('다중 선택 이동은 중복을 합치고 되돌리기는 원래 양쪽 소속을 복원한다', async ({ page }) => {
  const initial = { [A]: [code('005930'), code('000660')], [B]: [code('035420'), code('005930')] };
  const state = await setup(page, initial);
  await page.getByRole('button', { name: '여러 종목 선택' }).click();
  await row(page, A, '005930').getByRole('checkbox').check();
  await row(page, A, '000660').getByRole('checkbox').check();
  await start(page, handle(page, A, '005930'));
  await expect(page.getByTestId('heatmap-drag-ghost')).toContainText('2종목');
  await over(page, row(page, B, '035420'), 0.8);
  await expect(page.getByRole('status').filter({ hasText: '기존 1종목과 합침' })).toBeVisible();
  await page.mouse.up();
  await expect.poll(() => codes(state.items()[B])).toEqual(['035420', '005930', '000660']);
  expect(state.items()[A]).toEqual([]);
  await page.getByRole('button', { name: '되돌리기', exact: true }).click();
  await expect.poll(state.items).toEqual(initial);
  await expect(page.getByTestId('heatmap-drag-ghost')).toHaveCount(0);
  await page.screenshot({ path: '/tmp/hoga-heatmap-drag-selection.png' });
});

test('접힌 그룹에 머무르면 펼쳐지고 취소하면 원래 접힘 상태로 돌아간다', async ({ page }) => {
  const state = await setup(page);
  await page.getByRole('button', { name: '반도체 접기' }).click();
  await start(page, handle(page, A, '005930'));
  await over(page, group(page, B).getByTestId('heatmap-group-header'));
  await expect(row(page, B, '035420')).toBeVisible({ timeout: 2500 });
  await page.keyboard.press('Escape');
  await expect(row(page, B, '035420')).toBeHidden();
  expect(state.requests).toHaveLength(0);
});

test('정렬 중에도 그룹 간 이동하고 같은 그룹 수동 재정렬은 제한한다', async ({ page }) => {
  const state = await setup(page);
  await page.getByTestId('heatmap-panel').getByRole('button', { name: '종목 정렬', exact: true }).click();
  await move(page, handle(page, A, '005930'), row(page, A, '000660'), 0.8);
  expect(state.requests).toHaveLength(0);
  await start(page, handle(page, A, '005930'));
  await over(page, row(page, B, '035420'), 0.8);
  await expect(page.getByRole('status').filter({ hasText: '정렬 기준에 따라 배치' })).toBeVisible();
  await page.mouse.up();
  await expect.poll(() => codes(state.items()[B])).toContain('005930');
});

test('패널 바깥 드롭은 저장하지 않고 클릭은 차트를 연다', async ({ page }) => {
  const state = await setup(page);
  await row(page, A, '000660').click();
  await expect(row(page, A, '000660')).toHaveAttribute('aria-current', 'true');
  await start(page, handle(page, A, '005930'));
  await page.mouse.move(20, 20, { steps: 10 });
  await page.mouse.up();
  expect(state.requests).toHaveLength(0);
  await expect(page.getByTestId('heatmap-drag-ghost')).toHaveCount(0);
  expect(state.requests).toHaveLength(0);
});

test('저장 실패를 안내하며 원래 소속을 유지한다', async ({ page }) => {
  const state = await setup(page);
  state.fail();
  await move(page, handle(page, A, '005930'), row(page, B, '035420'));
  await expect(page.getByRole('status').filter({ hasText: '변경을 완료하지 못했습니다' })).toBeVisible();
  expect(codes(state.items()[A])).toContain('005930');
  expect(codes(state.items()[B])).not.toContain('005930');
});

test('이동 이후 다른 변경이 있으면 되돌리기가 덮어쓰지 않는다', async ({ page }) => {
  const state = await setup(page);
  await move(page, handle(page, A, '005930'), row(page, B, '035420'), 0.8);
  await expect(page.getByRole('button', { name: '되돌리기', exact: true })).toBeVisible();
  const changed = [code('051910'), code('005930'), code('035420')];
  state.change(B, changed);
  await page.getByRole('button', { name: '되돌리기', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '되돌리기를 완료하지 못했습니다' })).toBeVisible();
  expect(state.items()[B]).toEqual(changed);
});

test('그룹 핸들로만 순서를 옮기고 드롭 후 목록이 돌아온다', async ({ page }) => {
  const state = await setup(page);
  await start(page, page.getByRole('button', { name: '스윙 그룹 이동', exact: true }));
  await over(page, group(page, B));
  await page.mouse.up();
  await expect.poll(state.folders).toEqual([B, A]);
  await expect(row(page, A, '005930')).toBeVisible();
});

test('가장자리에서 자동 스크롤하며 멀어지면 멈춘다', async ({ page }) => {
  await setup(page, { [A]: [code('005930'), ...Array.from({ length: 50 }, (_, i) => code(String(100000 + i)))], [B]: [] });
  const panel = page.getByTestId('heatmap-drawer-scroll');
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


test('Ctrl 복제는 원본과 기존 목적지 위치를 유지하고 되돌릴 수 있다', async ({ page }) => {
  const initial = { [A]: ['005930', '000660'], [B]: ['035420', '005930', '051910'] };
  const state = await setup(page, initial);
  await page.getByRole('button', { name: '여러 종목 선택' }).click();
  await row(page, A, '005930').getByRole('checkbox').check();
  await row(page, A, '000660').getByRole('checkbox').check();
  await start(page, handle(page, A, '005930'));
  await over(page, row(page, B, '035420'), 0.2);
  await page.keyboard.down('Control');
  await expect(page.getByTestId('heatmap-drag-ghost')).toContainText('복제');
  await expect(page.getByRole('status').filter({ hasText: '기존 1종목은 유지' })).toBeVisible();
  await page.mouse.up();
  await page.keyboard.up('Control');
  await expect.poll(() => state.items()[B]).toEqual(['000660', '035420', '005930', '051910']);
  expect(state.items()[A]).toEqual(initial[A]);
  await page.getByRole('button', { name: '되돌리기', exact: true }).click();
  await expect.poll(state.items).toEqual(initial);
});

test('저장 중 추가 드래그를 막고 완료 후 다시 사용할 수 있다', async ({ page }) => {
  const state = await setup(page);
  const release = state.hold();
  await move(page, handle(page, A, '005930'), row(page, B, '035420'), 0.8);
  await expect(handle(page, A, '000660')).toBeDisabled();
  await expect(page.getByRole('status').filter({ hasText: '저장 중' })).toBeVisible();
  expect(state.requests).toHaveLength(1);
  release();
  await expect(handle(page, A, '000660')).toBeEnabled();
  await expect(page.getByRole('button', { name: '되돌리기', exact: true })).toBeVisible();
});

test('스크롤 후 고정된 헤더에 놓으면 해당 그룹 끝으로 이동한다', async ({ page }) => {
  const initial = { [A]: ['005930', ...Array.from({ length: 35 }, (_, i) => String(100000 + i))], [B]: ['035420'] };
  const state = await setup(page, initial);
  const panel = page.getByTestId('heatmap-drawer-scroll');
  await start(page, handle(page, B, '035420'));
  await panel.evaluate((e) => { e.scrollTop = 150; });
  await over(page, group(page, A).getByTestId('heatmap-group-header'));
  await expect(page.getByRole('status').filter({ hasText: '스윙 · 맨 아래로 이동' })).toBeVisible();
  await page.mouse.up();
  await expect.poll(() => state.items()[A]).toEqual([...initial[A], '035420']);
});

test('Delete는 포커스된 그룹에서만 제외하고 중첩 버튼에서는 무시한다', async ({ page }) => {
  const state = await setup(page, { [A]: ['005930', '000660'], [B]: ['005930'] });
  const removals: string[] = [];
  await page.route(apiExact(`heatmap/folders/${A}/members/005930`), (r) => {
    removals.push('005930'); state.change(A, ['000660']);
    return r.fulfill({ status: 204, body: '' });
  });
  await handle(page, A, '005930').focus();
  await page.keyboard.press('Delete');
  expect(removals).toEqual([]);
  await row(page, A, '005930').focus();
  await page.keyboard.press('Backspace');
  expect(removals).toEqual([]);
  await page.keyboard.press('Delete');
  await expect(row(page, A, '005930')).toHaveCount(0);
  await expect(row(page, B, '005930')).toBeVisible();
  await expect(row(page, A, '000660')).toBeFocused();
  expect(removals).toEqual(['005930']);
});

test('Delete 안내에 이전 이동의 되돌리기를 표시하지 않는다', async ({ page }) => {
  const state = await setup(page);
  await move(page, handle(page, A, '005930'), row(page, B, '035420'), 0.8);
  await expect(page.getByRole('button', { name: '되돌리기', exact: true })).toBeVisible();
  await page.route(apiExact(`heatmap/folders/${A}/members/000660`), (r) => {
    state.change(A, []);
    return r.fulfill({ status: 204, body: '' });
  });
  await row(page, A, '000660').focus();
  await page.keyboard.press('Delete');
  await expect(page.getByRole('status').filter({ hasText: '현재 그룹에서 제외했습니다' })).toBeVisible();
  await expect(page.getByRole('button', { name: '되돌리기', exact: true })).toHaveCount(0);
  expect(state.items()[B]).toContain('005930');
});
