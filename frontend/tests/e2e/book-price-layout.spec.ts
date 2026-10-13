import { test, expect } from '@playwright/test';

// jsdom cannot measure the absolute badge spilling into the depth column.
// Render the real component and styles with seven-digit prices and +30.00%.
test('폭이 좁아져도 시·고·저와 긴 가격·전체 통계를 유지하고 가로 스크롤한다', async ({ page }) => {
  await page.goto('/tests/e2e/fixtures/book-price-layout.html');
  const panel = page.locator('.book-panel');
  await expect(panel.getByText('고', { exact: true })).toBeVisible();
  await expect(panel.getByText('시', { exact: true })).toBeVisible();
  await expect(panel.getByText('저', { exact: true })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);

  for (const live of [true, false]) {
    for (const width of [479, 478, 360, 315, 280]) {
      await page.locator('#fixture').evaluate((el, { width, live }) => {
        el.classList.toggle('live-window', live);
        (el as HTMLElement).style.width = `${width}px`;
      }, { width, live });
      await expect(async () => {
        const geometry = await panel.evaluate((el) => {
          const grid = el.querySelector('.book-panel-grid')!;
          const center = grid.children[1];
          const bounds = center.getBoundingClientRect();
          const prices = [...center.querySelectorAll('.font-data.text-base')];
          const edges = prices.map((price) => {
            const range = document.createRange();
            range.selectNodeContents(price.lastChild!);
            return range.getBoundingClientRect().right;
          });
          const contents = [...center.querySelectorAll('span')].map((span) => {
            const rect = span.getBoundingClientRect();
            return { text: span.textContent, left: rect.left, right: rect.right };
          });
          return {
            count: prices.length,
            gridWidth: grid.getBoundingClientRect().width,
            summaryRows: [...el.querySelectorAll('[data-testid="book-summary"] [style*="22px"]')].filter(row => getComputedStyle(row).display !== 'none').length,
            alignment: Math.max(...edges) - Math.min(...edges),
            overflow: contents.filter((rect) => rect.left < bounds.left - 0.5 || rect.right > bounds.right + 0.5),
          };
        });
        expect(geometry.count).toBe(20);
        expect(geometry.gridWidth).toBeGreaterThanOrEqual(479);
        expect(geometry.summaryRows).toBe(12);
        expect(geometry.overflow, `${width}px, live=${live}`).toEqual([]);
        expect(geometry.alignment).toBeLessThan(0.5);
      }).toPass({ timeout: 5000 });
      await expect(panel.getByRole('button', { name: /상세 통계/ })).toHaveCount(0);
      await expect(panel.getByText('체결강도', { exact: true })).toBeVisible();
      if (width < 479) {
        const region = panel.getByRole('region', { name: '10호가 사다리와 요약' });
        expect(await region.evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true);
        await region.evaluate(el => { el.scrollLeft = el.scrollWidth; });
        await expect(region).toHaveJSProperty('scrollLeft', 479 - width);
        await expect(panel.getByText('250일', { exact: true })).toBeInViewport();
        await region.evaluate(el => { el.scrollLeft = 0; });
      }
    }
  }
});
