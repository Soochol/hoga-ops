import { test, expect } from '@playwright/test';

for (const [depth, askCount, bidCount] of [['partial', 4, 3], ['five', 5, 5]] as const) {
  test(`${depth} 호가는 빈 가격 없이 잔량과 정렬되고 상세 정보를 열 수 있다`, async ({ page }, testInfo) => {
    await page.goto(`/tests/e2e/fixtures/book-price-layout.html?depth=${depth}`);
    const panel = page.locator('.book-panel');
    const grid = panel.locator('.book-panel-grid');
    await expect(grid.locator('.font-data.text-base')).toHaveCount(askCount + bidCount);
    for (const width of [640, 409]) {
      await page.locator('#fixture').evaluate((el, width) => { (el as HTMLElement).style.width = `${width}px`; }, width);
      await expect(panel.locator('.book-inline-summary')).toBeHidden();
      await expect(async () => {
        const rows = await grid.evaluate(el => {
          const [left, center, right] = Array.from(el.children);
          const prices = Array.from(center.children).slice(1);
          const askBars = Array.from(left.children).slice(1, left.children.length - 2);
          const bidBars = Array.from(right.children).slice(1);
          const bars = [...askBars, ...bidBars];
          return prices.map((price, i) => ({
            text: price.textContent,
            offset: price.getBoundingClientRect().top - bars[i].getBoundingClientRect().top,
            priceHeight: price.getBoundingClientRect().height,
            barHeight: bars[i].getBoundingClientRect().height,
          }));
        });
        expect(rows).toHaveLength(askCount + bidCount);
        for (const row of rows) {
          expect(row.text).not.toContain('—');
          expect(row.offset).toBeCloseTo(0, 1);
          expect(row.priceHeight).toBe(22);
          expect(row.barHeight).toBe(22);
        }
      }).toPass({ timeout: 5000 });
      const info = panel.getByRole('button', { name: '종목 상세 정보' });
      await expect(info).toBeVisible();
      await info.click();
      const dialog = page.getByRole('dialog', { name: '종목 상세 정보' });
      await expect(dialog.getByText('250일', { exact: true })).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      await expect(info).toBeFocused();
    }
    await panel.screenshot({ path: testInfo.outputPath(`${depth}-book.png`) });
  });
}

