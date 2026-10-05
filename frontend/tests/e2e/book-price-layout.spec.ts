import { test, expect } from '@playwright/test';

// jsdom cannot measure the absolute badge spilling into the depth column.
// Render the real component and styles with seven-digit prices and +30.00%.
test('시·고·저와 긴 가격은 일반·축소 호가창의 가격 열 안에 정렬된다', async ({ page }) => {
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
            alignment: Math.max(...edges) - Math.min(...edges),
            overflow: contents.filter((rect) => rect.left < bounds.left - 0.5 || rect.right > bounds.right + 0.5),
          };
        });
        expect(geometry.count).toBe(20);
        expect(geometry.overflow, `${width}px, live=${live}`).toEqual([]);
        expect(geometry.alignment).toBeLessThan(0.5);
      }).toPass({ timeout: 5000 });
    }
  }
});
