import { test, expect } from '@playwright/test';

test('home opens the workspace and the brand returns home', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('맥락을 읽다');
  await page.getByRole('tab', { name: '02 기록' }).click();
  await expect(page.getByRole('tabpanel')).toContainText('종목뷰에 기간 저장');
  await page.screenshot({ path: '/tmp/hoga-landing-desktop.png', fullPage: true });
  await page.getByRole('link', { name: /라이브 시작하기/ }).click();
  await expect(page).toHaveURL(/\/live$/);
  await page.getByRole('link', { name: 'hoga-ops 홈' }).click();
  await expect(page).toHaveURL(/\/$/);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await page.screenshot({ path: '/tmp/hoga-landing-mobile.png', fullPage: true });
});