// Real font metrics and container queries are unavailable in jsdom.
test('축소한 10호가의 폰트·가격·잔량 대칭·22px 행과 압축 하한 스크롤', async ({ page }) => {
  await page.goto('/tests/e2e/fixtures/book-price-layout.html');
  const panel = page.locator('.book-panel');
  const region = panel.getByRole('region', { name: '10호가 사다리와 요약' });
  for (const label of ['고', '시', '저']) await expect(panel.getByText(label, { exact: true })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  let originalFont = '';
  for (const live of [true, false]) {
    for (const width of [640, 531, 530, 409, 387, 360, 280]) {
      await page.locator('#fixture').evaluate((el, { width, live }) => {
        el.classList.toggle('live-window', live);
        (el as HTMLElement).style.width = `${width}px`;
      }, { width, live });
      await region.evaluate(el => { el.scrollLeft = 0; });
      await expect(async () => {
        const g = await panel.evaluate(el => {
          const grid = el.querySelector('.book-panel-grid')!;
          const [left, center, right] = [...grid.children];
          const bounds = center.getBoundingClientRect();
          const prices = [...center.querySelectorAll('.font-data.text-base')];
          const edges = prices.map(price => {
            const range = document.createRange();
            range.selectNodeContents(price.lastChild!);
            return range.getBoundingClientRect().right;
          });
          const contents = [...center.querySelectorAll('span')].map(span => {
            const r = span.getBoundingClientRect();
            return { text: span.textContent, left: r.left, right: r.right };
          });
          const ask = left.children[1];
          const bid = right.children[1];
          const askBar = ask.querySelector('.absolute')!;
          const bidBar = bid.querySelector('.absolute')!;
          const quantityFits = [ask, bid].every(cell => {
            const quantity = cell.querySelector('.flex-1')!;
            const r = quantity.getBoundingClientRect();
            const cellBounds = cell.getBoundingClientRect();
            const range = document.createRange();
            range.selectNodeContents(quantity);
            const textBounds = range.getBoundingClientRect();
            return r.left >= cellBounds.left && r.right <= cellBounds.right && textBounds.width <= r.width + 0.5;
          });
          return {
            quantityFits,
            count: prices.length, gridWidth: grid.getBoundingClientRect().width,
            leftWidth: left.getBoundingClientRect().width, rightWidth: right.getBoundingClientRect().width,
            centerOffset: (bounds.left + bounds.right - grid.getBoundingClientRect().left - grid.getBoundingClientRect().right) / 2,
            askBarWidth: askBar.getBoundingClientRect().width, bidBarWidth: bidBar.getBoundingClientRect().width,
            askInset: ask.getBoundingClientRect().right - askBar.getBoundingClientRect().right,
            bidInset: bidBar.getBoundingClientRect().left - bid.getBoundingClientRect().left,
            rowHeight: ask.getBoundingClientRect().height, font: getComputedStyle(prices[0]).fontSize,
            alignment: Math.max(...edges) - Math.min(...edges),
            overflow: contents.filter(r => r.left < bounds.left - 0.5 || r.right > bounds.right + 0.5),
          };
        });
        expect(g.count).toBe(20);
        expect(g.quantityFits).toBe(true);
        expect(g.gridWidth).toBeCloseTo(Math.max(width, width < 531 ? 387 : 531), 0);
        expect(g.leftWidth).toBeCloseTo(g.rightWidth, 1);
        expect(g.centerOffset).toBeCloseTo(0, 1);
        expect(g.askBarWidth).toBeCloseTo(g.bidBarWidth, 1);
        expect(g.askBarWidth).toBeGreaterThan(0);
        expect(g.askInset).toBe(0);
        expect(g.bidInset).toBe(0);
        expect(g.rowHeight).toBe(22);
        if (width === 640) originalFont = g.font;
        expect(g.font).toBe(originalFont);
        expect(g.overflow, `${width}px, live=${live}`).toEqual([]);
        expect(g.alignment).toBeLessThan(0.5);
      }).toPass({ timeout: 5000 });
      await expect(panel.getByText('체결강도', { exact: true })).toBeVisible();
      expect(await region.evaluate(el => el.scrollWidth > el.clientWidth)).toBe(width < 387);
      const inline = panel.locator('.book-inline-summary');
      const info = panel.getByRole('button', { name: '종목 상세 정보' });
      if (width >= 531) {
        await expect(inline).toBeVisible();
        await expect(info).toBeHidden();
      } else {
        await expect(inline).toBeHidden();
        if (width < 387) {
          await region.focus();
          await page.keyboard.press('ArrowRight');
          await expect.poll(() => region.evaluate(el => el.scrollLeft)).toBeGreaterThan(0);
          await region.evaluate(el => { el.scrollLeft = el.scrollWidth; });
          await expect(region).toHaveJSProperty('scrollLeft', 387 - width);
        }
        await expect(info).toBeInViewport();
        await info.click();
        const dialog = page.getByRole('dialog', { name: '종목 상세 정보' });
        await expect(dialog.getByText('250일', { exact: true })).toBeVisible();
        await expect(dialog.getByRole('button', { name: '상세 정보 닫기' })).toBeFocused();
        expect(await dialog.evaluate(el => {
          const r = el.getBoundingClientRect();
          return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight;
        })).toBe(true);
        await page.keyboard.press('Escape');
        await expect(dialog).toHaveCount(0);
        await expect(info).toBeFocused();
        await region.evaluate(el => { el.scrollLeft = 0; });
      }
      if (live && width === 409) await panel.screenshot({ path: '/tmp/hoga-compact-book-window.png' });
    }
  }
});

test('세로 스크롤바를 제외한 본문 너비로 압축 배치를 선택한다', async ({ page }) => {
  await page.goto('/tests/e2e/fixtures/book-price-layout.html');
  const panel = page.locator('.book-panel');
  const region = panel.getByRole('region', { name: '10호가 사다리와 요약' });
  for (const width of [531, 409]) {
    await page.locator('#fixture').evaluate((el, w) => { Object.assign((el as HTMLElement).style, { width: `${w}px`, height: '240px' }); }, width);
    await expect.poll(() => region.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
    const usableWidth = await region.evaluate(el => el.clientWidth);
    const inline = panel.locator('.book-inline-summary');
    if (usableWidth < 531) await expect(inline).toBeHidden();
    else await expect(inline).toBeVisible();
    expect(await region.evaluate(el => el.scrollWidth)).toBe(usableWidth);
  }
});

test('압축 상세 정보는 바깥 클릭·닫기·넓은 배치 전환으로 닫힌다', async ({ page }) => {
  await page.goto('/tests/e2e/fixtures/book-price-layout.html');
  const info = page.getByRole('button', { name: '종목 상세 정보' });
  const dialog = page.getByRole('dialog', { name: '종목 상세 정보' });
  await info.click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: '상세 정보 닫기' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(info).toBeFocused();
  await info.click();
  await expect(dialog).toBeVisible();
  await page.mouse.click(1000, 700);
  await expect(dialog).toHaveCount(0);
  await info.click();
  await expect(dialog).toBeVisible();
  await page.locator('#fixture').evaluate(el => { (el as HTMLElement).style.width = '640px'; });
  await expect(info).toBeHidden();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.book-inline-summary')).toBeVisible();
});
