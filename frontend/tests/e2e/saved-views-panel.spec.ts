import { test, expect, type Page, type Locator } from '@playwright/test';
import { installLiveMocks } from './helpers/liveMocks';
import { apiExact, apiPrefix } from './helpers/apiRoutes';
import type { StudyViewReference } from '../../src/api/studyViews';
const A = '005930', B = '000660';
const saved = (id: string, code = A): StudyViewReference => ({
  id, schema_version: 2, name: `복기 ${id}`, code, label: code === A ? '삼성전자' : 'SK하이닉스',
  timeframe: '5m', memo: '', tags: [],
  range: { from_date: '20260901', to_date: '20260902', from_ms: 1000, to_ms: 2000 },
  viewport: { right_edge_ms: 2000, bar_span: 10, at_live_edge: false }, created_at_ms: 1, updated_at_ms: 1,
});
const panel = (page: Page) => page.getByRole('complementary', { name: '저장뷰', exact: true });
const row = (page: Page, id: string) => page.getByTestId(`saved-view-item-${id}`);
const handle = (page: Page, id: string) => row(page, id).getByRole('button', { name: `복기 ${id} 순서 이동`, exact: true });
const order = (page: Page, code = A) => page.getByTestId(`saved-view-group-${code}`).locator('[data-saved-row]').evaluateAll((nodes) => nodes.map((n) => n.getAttribute('data-saved-row')));
const notice = (page: Page) => panel(page).getByRole('status', { name: '저장뷰 순서 안내' });
async function setup(page: Page, initial = [saved('a'), saved('b'), saved('c'), saved('d', B)]) {
  await installLiveMocks(page);
  let saves = structuredClone(initial);
  const deleted: string[] = [];
  const failing = new Set<string>();
  await page.route(apiExact('study-views/saves'), (r) => r.fulfill({ json: { schema_version: 2, saves } }));
  await page.route(apiPrefix('study-views/saves/'), (r) => {
    const id = new URL(r.request().url()).pathname.split('/').at(-1)!;
    if (r.request().method() !== 'DELETE') return r.fulfill({ json: saves.find((s) => s.id === id) });
    deleted.push(id);
    if (failing.has(id)) return r.fulfill({ status: 500, json: { detail: '일시적 오류' } });
    saves = saves.filter((s) => s.id !== id);
    return r.fulfill({ status: 204, body: '' });
  });
  await page.goto('/live');
  await page.getByRole('button', { name: '저장뷰 패널 토글' }).click();
  await expect(panel(page)).toBeVisible();
  await expect(row(page, 'a')).toBeVisible();
  return { deleted, failing };
}
async function point(locator: Locator, fraction = .5) {
  const box = await locator.boundingBox();
  if (!box) throw new Error('Missing drag surface');
  return { x: box.x + box.width / 2, y: box.y + box.height * fraction };
}
async function start(page: Page, source: Locator) {
  await source.hover();
  const p = await point(source);
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  await page.mouse.move(p.x + 7, p.y, { steps: 3 });
  await expect(page.getByTestId('saved-view-drag-ghost')).toBeVisible();
}
async function over(page: Page, target: Locator, fraction: number) {
  const p = await point(target, fraction);
  await page.mouse.move(p.x, p.y, { steps: 12 });
}
async function move(page: Page, source: Locator, target: Locator, fraction: number) {
  await start(page, source); await over(page, target, fraction); await page.mouse.up();
  await expect(page.getByTestId('saved-view-drag-ghost')).toHaveCount(0);
}

test('검색은 접힌 결과를 임시로 펼치며 이름 정렬은 수동 정렬로 전환할 수 있다', async ({ page }) => {
  await setup(page);
  await page.getByRole('button', { name: '삼성전자 005930 접기' }).click();
  await page.getByRole('textbox', { name: '저장뷰 검색' }).fill('복기 b');
  await expect(row(page, 'b')).toBeVisible();
  await expect(row(page, 'a')).toHaveCount(0);
  await expect(handle(page, 'b')).toBeDisabled();
  await expect(notice(page)).toContainText('검색 중에는');
  await page.getByRole('button', { name: '검색어 지우기' }).click();
  await expect(row(page, 'b')).toHaveCount(0);
  await page.getByRole('button', { name: '삼성전자 005930 펼치기' }).click();
  await page.getByRole('button', { name: '이름 오름차순 정렬' }).click();
  await expect(handle(page, 'a')).toBeDisabled();
  await expect(notice(page)).toContainText('이름 정렬 중에는');
  await page.getByRole('button', { name: '수동 정렬', exact: true }).click();
  await expect(handle(page, 'a')).toBeEnabled();
});

