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
const handle = (page: Page, id: string, symbol: string) => row(page, id, symbol);

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
  // dnd-kit AbstractPointerSensor.detach retains document click suppression
  // for 50ms after drop. A fast mocked save can expose Undo before that expires;
  // clicking then is swallowed even though Playwright sees an enabled button.
  await page.waitForTimeout(60); // Library cleanup guard, not a network wait.
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
  await row(page, A, '005930').click();
  await row(page, A, '000660').click({ modifiers: ['Shift'] });
  await expect(row(page, A, '005930')).toHaveAttribute('aria-pressed', 'true');
  await expect(row(page, A, '000660')).toHaveAttribute('aria-pressed', 'true');
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

test('그룹 헤더로 순서를 옮기고 드롭 후 목록이 돌아온다', async ({ page }) => {
  const state = await setup(page);
  await start(page, group(page, A).getByTestId('heatmap-group-header'));
  await expect(row(page, A, '005930')).toBeHidden();
  await over(page, group(page, B));
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
  { name: '일부만 접힌 그룹', source: B, count: 8, mixed: true },
]) {
  test(`그룹 헤더가 접히는 동안 잡은 좌표를 유지한다: ${scenario.name}`, async ({ page }) => {
    await page.routeWebSocket(/\/api\/ws/, (ws) => ws.onMessage(() => {}));
    const state = await setup(page, {
      [A]: Array.from({ length: scenario.count }, (_, i) => code(String(100000 + i))),
      [B]: [code('035420'), code('051910')],
    });
    const panel = page.getByTestId('heatmap-drawer-scroll');
    if (scenario.collapsed) {
      await group(page, A).getByRole('button', { name: '스윙 접기', exact: true }).click();
      await group(page, B).getByRole('button', { name: '반도체 접기', exact: true }).click();
    }
    if (scenario.mixed) await group(page, B).getByRole('button', { name: '반도체 접기', exact: true }).click();
    if (scenario.sticky) await panel.evaluate((el) => { el.scrollTop = 150; });
    const header = group(page, scenario.source).getByTestId('heatmap-group-header');
    await header.scrollIntoViewIfNeeded();
    const rect = await header.boundingBox();
    if (!rect) throw new Error('Group header missing');
    if (scenario.count === 30) expect(await panel.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    const rows = page.locator('[data-testid^="heatmap-drawer-row-"]');
    const rowCount = await rows.count();
    const savedCollapse = await page.evaluate(() => localStorage.getItem('heatmapDrawer.collapsed'));
    // Grab away from the centre to verify the original grab point, not a snap-to-centre.
    const grab = { x: rect.width * 0.37, y: rect.height * 0.75 };
    const origin = { x: rect.x + grab.x, y: rect.y + grab.y };
    await page.mouse.move(origin.x, origin.y);
    await page.mouse.down();
    const ghost = page.getByTestId('heatmap-drag-ghost');
    for (const delta of [{ x: 7, y: 0 }, { x: 39, y: 34 }, { x: -21, y: -29 }]) {
      const cursor = { x: origin.x + delta.x, y: origin.y + delta.y };
      await page.mouse.move(cursor.x, cursor.y, { steps: 4 });
      await expect(ghost).toBeVisible();
      await expect(rows).toHaveCount(0);
      await expect.poll(async () => {
        const box = await ghost.boundingBox();
        if (!box) return Infinity;
        return Math.max(Math.abs(box.x + grab.x - cursor.x), Math.abs(box.y + grab.y - cursor.y),
          Math.abs(box.width - rect.width), Math.abs(box.height - rect.height));
      }).toBeLessThan(1);
    }
    if (scenario.drop) {
      await over(page, group(page, A).getByTestId('heatmap-group-header'));
      await page.mouse.up();
      await expect.poll(state.folders).toEqual([B, A]);
    } else {
      await page.keyboard.press('Escape');
      expect(state.folders()).toEqual([A, B]);
    }
    await expect(ghost).toHaveCount(0);
    await expect(rows).toHaveCount(rowCount);
    expect(await page.evaluate(() => localStorage.getItem('heatmapDrawer.collapsed'))).toBe(savedCollapse);
  });
}

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
  await row(page, A, '005930').click();
  await row(page, A, '000660').click({ modifiers: ['Shift'] });
  await expect(row(page, A, '005930')).toHaveAttribute('aria-pressed', 'true');
  await expect(row(page, A, '000660')).toHaveAttribute('aria-pressed', 'true');
  await start(page, handle(page, A, '005930'));
  await over(page, row(page, B, '035420'), 0.2);
  await page.keyboard.down('Control');
  await expect(page.getByTestId('heatmap-drag-ghost')).toContainText('복제');
  await expect(page.getByRole('status').filter({ hasText: '기존 1종목은 유지' })).toBeVisible();
  await page.mouse.up();
  await page.keyboard.up('Control');
  await expect.poll(() => state.items()[B]).toEqual(['000660', '035420', '005930', '051910']);
  expect(state.items()[A]).toEqual(initial[A]);
  expect(page.context().pages()).toHaveLength(1); // Ctrl drag must not open a tab on release.
  // Same dnd-kit 50ms document click suppression guard as the move() helper.
  await page.waitForTimeout(60);
  await page.getByRole('button', { name: '되돌리기', exact: true }).click();
  await expect.poll(state.items).toEqual(initial);
});

