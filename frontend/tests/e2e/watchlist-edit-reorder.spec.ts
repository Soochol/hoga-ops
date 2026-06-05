// frontend/tests/e2e/watchlist-edit-reorder.spec.ts
//
// 편집 모달 드래그 정렬 e2e — 구 watchlist-reorder.spec.ts(패널 행 드래그)의 포팅.
// 패널 행 드래그는 v0.5.5.0에서 제거되고 구조 편집이 편집 모달로 일원화됐다:
// 이제 진짜 dnd-kit PointerSensor 드래그(5px activation distance)는 편집 모달의
// ⠿ 핸들에서 일어난다 — jsdom 단위 테스트가 의도적으로 모킹으로 비껴가는 그 층.
// PUT /api/watchlist/reorder mock 은 STATEFUL: invalidate-refetch 가 스냅백하지
// 않고 유지된 순서를 관측한다.

import { test, expect } from '@playwright/test';
import { installLiveMocks } from './helpers/liveMocks';

test.use({ channel: 'chrome' }); // 시스템 Chrome (live-smoke 와 동일 사유)

const API = 'http://localhost:8000';

interface Entry {
  code: string; name: string; registered_at_kst_date: string;
  last_success_date: string | null; folder_id: string | null; order: number;
}
const NAMES: Record<string, string> = {
  '005930': '삼성전자', '000660': 'SK하이닉스', '035720': '카카오',
};
const entriesIn = (codes: string[]): Entry[] =>
  codes.map((code, i) => ({
    code, name: NAMES[code], registered_at_kst_date: '20260527',
    last_success_date: null, folder_id: null, order: i,
  }));

test.describe('Watchlist edit modal drag-reorder', () => {
  test('⠿ drag past 5px reorders, PUTs ordered_codes, and sticks after refetch', async ({ page }) => {
    await installLiveMocks(page);

    let order = ['005930', '000660', '035720'];
    let lastPut: { folder_id: string | null; ordered_codes: string[] } | null = null;
    const json = (route: import('@playwright/test').Route, body: unknown) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

    await page.route(`${API}/api/live/quotes*`, (r) => json(r, { phase: 'open', quotes: [] }));
    // PUT /reorder — 새 순서를 캡처하고 서버 상태를 갱신해 echo.
    await page.route(`${API}/api/watchlist/reorder`, async (route) => {
      lastPut = JSON.parse(route.request().postData() || '{}');
      order = lastPut!.ordered_codes;
      return route.fulfill({ status: 204, body: '' });
    });
    await page.route(`${API}/api/watchlist`, (r) =>
      json(r, { folders: [], entries: entriesIn(order), next_run_at_ms: 0 }));

    await page.goto('/live');
    // 패널 열기(영속 상태로 이미 열려 있으면 생략) → 편집 메뉴 → 관심 편집
    const editMenuBtn = page.getByRole('button', { name: '관심종목 편집 메뉴' });
    if (!(await editMenuBtn.isVisible().catch(() => false))) {
      await page.getByRole('button', { name: /관심종목 패널 토글/ }).click();
    }
    await editMenuBtn.click();
    await page.getByRole('menuitem', { name: '관심 편집' }).click();
    await expect(page.getByRole('dialog', { name: '관심종목 편집' })).toBeVisible();

    const codesInDom = () =>
      page.locator('[data-testid^="edit-row-"]').evaluateAll((els) =>
        els.map((e) => e.getAttribute('data-testid')!.replace('edit-row-', '')));
    expect(await codesInDom()).toEqual(['005930', '000660', '035720']);

    // 첫 행(005930)의 ⠿ 핸들을 셋째 행(035720) 위로 드래그 ⇒ [000660, 035720, 005930].
    const handle = await page.getByTestId('edit-row-005930').locator('.cursor-grab').boundingBox();
    const target = await page.getByTestId('edit-row-035720').boundingBox();
    if (!handle || !target) throw new Error('drag handle/target has no bounding box');
    const fx = handle.x + handle.width / 2;
    const fy = handle.y + handle.height / 2;
    const ty = target.y + target.height / 2;

    await page.mouse.move(fx, fy);
    await page.mouse.down();
    await page.mouse.move(fx, fy + 8, { steps: 4 });   // 5px activation distance 통과
    await page.mouse.move(fx, ty, { steps: 15 });      // 타겟 위로 이동 → closestCenter over
    await page.mouse.move(fx, ty + 2, { steps: 2 });
    await page.mouse.up();

    // PUT 이 기대 순서로 발사되고…
    await expect.poll(() => lastPut?.ordered_codes ?? null).toEqual(['000660', '035720', '005930']);
    expect(lastPut!.folder_id).toBeNull();             // 미분류 내 정렬
    // …낙관적 캐시가 즉시 행을 재배열한다.
    await expect.poll(codesInDom).toEqual(['000660', '035720', '005930']);
  });
});
