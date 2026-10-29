import { test, expect, type Page, type Locator } from '@playwright/test';
import { installLiveMocks } from './helpers/liveMocks';
import { apiExact, apiPrefix } from './helpers/apiRoutes';
import type { StudyViewReference } from '../../src/api/studyViews';
const A = '005930', B = '000660';
const saved = (id: string, code = A): StudyViewReference => ({
  id, schema_version: 2, group_id: code, name: `복기 ${id}`, code, label: code === A ? '삼성전자' : 'SK하이닉스',
  timeframe: '5m', memo: '', tags: [],
  range: { from_date: '20260901', to_date: '20260902', from_ms: Date.parse('2026-09-01T09:00:00+09:00'), to_ms: Date.parse('2026-09-02T10:00:00+09:00') },
  viewport: { right_edge_ms: 2000, bar_span: 10, at_live_edge: false }, created_at_ms: 1, updated_at_ms: 1,
});
const panel = (page: Page) => page.getByRole('complementary', { name: '저장뷰', exact: true });
const row = (page: Page, id: string) => page.getByTestId(`saved-view-item-${id}`);
const surface = (page: Page, id: string) => row(page, id).locator('[data-saved-row]');
const order = (page: Page, code = A) => page.getByTestId(`saved-view-group-${code}`).locator('[data-saved-row]').evaluateAll((nodes) => nodes.map((n) => n.getAttribute('data-saved-row')));
const notice = (page: Page) => panel(page).getByRole('status', { name: '저장뷰 순서 안내' });
async function setup(page: Page, initial = [saved('a'), saved('b'), saved('c'), saved('d', B)]) {
  await installLiveMocks(page);
  let saves = structuredClone(initial);
  const groups = [{ id: A, name: '돌파 복기' }, { id: B, name: '눌림목 복기' }];
  const deleted: string[] = [];
  const failing = new Set<string>();
  await page.route(apiExact('study-views/saves'), (r) => r.fulfill({ json: { schema_version: 2, groups, saves } }));
  await page.route(apiExact('study-views/move'), (r) => {
    const body = r.request().postDataJSON();
    saves = saves.map((s) => body.ids.includes(s.id) ? { ...s, group_id: body.group_id } : s);
    return r.fulfill({ json: { schema_version: 2, groups, saves } });
  });
  await page.route(apiPrefix('study-views/saves/'), (r) => {
    const id = new URL(r.request().url()).pathname.split('/')[4]!;
    if (r.request().method() === 'PATCH') saves = saves.map((s) => s.id === id ? { ...s, ...r.request().postDataJSON() } : s);
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

test('저장뷰 이름과 기간은 한 줄이며 긴 기간도 생략 없이 오른쪽에 정렬한다', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.clock.setFixedTime(new Date('2026-10-29T09:00:00+09:00'));
  const daily: StudyViewReference = { ...saved('a'), name: '돌파 후 거래량이 증가한 긴 저장 이름', timeframe: 'D' };
  const intraday = { ...saved('b'), range: {
    from_date: '20261028', to_date: '20261028',
    from_ms: Date.parse('2026-10-28T09:10:00+09:00'), to_ms: Date.parse('2026-10-28T10:30:00+09:00'),
  } };
  await setup(page, [daily, intraday]);
  const dailyName = surface(page, 'a').getByText('삼성전자', { exact: true });
  const dailyPeriod = surface(page, 'a').getByText('09.01–09.02', { exact: true });
  const minutePeriod = surface(page, 'b').getByText('10.28 09:10–10:30', { exact: true });
  for (const fontSize of [16, 20]) {
    await page.addStyleTag({ content: `:root { font-size: ${fontSize}px !important; } #right-rail-saved-views-panel { width: 280px !important; }` });
    await expect(dailyPeriod).toBeVisible();
    await expect(minutePeriod).toBeVisible();
    await expect.poll(async () => {
      const nameBox = await dailyName.boundingBox();
      const dateBox = await dailyPeriod.boundingBox();
      const minuteBox = await minutePeriod.boundingBox();
      return Math.max(Math.abs(nameBox!.y - dateBox!.y), Math.abs(dateBox!.x + dateBox!.width - minuteBox!.x - minuteBox!.width));
    }).toBeLessThan(1);
    for (const period of [dailyPeriod, minutePeriod]) {
      expect(await period.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
      await expect(period).toHaveCSS('white-space', 'nowrap');
    }
    expect(await dailyName.evaluate(node => {
      const title = node.parentElement!;
      return title.scrollWidth > title.clientWidth && getComputedStyle(title).textOverflow === 'ellipsis';
    })).toBe(true);
    const firstHeight = (await surface(page, 'a').boundingBox())!.height;
    const secondHeight = (await surface(page, 'b').boundingBox())!.height;
    expect(firstHeight).toBeCloseTo(secondHeight, 1);
    await expect(panel(page)).not.toContainText('분봉');
    await panel(page).screenshot({ path: `/tmp/hoga-saved-view-single-line-${fontSize}.png` });
  }
});

test('검색은 접힌 결과를 임시로 펼치며 이름 정렬은 수동 정렬로 전환할 수 있다', async ({ page }) => {
  await setup(page);
  await page.getByRole('button', { name: '돌파 복기 접기' }).click();
  await page.getByRole('textbox', { name: '저장뷰 검색' }).fill('복기 b');
  await expect(row(page, 'b')).toBeVisible();
  await expect(row(page, 'a')).toHaveCount(0);
  await expect(surface(page, 'b')).not.toHaveAttribute('data-draggable');
  await expect(notice(page)).toContainText('검색 중에는');
  await page.getByRole('button', { name: '검색어 지우기' }).click();
  await expect(row(page, 'b')).toHaveCount(0);
  await page.getByRole('button', { name: '돌파 복기 펼치기' }).click();
  await page.getByRole('button', { name: '이름 오름차순 정렬' }).click();
  await expect(surface(page, 'a')).not.toHaveAttribute('data-draggable');
  await expect(notice(page)).toContainText('이름 정렬 중에는');
  await page.getByRole('button', { name: '수동 정렬', exact: true }).click();
  await expect(surface(page, 'a')).toHaveAttribute('data-draggable');
});

test('행 위아래 정확한 삽입과 기간 안내, 되돌리기 및 새로고침 후 순서 보존', async ({ page }) => {
  await setup(page);
  await start(page, surface(page, 'a'));
  await over(page, row(page, 'b'), .8);
  await expect(notice(page)).toContainText('삼성전자 · 복기 b (09.01–09.02) 아래로 이동');
  // Assert the insertion destination before releasing the pointer.
  await page.mouse.up();
  await expect.poll(() => order(page)).toEqual(['b', 'a', 'c']);
  await page.getByRole('button', { name: '순서 되돌리기' }).click({ delay: 80 });
  await expect.poll(() => order(page)).toEqual(['a', 'b', 'c']);
  await move(page, surface(page, 'c'), row(page, 'b'), .2);
  await expect.poll(() => order(page)).toEqual(['a', 'c', 'b']);
  await page.reload();
  await expect.poll(() => order(page)).toEqual(['a', 'c', 'b']);
});

test('다른 그룹으로 이동하고 패널 밖 드롭은 취소한다', async ({ page }) => {
  await setup(page);
  await move(page, surface(page, 'a'), row(page, 'd'), .8);
  await expect.poll(() => order(page)).toEqual(['b', 'c']);
  await expect.poll(() => order(page, B)).toEqual(['d', 'a']);
  await start(page, surface(page, 'b'));
  await page.mouse.move(20, 20, { steps: 10 }); await page.mouse.up();
  expect(await order(page)).toEqual(['b', 'c']);
  await move(page, panel(page).locator('[data-panel-drag-label]').filter({ hasText: '돌파 복기' }), page.getByTestId(`saved-view-group-${B}`), .8);
  await expect.poll(() => panel(page).locator('section[aria-label]').evaluateAll((nodes) => nodes.map((n) => n.getAttribute('aria-label')))).toEqual(['눌림목 복기 저장뷰', '돌파 복기 저장뷰']);
  await expect(page.getByRole('button', { name: '돌파 복기 접기' })).toBeVisible();
});

test('다중 선택 묶음 순서를 유지하고 여러 그룹의 항목도 함께 이동한다', async ({ page }) => {
  await setup(page, [saved('a'), saved('b'), saved('c'), saved('e'), saved('d', B)]);
  await surface(page, 'a').click({ modifiers: ['Alt'] });
  await surface(page, 'c').click({ modifiers: ['Alt'] });
  await start(page, surface(page, 'a'));
  await expect(page.getByTestId('saved-view-drag-ghost')).toContainText('2개 저장뷰');
  await over(page, row(page, 'e'), .8); await page.mouse.up();
  await expect.poll(() => order(page)).toEqual(['b', 'e', 'a', 'c']);
  // A real press/release outlasts dnd-kit's trailing-click suppression after a drop.
  await surface(page, 'd').click({ delay: 80, modifiers: ['Alt'] });
  await expect(panel(page).getByRole('status').filter({ hasText: '3개 선택' })).toBeVisible();
  await start(page, surface(page, 'a'));
  await over(page, row(page, 'b'), .2);
  await expect(notice(page)).toContainText('위로 이동');
  await page.mouse.up();
  await expect.poll(() => order(page)).toEqual(['a', 'c', 'd', 'b', 'e']);
  await expect.poll(() => order(page, B)).toEqual([]);
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

test('연속 삭제는 각각 취소할 수 있고 Delete는 검색 입력과 그룹 버튼을 무시한다', async ({ page }) => {
  const state = await setup(page);
  await page.getByRole('textbox', { name: '저장뷰 검색' }).press('Delete');
  await page.getByRole('button', { name: '돌파 복기 접기' }).focus();
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
  await surface(page, 'a').click({ modifiers: ['Alt'] });
  await surface(page, 'b').click({ modifiers: ['Alt'] });
  await panel(page).getByTestId('saved-view-selection-actions').getByRole('button', { name: '삭제', exact: true }).click();
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
  await start(page, surface(page, 'a'));
  const edge = await point(scroll, .98);
  await page.mouse.move(edge.x, edge.y);
  await expect(page.getByRole('status').filter({ hasText: '아래로 스크롤' })).toBeVisible();
  await expect.poll(() => scroll.evaluate((el) => el.scrollTop)).toBeGreaterThan(100);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('saved-view-drag-ghost')).toHaveCount(0);
  expect((await order(page))[0]).toBe('a');
  await scroll.evaluate((el) => { el.scrollTop = 0; });
  await start(page, surface(page, 'a'));
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

test('클릭은 즉시 열고 Shift 범위 선택·Alt 개별 선택은 차트를 유지한다', async ({ page }, testInfo) => {
  await setup(page);
  await expect(panel(page).getByRole('button', { name: '다중 선택' })).toHaveCount(0);
  await expect(notice(page)).toHaveCount(0);
  await surface(page, 'a').click();
  await expect(surface(page, 'a')).toHaveAttribute('aria-current', 'true');
  await surface(page, 'd').click({ modifiers: ['Shift'] });
  const actions = panel(page).getByTestId('saved-view-selection-actions');
  await expect(actions).toContainText('4개 선택');
  await expect(surface(page, 'd')).not.toHaveAttribute('aria-current');
  await surface(page, 'b').click({ modifiers: ['Alt'] });
  await expect(actions).toContainText('3개 선택');
  await surface(page, 'd').press('Shift+F10');
  const menu = page.getByRole('menu', { name: '3개 저장뷰 선택' });
  await expect(menu.getByRole('menuitem', { name: '그룹 이동' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(surface(page, 'd')).toBeFocused();
  await expect(actions).toContainText('3개 선택');
  await surface(page, 'd').press('Escape');
  await expect(actions).toHaveCount(0);
  await expect(surface(page, 'a')).toHaveAttribute('aria-current', 'true');
  await surface(page, 'b').focus();
  await surface(page, 'b').press('Shift+ArrowDown');
  await expect(surface(page, 'c')).toBeFocused();
  await expect(actions).toContainText('2개 선택');
  await page.screenshot({ path: testInfo.outputPath('saved-views-selection.png') });
});

test('행·그룹 키보드 메뉴와 이름 변경은 차트를 열지 않고 입력은 드래그하지 않는다', async ({ page }, testInfo) => {
  await setup(page);
  const header = panel(page).getByRole('group', { name: '돌파 복기 그룹' });
  await header.focus();
  await header.press('Shift+F10');
  const groupMenu = page.getByRole('menu', { name: '돌파 복기 그룹 메뉴' });
  await expect(groupMenu.getByRole('menuitem', { name: '이름 변경' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(header).toBeFocused();
  await surface(page, 'a').focus();
  await surface(page, 'a').press('Shift+F10');
  const menu = page.getByRole('menu', { name: '복기 a 저장뷰 메뉴' });
  await expect(menu.getByRole('menuitem', { name: '열기', exact: true })).toBeFocused();
  await menu.getByRole('menuitem', { name: '이름 변경' }).click();
  const input = panel(page).getByRole('textbox', { name: '저장뷰 이름 수정' });
  await expect(input).toBeFocused();
  await expect(input).toHaveValue('복기 a');
  const p = await point(input);
  await page.mouse.move(p.x, p.y); await page.mouse.down();
  await page.mouse.move(p.x + 25, p.y); await page.mouse.up();
  await expect(page.getByTestId('saved-view-drag-ghost')).toHaveCount(0);
  await input.fill('돌파 확인');
  await input.press('Enter');
  await expect(panel(page).getByRole('button', { name: '돌파 확인 저장뷰 열기' })).toBeVisible();
  await expect(surface(page, 'a')).not.toHaveAttribute('aria-current');
  await page.screenshot({ path: testInfo.outputPath('saved-views-compact.png') });
});