test('행 위아래 정확한 삽입과 기간 안내, 되돌리기 및 새로고침 후 순서 보존', async ({ page }) => {
  await setup(page);
  await start(page, handle(page, 'a'));
  await over(page, row(page, 'b'), .8);
  await expect(notice(page)).toContainText('삼성전자 · 복기 b (5m · 2026-09-01~09-02) 아래로 이동');
  await page.screenshot({ path: '/tmp/hoga-saved-view-drag.png' });
  await page.mouse.up();
  await expect.poll(() => order(page)).toEqual(['b', 'a', 'c']);
  await page.getByRole('button', { name: '순서 되돌리기' }).click({ delay: 80 });
  await expect.poll(() => order(page)).toEqual(['a', 'b', 'c']);
  await move(page, handle(page, 'c'), row(page, 'b'), .2);
  await expect.poll(() => order(page)).toEqual(['a', 'c', 'b']);
  await page.reload();
  await expect.poll(() => order(page)).toEqual(['a', 'c', 'b']);
});

test('전용 그룹 핸들로 재정렬하며 행을 다른 종목이나 패널 밖에 놓으면 취소한다', async ({ page }) => {
  await setup(page);
  await move(page, handle(page, 'a'), row(page, 'd'), .8);
  expect(await order(page)).toEqual(['a', 'b', 'c']);
  await start(page, handle(page, 'a'));
  await page.mouse.move(20, 20, { steps: 10 }); await page.mouse.up();
  expect(await order(page)).toEqual(['a', 'b', 'c']);
  await move(page, page.getByRole('button', { name: '삼성전자 그룹 이동', exact: true }), page.getByTestId(`saved-view-group-${B}`), .8);
  await expect.poll(() => panel(page).locator('section[aria-label]').evaluateAll((nodes) => nodes.map((n) => n.getAttribute('aria-label')))).toEqual(['SK하이닉스 000660 저장뷰', '삼성전자 005930 저장뷰']);
  await expect(page.getByRole('button', { name: '삼성전자 005930 접기' })).toBeVisible();
});

test('다중 선택 묶음 순서를 유지하고 여러 종목 선택은 재정렬을 제한한다', async ({ page }) => {
  await setup(page, [saved('a'), saved('b'), saved('c'), saved('e'), saved('d', B)]);
  await page.getByRole('button', { name: '여러 저장뷰 선택' }).click();
  await page.getByRole('checkbox', { name: '복기 a 선택', exact: true }).check();
  await page.getByRole('checkbox', { name: '복기 c 선택', exact: true }).check();
  await start(page, handle(page, 'a'));
  await expect(page.getByTestId('saved-view-drag-ghost')).toContainText('2개 저장뷰');
  await over(page, row(page, 'e'), .8); await page.mouse.up();
  await expect.poll(() => order(page)).toEqual(['b', 'e', 'a', 'c']);
  // A real press/release outlasts dnd-kit's trailing-click suppression after a drop.
  await page.getByRole('checkbox', { name: '복기 d 선택', exact: true }).click({ delay: 80 });
  await expect(page.getByRole('button', { name: '선택 종료' })).toHaveText('선택 3');
  await start(page, handle(page, 'a'));
  await over(page, row(page, 'b'), .2);
  await expect(notice(page)).toContainText('같은 종목 안에서만');
  await page.mouse.up();
  expect(await order(page)).toEqual(['b', 'e', 'a', 'c']);
});

test('Delete 후 다음 행에 포커스하며 패널을 닫아도 실행 취소할 수 있다', async ({ page }) => {
  const state = await setup(page);
  const open = row(page, 'a').getByRole('button', { name: '복기 a 저장뷰 열기', exact: true });
  await open.focus(); await page.keyboard.press('Backspace');
  await expect(row(page, 'a')).toBeVisible();
  await page.keyboard.press('Delete');
  await expect(row(page, 'a')).toHaveCount(0);
  await expect(row(page, 'b').getByRole('button', { name: '복기 b 저장뷰 열기', exact: true })).toBeFocused();
  await page.getByRole('button', { name: '저장뷰 패널 토글' }).click();
  await expect(panel(page)).toHaveCount(0);
  await page.getByRole('status', { name: '저장뷰 삭제 안내' }).getByRole('button', { name: '실행 취소' }).click();
  await page.getByRole('button', { name: '저장뷰 패널 토글' }).click();
  await expect(row(page, 'a')).toBeVisible();
  expect(state.deleted).toEqual([]);
});

