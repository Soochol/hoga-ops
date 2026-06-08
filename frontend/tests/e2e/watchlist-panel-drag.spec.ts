// 관심종목 패널 실 포인터 드래그 e2e — 행(그룹 내 재정렬) + 그룹(폴더 재정렬).
// 단위/통합(jsdom)이 의도적으로 모킹으로 비껴가는 실제 dnd-kit PointerSensor(5px
// activation) + closestCenter 층을 시스템 Chrome에서 구동한다. GET /api/watchlist mock은
// STATEFUL — PUT이 갱신한 순서를 echo해 invalidate-refetch가 스냅백하지 않는다.

import { test, expect } from '@playwright/test';
import { installLiveMocks } from './helpers/liveMocks';

test.use({ channel: 'chrome' });

const API = 'http://localhost:8000';

interface Entry {
  code: string; name: string; registered_at_kst_date: string;
  last_success_date: string | null; folder_id: string | null; order: number;
}
const NAMES: Record<string, string> = { '005930': '삼성전자', '000660': 'SK하이닉스' };

const json = (route: import('@playwright/test').Route, body: unknown) =>
  route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

async function openPanel(page: import('@playwright/test').Page) {
  await page.goto('/live');
  const editMenuBtn = page.getByRole('button', { name: '관심종목 편집 메뉴' });
  if (!(await editMenuBtn.isVisible().catch(() => false))) {
    await page.getByRole('button', { name: /관심종목 패널 토글/ }).click();
  }
  await expect(editMenuBtn).toBeVisible();
}

test.describe('Watchlist panel drag', () => {
  test('그룹 내 행 드래그가 reorder를 PUT하고 낙관적으로 재배치된다', async ({ page }) => {
    await installLiveMocks(page);
    // 스윙(f_a)에 005930, 000660 — 그룹 내 2행.
    let order = ['005930', '000660'];
    let lastPut: { folder_id: string | null; ordered_codes: string[] } | null = null;
    const entries = (): Entry[] => [
      ...order.map((code, i) => ({
        code, name: NAMES[code], registered_at_kst_date: '20260527',
        last_success_date: null, folder_id: 'f_a', order: i,
      })),
    ];
    await page.route(`${API}/api/live/quotes*`, (r) => json(r, { phase: 'open', quotes: [] }));
    await page.route(`${API}/api/watchlist/reorder`, async (route) => {
      lastPut = JSON.parse(route.request().postData() || '{}');
      order = lastPut!.ordered_codes;
      return route.fulfill({ status: 204, body: '' });
    });
    await page.route(`${API}/api/watchlist`, (r) =>
      json(r, { folders: [{ id: 'f_a', name: '스윙', order: 0 }], entries: entries(), next_run_at_ms: 0 }));

    await openPanel(page);
    const codesInDom = () =>
      page.locator('[data-testid^="watchlist-row-"]').evaluateAll((els) =>
        els.map((e) => e.getAttribute('data-testid')!.replace('watchlist-row-', '')));
    await expect.poll(codesInDom).toEqual(['005930', '000660']);

    // 첫 행(005930)을 둘째 행(000660) 위로 — 행 전체가 드래그 표면(핸들 없음).
    const from = await page.getByTestId('watchlist-row-005930').boundingBox();
    const to = await page.getByTestId('watchlist-row-000660').boundingBox();
    if (!from || !to) throw new Error('row has no bounding box');
    const fx = from.x + from.width / 2;
    const fy = from.y + from.height / 2;
    const ty = to.y + to.height / 2;
    await page.mouse.move(fx, fy);
    await page.mouse.down();
    await page.mouse.move(fx, fy + 8, { steps: 4 });   // 5px activation 통과
    await page.mouse.move(fx, ty, { steps: 15 });
    await page.mouse.move(fx, ty + 2, { steps: 2 });
    await page.mouse.up();

    await expect.poll(() => lastPut?.ordered_codes ?? null).toEqual(['000660', '005930']);
    expect(lastPut!.folder_id).toBe('f_a');
    await expect.poll(codesInDom).toEqual(['000660', '005930']);
  });

  test('그룹 헤더 ⠿ 드래그가 folders/order를 PUT하고 그룹을 재배치한다', async ({ page }) => {
    await installLiveMocks(page);
    let folderOrder = ['f_a', 'f_b'];
    const FNAMES: Record<string, string> = { f_a: '스윙', f_b: '장기' };
    let lastPut: { ordered_ids: string[] } | null = null;
    const folders = () => folderOrder.map((id, i) => ({ id, name: FNAMES[id], order: i }));
    const entries: Entry[] = [
      { code: '005930', name: '삼성전자', registered_at_kst_date: '20260527', last_success_date: null, folder_id: 'f_a', order: 0 },
      { code: '000660', name: 'SK하이닉스', registered_at_kst_date: '20260527', last_success_date: null, folder_id: 'f_b', order: 0 },
    ];
    await page.route(`${API}/api/live/quotes*`, (r) => json(r, { phase: 'open', quotes: [] }));
    await page.route(`${API}/api/watchlist/folders/order`, async (route) => {
      lastPut = JSON.parse(route.request().postData() || '{}');
      folderOrder = lastPut!.ordered_ids;
      return route.fulfill({ status: 204, body: '' });
    });
    await page.route(`${API}/api/watchlist`, (r) =>
      json(r, { folders: folders(), entries, next_run_at_ms: 0 }));

    await openPanel(page);
    const groupsInDom = () =>
      page.locator('[data-testid^="watchlist-group-"]').evaluateAll((els) =>
        els.map((e) => e.getAttribute('data-testid')!.replace('watchlist-group-', '')));
    await expect.poll(groupsInDom).toEqual(['f_a', 'f_b']);

    // 스윙(f_a) 그룹 핸들을 장기(f_b) 그룹 위로 드래그.
    const handle = await page.getByTestId('watchlist-group-f_a').getByTestId('group-drag-handle').boundingBox();
    const target = await page.getByTestId('watchlist-group-f_b').boundingBox();
    if (!handle || !target) throw new Error('handle/target has no bounding box');
    const fx = handle.x + handle.width / 2;
    const fy = handle.y + handle.height / 2;
    const ty = target.y + target.height / 2;
    await page.mouse.move(fx, fy);
    await page.mouse.down();
    await page.mouse.move(fx, fy + 8, { steps: 4 });
    await page.mouse.move(fx, ty, { steps: 15 });
    await page.mouse.move(fx, ty + 2, { steps: 2 });
    await page.mouse.up();

    await expect.poll(() => lastPut?.ordered_ids ?? null).toEqual(['f_b', 'f_a']);
    await expect.poll(groupsInDom).toEqual(['f_b', 'f_a']);
  });
});
