// frontend/tests/e2e/watchlist-context-menu.spec.ts
//
// 실 dnd-kit 없는 우클릭 컨텍스트 메뉴 e2e: 행 우클릭 → 네이티브 메뉴 억제 →
// WatchlistRowMenu 렌더 → '관심 해제' 클릭 → DELETE /api/watchlist/{code} →
// 행 사라짐, 그리고 '그룹으로 이동' → POST /api/watchlist/move → 행이 대상
// 그룹으로 이동. 백엔드 독립(page.route mock), GET 은 stateful(삭제/이동 반영).

import { test, expect } from '@playwright/test';
import { installLiveMocks } from './helpers/liveMocks';

test.use({ channel: 'chrome' }); // 시스템 Chrome (live-smoke 와 동일 사유)

const API = 'http://localhost:8000';

interface Entry {
  code: string; name: string; registered_at_kst_date: string;
  last_success_date: string | null; folder_id: string | null; order: number;
}
const FOLDERS = [{ id: 'f_a', name: '스윙', order: 0 }];
const makeEntries = (): Entry[] => [
  { code: '005930', name: '삼성전자', registered_at_kst_date: '20260527', last_success_date: null, folder_id: null, order: 0 },
  { code: '000660', name: 'SK하이닉스', registered_at_kst_date: '20260527', last_success_date: null, folder_id: null, order: 1 },
];

const json = (route: import('@playwright/test').Route, body: unknown) =>
  route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

const openPanelIfClosed = async (page: import('@playwright/test').Page, testId: string) => {
  const row = page.getByTestId(testId);
  if (!(await row.isVisible().catch(() => false))) {
    await page.getByRole('button', { name: /관심종목 패널 토글/ }).click();
  }
  await expect(row).toBeVisible();
};

test.describe('Watchlist Panel context menu', () => {
  test('right-click → 관심 해제 deletes via DELETE and the row disappears', async ({ page }) => {
    await installLiveMocks(page);

    let entries = makeEntries();
    let deleted: string | null = null;

    await page.route(`${API}/api/live/quotes*`, (r) => json(r, { phase: 'open', quotes: [] }));
    // DELETE /api/watchlist/{code} → 204, stateful 제거. {code} 경로라 GET 보다 먼저 등록.
    await page.route(`${API}/api/watchlist/*`, async (route) => {
      if (route.request().method() === 'DELETE') {
        const code = route.request().url().split('/').pop()!;
        deleted = code;
        entries = entries.filter((e) => e.code !== code);
        return route.fulfill({ status: 204, body: '' });
      }
      return route.fallback();
    });
    await page.route(`${API}/api/watchlist`, (r) =>
      json(r, { folders: FOLDERS, entries, next_run_at_ms: 0 }));

    await page.goto('/live');
    await openPanelIfClosed(page, 'watchlist-row-005930');

    await page.getByTestId('watchlist-row-005930').click({ button: 'right' });  // 우클릭
    const menu = page.getByTestId('watchlist-row-menu');
    await expect(menu).toBeVisible();
    await page.getByTestId('watchlist-menu-remove').click();       // 관심 해제

    await expect.poll(() => deleted).toBe('005930');               // DELETE 발사
    await expect(page.getByTestId('watchlist-row-005930')).toHaveCount(0); // refetch 후 행 사라짐
    await expect(menu).toHaveCount(0);                             // 메뉴 닫힘
  });

  test('right-click → 그룹으로 이동 moves the row into the folder group', async ({ page }) => {
    await installLiveMocks(page);

    let entries = makeEntries();
    let movedTo: string | null | undefined;

    await page.route(`${API}/api/live/quotes*`, (r) => json(r, { phase: 'open', quotes: [] }));
    // POST /move — stateful: folder_id 갱신 후 GET 이 새 소속을 반영한다.
    await page.route(`${API}/api/watchlist/move`, async (route) => {
      const body = JSON.parse(route.request().postData() || '{}') as
        { codes: string[]; folder_id: string | null };
      movedTo = body.folder_id;
      entries = entries.map((e) =>
        body.codes.includes(e.code) ? { ...e, folder_id: body.folder_id } : e);
      return route.fulfill({ status: 204, body: '' });
    });
    await page.route(`${API}/api/watchlist`, (r) =>
      json(r, { folders: FOLDERS, entries, next_run_at_ms: 0 }));

    await page.goto('/live');
    await openPanelIfClosed(page, 'watchlist-row-000660');

    await page.getByTestId('watchlist-row-000660').click({ button: 'right' });
    await expect(page.getByTestId('watchlist-row-menu')).toBeVisible();
    await page.getByTestId('watchlist-menu-move-f_a').click();     // 스윙으로 이동

    await expect.poll(() => movedTo).toBe('f_a');                  // POST /move 발사
    // refetch 후 000660 이 스윙 그룹(첫 그룹) 아래로 — DOM 행 순서가 뒤집힌다.
    await expect.poll(() =>
      page.locator('[data-testid^="watchlist-row-"]').evaluateAll((els) =>
        els.map((e) => e.getAttribute('data-testid')!.replace('watchlist-row-', ''))),
    ).toEqual(['000660', '005930']);
  });
});
