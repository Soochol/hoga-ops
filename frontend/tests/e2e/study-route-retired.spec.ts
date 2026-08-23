import { test, expect } from '@playwright/test';

/**
 * 사라진 `/study` 라우트의 착지 계약 (2026-08-23).
 *
 * **e2e 인 이유**: 재는 것이 라우터의 실제 URL 전이다. 리다이렉트 컴포넌트는
 * `main.tsx` 안에 있어 유닛에서 붙잡으려면 라우트 표를 흉내 내야 하는데, 그러면
 * 정작 **표에 잘못 등록하는 실수**를 못 잡는다 — 이 기능에서 유일하게 현실적인
 * 실패 모드가 그것이다.
 *
 * **막는 방향**: ① 옛 북마크가 "No routes matched" 빈 화면에 떨어지는 것
 * ② 리다이렉트가 `?view=` 를 **버려서** 저장뷰 딥링크가 종목 없는 `/live` 가 되는 것.
 * ②가 `<Navigate to="/live" replace />` 한 줄로 끝냈을 때 실제로 생기는 결과다.
 *
 * **못 보는 것**: 저장뷰가 실제로 열리는지. e2e 백엔드는 무자격·빈 데이터라 그 id 가
 * 404 다(그래서 여기서는 URL 만 본다). 시드 계약은
 * `src/studyViews/useSavedRangeDeepLink.test.tsx` 가 잰다.
 */
test.describe('사라진 `/study` 라우트', () => {
  test('옛 북마크는 `/live` 로 착지한다', async ({ page }) => {
    await page.goto('/study');

    await expect(page).toHaveURL(/\/live$/);
    // 빈 화면이 아니라 진짜 `/live` 다 — 라우트 표에 잘못 걸리면 셸만 남는다.
    await expect(page.getByRole('navigation', { name: '주요 메뉴' })).toBeVisible();
  });

  test('저장뷰 딥링크는 `?view=` 를 들고 간다', async ({ page }) => {
    await page.goto('/study?view=deadbeef');

    await expect(page).toHaveURL(/\/live\?view=deadbeef$/);
  });

  test('상단 메뉴에 「복기」가 없다', async ({ page }) => {
    await page.goto('/live');
    await expect(page.getByRole('navigation', { name: '주요 메뉴' })).toBeVisible();

    await expect(page.getByRole('link', { name: '복기' })).toHaveCount(0);
    // 대조군 — 메뉴 자체는 멀쩡하다(로케이터가 틀려서 0 이 나온 것이 아니다).
    await expect(page.getByRole('link', { name: '라이브' })).toHaveCount(1);
  });
});
