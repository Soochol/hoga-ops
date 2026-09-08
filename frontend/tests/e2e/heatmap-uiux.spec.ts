import { test, expect } from '@playwright/test';
import { installLiveMocks } from './helpers/liveMocks';
import { apiPrefix } from './helpers/apiRoutes';
for (const width of [1440, 800, 600]) {
  test(`heatmap search and collection at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await installLiveMocks(page);
    await page.route(apiPrefix('heatmap'), (route) => route.fulfill({ json: {
      version: 3,
      folders: [{ id: 'a', name: '반도체-메모리와 긴 그룹 이름', order: 0 }, { id: 'b', name: '대형주', order: 1 }],
      entries: [
        { code: '005930', name: '삼성전자', folder_id: 'a', order: 0 },
        { code: '000660', name: 'SK하이닉스', folder_id: 'a', order: 1 },
        { code: '005930', name: '삼성전자', folder_id: 'b', order: 0 },
      ], capture_markers: { '005930': '20260908', '000660': '20260907' },
    } }));
    await page.goto('/heatmap');
    const main = page.getByTestId('heatmap-page-primary');
    await expect(main.getByText('3개 등록 · 2개 고유 종목', { exact: false })).toBeVisible();
    const box = await main.boundingBox();
    expect(box!.x + box!.width).toBeLessThanOrEqual(width);
    await page.getByTestId('heatmap-search').fill('삼성');
    await main.getByRole('button', { name: '일치 종목만' }).click();
    await expect(main.getByTestId('heatmap-row-000660')).toHaveCount(0);
    await main.getByRole('button', { name: '다음 일치 종목' }).click();
    await expect(main.getByTestId('heatmap-row-005930').first()).toBeFocused();
    await main.getByRole('button', { name: '다음 일치 종목' }).click();
    await expect(main.getByTestId('heatmap-row-005930').last()).toBeFocused();
    await main.getByTestId('heatmap-folder-lag-a').click();
    await expect(page.getByRole('dialog')).toContainText('20260908');
    await expect(page.getByRole('dialog')).toContainText('SK하이닉스');
    await page.getByRole('button', { name: '취소', exact: true }).click();
    await main.getByRole('button', { name: '데이터 수집', exact: false }).click();
    await expect(page.getByRole('dialog')).toContainText('2/2개 선택');
    await page.getByRole('button', { name: '전체 해제' }).click();
    await expect(page.getByRole('button', { name: '커버리지 확인' })).toBeDisabled();
    await page.getByRole('button', { name: '취소', exact: true }).click();
    const menu = main.getByRole('button', { name: '반도체-메모리와 긴 그룹 이름 그룹 메뉴' });
    await menu.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('menuitem', { name: '그룹 이름 변경' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(menu).toBeFocused();
  });
}