test('저장 중 추가 드래그를 막고 완료 후 다시 사용할 수 있다', async ({ page }) => {
  const state = await setup(page);
  const release = state.hold();
  await move(page, handle(page, A, '005930'), row(page, B, '035420'), 0.8);
  await expect(handle(page, A, '000660')).not.toHaveAttribute('data-draggable');
  await expect(page.getByRole('status').filter({ hasText: '저장 중' })).toBeVisible();
  expect(state.requests).toHaveLength(1);
  release();
  await expect(handle(page, A, '000660')).toHaveAttribute('data-draggable', '');
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
  await expect(page.getByTestId('heatmap-panel').getByRole('button', { name: '다중 선택', exact: true })).toHaveCount(0);
  await page.getByTestId('heatmap-drawer-search').focus();
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


test('아이콘 없이 클릭·드래그·키보드 우클릭 메뉴를 각각 사용할 수 있다', async ({ page }, testInfo) => {
  const state = await setup(page);
  const first = row(page, A, '005930');
  const header = group(page, A).getByTestId('heatmap-group-header');
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

test('Shift 범위·Alt 개별 선택과 Shift 화살표는 차트를 바꾸지 않는다', async ({ page }) => {
  await setup(page);
  const first = row(page, A, '005930'), second = row(page, A, '000660'), third = row(page, B, '035420');
  await expect(page.getByTestId('heatmap-panel').getByRole('button', { name: '다중 선택' })).toHaveCount(0);
  await expect(first.getByRole('checkbox')).toHaveCount(0);
  await first.click();
  await third.click({ modifiers: ['Shift'] });
  for (const selected of [first, second, third]) await expect(selected).toHaveAttribute('aria-pressed', 'true');
  await expect(third).not.toHaveAttribute('aria-current', 'true');
  await second.click({ modifiers: ['Alt'] });
  await expect(second).toHaveAttribute('aria-pressed', 'false');
  await third.focus();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('heatmap-selection-actions')).toHaveCount(0);
  await first.focus();
  await page.keyboard.press('Shift+ArrowDown');
  await expect(second).toBeFocused();
  await page.keyboard.press('Shift+ArrowDown');
  await expect(third).toBeFocused();
  await expect(third).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Shift+ArrowUp');
  await expect(third).toHaveAttribute('aria-pressed', 'false');
  await expect(first).toHaveAttribute('aria-current', 'true');
  await page.screenshot({ path: '/tmp/hoga-heatmap-shift-selection.png' });
});

test('선택 항목 우클릭 메뉴로 이동하고 되돌릴 수 있다', async ({ page }) => {
  const state = await setup(page);
  await row(page, A, '005930').click();
  await row(page, A, '000660').click({ modifiers: ['Shift'] });
  await row(page, A, '005930').focus();
  await page.keyboard.press('Shift+F10');
  await page.getByRole('menuitem', { name: '선택 항목 이동…' }).click();
  await page.getByRole('dialog', { name: '선택 항목 이동' }).getByRole('button', { name: '반도체' }).click();
  await expect.poll(() => state.items()[B]).toEqual(['035420', '051910', '005930', '000660']);
  expect(state.items()[A]).toEqual([]);
  await page.getByRole('button', { name: '되돌리기', exact: true }).click();
  await expect.poll(() => state.items()[A]).toEqual(['005930', '000660']);
});

test('Alt 개별 선택 후 Ctrl 드래그로 선택한 종목을 복제한다', async ({ page }) => {
  const initial = { [A]: ['005930', '000660'], [B]: ['035420', '051910'] };
  const state = await setup(page, initial);
  await row(page, A, '005930').click({ modifiers: ['Alt'] });
  await row(page, A, '000660').click({ modifiers: ['Alt'] });
  await expect(page.getByTestId('heatmap-selection-actions')).toContainText('2개 선택');
  expect(state.requests).toHaveLength(0);
  await page.keyboard.down('Control');
  await start(page, handle(page, A, '005930'));
  await expect(page.getByTestId('heatmap-drag-ghost')).toContainText('복제');
  await over(page, row(page, B, '051910'), 0.8);
  await page.mouse.up();
  await page.keyboard.up('Control');
  await expect.poll(() => state.items()[B]).toEqual(['035420', '051910', '005930', '000660']);
  expect(state.items()[A]).toEqual(initial[A]);
  expect(page.context().pages()).toHaveLength(1); // Ctrl drag must not open a tab on release.
  expect(state.requests).toHaveLength(1);
});

for (const all of [false, true]) {
  test(`일괄 삭제는 ${all ? '전체 행 삭제 후 포커스를 유지한다' : '다른 그룹의 같은 종목을 유지한다'}`, async ({ page }) => {
    const state = await setup(page, { [A]: ['005930', '000660'], [B]: ['035420', '005930'] });
    const requests: { changes: HeatmapFolderEntriesChange[]; orphan_codes: string[] }[] = [];
    await page.route(apiExact('heatmap/entries/remove'), async route => {
      const request = route.request().postDataJSON() as typeof requests[number];
      requests.push(request);
      for (const c of request.changes) state.change(c.folder_id, c.after);
      await route.fulfill({ status: 204 });
    });
    await row(page, A, '005930').click();
    await row(page, B, all ? '005930' : '035420').click({ modifiers: ['Shift'] });
    await expect(page.getByTestId('heatmap-selection-actions')).toContainText(all ? '4개 선택' : '3개 선택');
    if (all) await page.getByTestId('heatmap-selection-actions').getByRole('button', { name: '삭제', exact: true }).click();
    else {
      await row(page, B, '035420').focus();
      await page.keyboard.press('Delete');
    }
    const dialog = page.getByRole('dialog', { name: '삭제' });
    await expect(dialog).toContainText(`${all ? 3 : 2}종목은 히트맵에서 빠집니다`);
    expect(requests).toHaveLength(0);
    await dialog.getByRole('button', { name: '삭제', exact: true }).click();
    await expect(row(page, A, '005930')).toHaveCount(0);
    await expect(row(page, B, '035420')).toHaveCount(0);
    if (all) await expect(page.getByRole('button', { name: '새 그룹 만들기', exact: true })).toBeFocused();
    else {
      await expect(row(page, B, '005930')).toBeVisible();
      await expect(row(page, B, '005930')).toBeFocused();
    }
    await expect(page.getByTestId('heatmap-selection-actions')).toHaveCount(0);
    expect(requests).toHaveLength(1);
    expect(state.items()[B]).toEqual(all ? [] : ['005930']);
  });
}

test('삭제 실패는 선택과 원래 목록을 유지하고 다시 시도할 수 있다', async ({ page }) => {
  const state = await setup(page);
  await page.route(apiExact('heatmap/entries/remove'), route => route.fulfill({ status: 409, json: { detail: { message: '목록이 변경되었습니다' } } }));
  await row(page, A, '005930').click();
  await row(page, A, '000660').click({ modifiers: ['Shift'] });
  await page.getByTestId('heatmap-selection-actions').getByRole('button', { name: '삭제', exact: true }).click();
  await page.getByRole('dialog', { name: '삭제' }).getByRole('button', { name: '삭제', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '삭제하지 못했습니다' })).toContainText('목록이 변경되었습니다');
  await expect(row(page, A, '005930')).toHaveAttribute('aria-pressed', 'true');
  await expect(row(page, A, '000660')).toHaveAttribute('aria-pressed', 'true');
  expect(state.items()[A]).toEqual(['005930', '000660']);
});
