import { test, expect, type Page, type Locator } from '@playwright/test';
import { installLiveMocks } from './helpers/liveMocks';
import { apiExact } from './helpers/apiRoutes';

const folder = 'f_0000000a';

async function setup(page: Page, panel: 'watchlist' | 'heatmap', width: number) {
  await page.setViewportSize({ width, height: 1000 });
  await installLiveMocks(page);
  const folders = [{ id: folder, order: 0, name: '스윙' }];
  const entries = [{ code: '098460', name: '고영', folder_id: folder, order: 0,
    registered_at_kst_date: '20260527', last_success_date: null }];
  await page.route(apiExact('watchlist'), route => route.fulfill({ json: { folders, entries, memos: [], next_run_at_ms: 0 } }));
  await page.route(apiExact('heatmap'), route => route.fulfill({ json: { folders, entries, capture_markers: {}, next_run_at_ms: 0 } }));
  await page.goto('/live?code=098460');
  const header = page.getByTestId(panel === 'watchlist' ? 'watchlist-group-header' : 'heatmap-group-header').first();
  if (!await header.isVisible()) await page.getByRole('button', { name: panel === 'watchlist' ? /관심종목 패널 토글/ : /히트맵 패널 토글/ }).click();
  await expect(header).toBeVisible();
  const opener = page.getByTestId('chart-window-header').first().getByRole('button', { name: /보조지표/ });
  await expect(opener).toBeEnabled();
  return { header, opener };
}

async function headerPoint(header: Locator) {
  const box = (await header.boundingBox())!;
  return { x: box.x + box.width - 12, y: box.y + box.height / 2 };
}

for (const panel of ['watchlist', 'heatmap'] as const) {
  for (const width of [1440, 1180]) {
    test(`${panel} ${width}px: 보조지표 모달이 우측 고정 헤더까지 덮는다`, async ({ page }, testInfo) => {
      const { header, opener } = await setup(page, panel, width);
      const point = await headerPoint(header);
      const headerBackground = await header.evaluate(el => getComputedStyle(el).backgroundColor);
      await page.screenshot({ path: testInfo.outputPath('before-modal.png') });
      await opener.click();
      const dialog = page.getByRole('dialog', { name: '지표', exact: true });
      await expect(dialog).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath('indicator-modal.png') });
      const hit = await page.evaluate(point => document.elementFromPoint(point.x, point.y)?.closest('[role="dialog"]')?.getAttribute('aria-label'), point);
      expect(hit).toBe('지표');
      await expect(dialog).toHaveCSS('background-color', 'rgba(0, 0, 0, 0.5)');
      expect(await header.evaluate(el => getComputedStyle(el).backgroundColor)).toBe(headerBackground);
      // The rail header belongs to the backdrop while a modal is open.
      await page.mouse.click(point.x, point.y);
      await expect(dialog).toHaveCount(0);
      await expect(header.getByRole('button', { name: '스윙 1', exact: true })).toHaveAttribute('aria-expanded', 'true');
      // 키보드로 연 모달은 Escape로 닫으면 열었던 버튼으로 포커스를 복원한다.
      await opener.focus();
      await opener.press('Enter');
      await expect(dialog).toBeVisible();
      const close = dialog.getByRole('button', { name: '닫기', exact: true });
      await close.focus();
      await page.keyboard.press('Tab');
      expect(await dialog.evaluate(el => el.contains(document.activeElement))).toBe(true);
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      await expect(opener).toBeFocused();
      await header.getByRole('button', { name: '스윙 1', exact: true }).click();
      await expect(header.getByRole('button', { name: '스윙 1', exact: true })).toHaveAttribute('aria-expanded', 'false');
    });
  }
}

for (const width of [1440, 1180]) {
  test(`${width}px: 차트 데이터 수집 모달도 우측 헤더를 덮는다`, async ({ page }) => {
    const { header } = await setup(page, 'watchlist', width);
    const point = await headerPoint(header);
    const opener = page.getByTestId('chart-window-header').first().getByRole('button', { name: '데이터 수집', exact: true });
    await opener.click();
    const dialog = page.getByRole('dialog', { name: /지난 N일 수집/ });
    await expect(dialog).toBeVisible();
    expect(await page.evaluate(point => document.elementFromPoint(point.x, point.y)?.closest('[role="dialog"]')?.getAttribute('aria-label'), point)).toMatch(/지난 N일 수집/);
    await page.mouse.click(point.x, point.y);
    await expect(dialog).toHaveCount(0);
    await expect(header.getByRole('button', { name: '스윙 1', exact: true })).toHaveAttribute('aria-expanded', 'true');
    await opener.focus();
    await opener.press('Enter');
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(opener).toBeFocused();
  });
}