test('연속 삭제는 각각 취소할 수 있고 Delete는 검색 입력과 메뉴 버튼을 무시한다', async ({ page }) => {
  const state = await setup(page);
  await page.getByRole('textbox', { name: '저장뷰 검색' }).press('Delete');
  await row(page, 'a').getByRole('button', { name: '복기 a 행 메뉴' }).focus();
  await page.keyboard.press('Delete');
  await expect(row(page, 'a')).toBeVisible();
  await row(page, 'a').getByRole('button', { name: '복기 a 저장뷰 열기', exact: true }).focus();
  await page.keyboard.press('Delete'); await page.keyboard.press('Delete');
  await expect(page.getByRole('button', { name: '실행 취소' })).toHaveCount(2);
  await page.getByRole('status', { name: '저장뷰 삭제 안내' }).filter({ hasText: '복기 b' }).getByRole('button', { name: '실행 취소' }).click();
  await expect.poll(() => state.deleted, { timeout: 10000 }).toEqual(['a']);
  await expect(row(page, 'a')).toHaveCount(0);
  await expect(row(page, 'b')).toBeVisible();
});

test('일괄 삭제 일부 실패를 안내하고 실패한 저장뷰만 재시도한다', async ({ page }) => {
  const state = await setup(page);
  state.failing.add('b');
  await page.getByRole('button', { name: '여러 저장뷰 선택' }).click();
  await page.getByRole('checkbox', { name: '복기 a 선택', exact: true }).check();
  await page.getByRole('checkbox', { name: '복기 b 선택', exact: true }).check();
  await page.getByRole('button', { name: '선택 삭제', exact: true }).click();
  await expect(page.getByRole('status', { name: '저장뷰 삭제 안내' })).toContainText('1개 삭제 완료 · 1개 삭제 실패', { timeout: 10000 });
  await expect(row(page, 'a')).toHaveCount(0);
  await expect(row(page, 'b')).toBeVisible();
  state.failing.clear();
  await page.getByRole('button', { name: '실패 항목 다시 시도' }).click();
  await expect.poll(() => state.deleted, { timeout: 10000 }).toEqual(['a', 'b', 'b']);
  await expect(row(page, 'b')).toHaveCount(0);
});

test('가장자리 자동 스크롤 중에도 목적지에 삽입하고 Escape는 취소한다', async ({ page }) => {
  await setup(page, [saved('a'), ...Array.from({ length: 45 }, (_, i) => saved(`v${i}`)), saved('d', B)]);
  const scroll = page.getByTestId('saved-views-scroll');
  await start(page, handle(page, 'a'));
  const edge = await point(scroll, .98);
  await page.mouse.move(edge.x, edge.y);
  await expect(page.getByRole('status').filter({ hasText: '아래로 스크롤' })).toBeVisible();
  await expect.poll(() => scroll.evaluate((el) => el.scrollTop)).toBeGreaterThan(100);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('saved-view-drag-ghost')).toHaveCount(0);
  expect((await order(page))[0]).toBe('a');
  await scroll.evaluate((el) => { el.scrollTop = 0; });
  await start(page, handle(page, 'a'));
  await page.mouse.move(edge.x, edge.y);
  await expect.poll(() => scroll.evaluate((el) => el.scrollTop)).toBeGreaterThan(200);
  // Leave the edge to stop scrolling, then choose a currently visible row.
  const middle = await point(scroll, .5);
  await page.mouse.move(middle.x, middle.y);
  const targetId = await scroll.evaluate((el) => {
    const bounds = el.getBoundingClientRect();
    return [...el.querySelectorAll<HTMLElement>('[data-saved-row]')].find((n) => {
      const r = n.getBoundingClientRect(); return r.top > bounds.top + 100 && r.bottom < bounds.bottom - 100;
    })?.dataset.savedRow;
  });
  expect(targetId).toBeTruthy();
  await over(page, row(page, targetId!), .8);
  await page.mouse.up();
  await expect.poll(async () => {
    const ids = await order(page); return ids.indexOf('a') - ids.indexOf(targetId!);
  }).toBe(1);
});

test('연속 삭제 안내는 화면 안에서 스크롤하며 최신 요청을 바로 취소할 수 있다', async ({ page }) => {
  await setup(page, [saved('a'), ...Array.from({ length: 15 }, (_, i) => saved(`q${i}`))]);
  await page.clock.install();
  await page.clock.pauseAt(new Date(Date.now() + 1000));
  await row(page, 'a').getByRole('button', { name: '복기 a 저장뷰 열기', exact: true }).focus();
  for (let i = 0; i < 12; i++) await page.keyboard.press('Delete');
  const list = page.getByRole('region', { name: '저장뷰 삭제 알림 목록' });
  await expect(list.getByRole('status')).toHaveCount(12);
  const bounds = await list.boundingBox();
  expect(bounds!.y).toBeGreaterThanOrEqual(0);
  expect(bounds!.height).toBeLessThanOrEqual(page.viewportSize()!.height / 2);
  expect(await list.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  const newest = list.getByRole('status').first();
  await expect(newest).toContainText('복기 q10');
  await newest.getByRole('button', { name: '실행 취소' }).click();
  await expect(row(page, 'q10')).toBeVisible();
  await expect(list.getByRole('status')).toHaveCount(11);
});
