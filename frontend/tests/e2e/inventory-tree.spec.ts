import { test, expect } from '@playwright/test';

/**
 * STATUS: 데이터 의존적 — 백엔드 inventory에 적어도 2종목·3 dates가 있어야
 * 검색·정렬 동작을 검증할 수 있다. 일부 환경에서는 skip될 수 있다.
 */
test.describe('Inventory tree (Master-Detail)', () => {
  test('search filters left list and row click navigates to /replay', async ({ page }) => {
    await page.goto('/inventory');

    // 좌측 카드 헤더 확인
    await expect(page.getByText(/종목 \d+개/)).toBeVisible({ timeout: 5000 });

    // 우측 카드가 자동 선택된 종목 헤더를 보여야 함
    const detailHeader = page.locator('section h2').first();
    await expect(detailHeader).toBeVisible();

    // 검색 입력 — 한 글자만 쳐도 좁혀져야 함
    const search = page.getByPlaceholder('종목명 또는 코드…');
    await search.fill('0');
    await expect(page.getByText(/\d+ matches/)).toBeVisible();

    // 검색 클리어
    await search.fill('');

    // 우측 첫 행 클릭 → /replay로 이동
    const firstDateRow = page.locator('table tbody tr').first();
    await firstDateRow.click();
    await expect(page).toHaveURL(/\/replay/, { timeout: 5000 });
  });
});
