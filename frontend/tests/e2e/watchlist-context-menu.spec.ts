// frontend/tests/e2e/watchlist-context-menu.spec.ts
//
// 실 dnd-kit 없는 우클릭 컨텍스트 메뉴 e2e: 행 우클릭 → 네이티브 메뉴 억제 →
// WatchlistRowMenu 렌더 → '관심 해제' 클릭 → DELETE /api/watchlist/{code} →
// 행 사라짐. 백엔드 독립(page.route mock), GET 은 stateful(삭제 반영).

import { test, expect } from '@playwright/test';
import { installLiveMocks } from './helpers/liveMocks';

test.use({ channel: 'chrome' }); // 시스템 Chrome (live-smoke 와 동일 사유)

const API = 'http://localhost:8000';

interface Entry { code: string; name: string; registered_at_kst_date: string; last_success_date: string | null }
const ENTRIES: Entry[] = [
  { code: '005930', name: '삼성전자', registered_at_kst_date: '20260527', last_success_date: null },
  { code: '000660', name: 'SK하이닉스', registered_at_kst_date: '20260527', last_success_date: null },
];

test.describe('Watchlist Panel context menu', () => {
  test('right-click → 관심 해제 deletes via DELETE and the row disappears', async ({ page }) => {
    await installLiveMocks(page);

    let codes = ENTRIES.map((e) => e.code);
    let deleted: string | null = null;
    const entriesIn = (cs: string[]) => cs.map((c) => ENTRIES.find((e) => e.code === c)!);
    const json = (route: import('@playwright/test').Route, body: unknown) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

    await page.route(`${API}/api/live/quotes*`, (r) => json(r, { phase: 'open', quotes: [] }));
    // DELETE /api/watchlist/{code} → 204, stateful 제거. {code} 경로라 GET 보다 먼저 등록.
    await page.route(`${API}/api/watchlist/*`, async (route) => {
      if (route.request().method() === 'DELETE') {
        const code = route.request().url().split('/').pop()!;
        deleted = code;
        codes = codes.filter((c) => c !== code);
        return route.fulfill({ status: 204, body: '' });
      }
      return route.fallback();
    });
    await page.route(`${API}/api/watchlist`, (r) => json(r, { entries: entriesIn(codes), next_run_at_ms: 0 }));

    await page.goto('/live');
    // 관심종목 패널 열기(영속 상태로 이미 열려 있으면 토글 생략)
    const row = page.getByTestId('watchlist-row-005930');
    if (!(await row.isVisible().catch(() => false))) {
      await page.getByRole('button', { name: /관심종목 패널 토글/ }).click();
    }
    await expect(row).toBeVisible();

    await row.click({ button: 'right' });                          // 우클릭
    const menu = page.getByTestId('watchlist-row-menu');
    await expect(menu).toBeVisible();
    await page.getByTestId('watchlist-menu-remove').click();       // 관심 해제

    await expect.poll(() => deleted).toBe('005930');               // DELETE 발사
    await expect(page.getByTestId('watchlist-row-005930')).toHaveCount(0); // refetch 후 행 사라짐
    await expect(menu).toHaveCount(0);                             // 메뉴 닫힘
  });
});
