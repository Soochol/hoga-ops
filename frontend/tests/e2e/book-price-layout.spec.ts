import { test, expect, type Locator } from '@playwright/test';

async function expectBookSummary(dialog: Locator) {
  await expect(dialog.getByTestId('book-summary')).toHaveAttribute('data-page', '1');
  for (const label of ['예상 체결가', '예상 체결량', '시작', '최고', '최저', 'KRX종가', '거래량', '어제보다', '거래대금']) {
    await expect(dialog.getByText(label, { exact: true })).toBeVisible();
  }
}

for (const [depth, askCount, bidCount] of [['partial', 4, 3], ['five', 5, 5]] as const) {
  test(`${depth} 호가는 빈 가격 없이 잔량과 정렬되고 상세 정보를 열 수 있다`, async ({ page }, testInfo) => {
    await page.goto(`/tests/e2e/fixtures/book-price-layout.html?depth=${depth}`);
    const panel = page.locator('.book-panel');
    const grid = panel.locator('.book-panel-grid');
    await expect(grid.locator('.book-price-value')).toHaveCount(askCount + bidCount);
    for (const width of [640, 409]) {
      await page.locator('#fixture').evaluate((el, width) => { (el as HTMLElement).style.width = `${width}px`; }, width);
      if (width >= 531) await expect(panel.locator('.book-inline-summary')).toBeVisible();
      else await expect(panel.locator('.book-inline-summary')).toBeHidden();
      await expect(async () => {
        const rows = await grid.evaluate((el, askCount) => {
          const [left, center, right] = Array.from(el.children);
          const prices = Array.from(center.children);
          const askBars = Array.from(left.children).slice(0, askCount);
          const bidBars = Array.from(right.children).slice(1);
          const bars = [...askBars, ...bidBars];
          return prices.map((price, i) => ({
            text: price.textContent,
            offset: price.getBoundingClientRect().top - bars[i].getBoundingClientRect().top,
            priceHeight: price.getBoundingClientRect().height,
            barHeight: bars[i].getBoundingClientRect().height,
          }));
        }, askCount);
        expect(rows).toHaveLength(askCount + bidCount);
        for (const row of rows) {
          expect(row.text).not.toContain('—');
          expect(row.offset).toBeCloseTo(0, 1);
          expect(row.priceHeight).toBe(22);
          expect(row.barHeight).toBe(22);
        }
      }).toPass({ timeout: 5000 });
      const info = panel.getByRole('button', { name: '종목 상세 정보' });
      if (width >= 531) {
        await expect(info).toBeHidden();
        continue;
      }
      await expect(info).toBeVisible();
      await info.click();
      const dialog = page.getByRole('dialog', { name: '종목 상세 정보' });
      await expectBookSummary(dialog);
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      await expect(info).toBeFocused();
    }
    await panel.screenshot({ path: testInfo.outputPath(`${depth}-book.png`) });
  });
}

test('10호가는 부분·한쪽 호가에서도 사다리 중앙에 경계를 고정하고 작은 창에서는 스크롤한다', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1000, height: 1000 });
  for (const depth of ['full', 'partial', 'five', 'ask-only', 'bid-only']) {
    await page.goto(`/tests/e2e/fixtures/book-price-layout.html?depth=${depth}`);
    const panel = page.locator('.book-panel');
    const region = panel.getByRole('region', { name: '10호가 사다리와 요약' });
    await page.locator('#fixture').evaluate(el => { Object.assign((el as HTMLElement).style, { width: '640px', height: '840px' }); });
    await expect(panel.locator('.book-inline-summary')).toBeVisible();
    await expect(async () => {
      const layout = await panel.evaluate(el => {
        const region = el.querySelector('.book-scroll-region')!.getBoundingClientRect();
        const grid = el.querySelector('.book-panel-grid')!.getBoundingClientRect();
        return { center: region.y + region.height / 2, gridCenter: grid.y + grid.height / 2,
          dividers: [...el.querySelectorAll('[data-book-divider]')].map(node => node.getBoundingClientRect().y) };
      });
      expect(layout.gridCenter).toBeCloseTo(layout.center, 1);
      expect(layout.dividers).toHaveLength(3);
      for (const divider of layout.dividers) expect(divider).toBeCloseTo(layout.center, 1);
    }).toPass();
    if (depth === 'partial') await panel.screenshot({ path: testInfo.outputPath('ten-level-partial-centered.png') });
    await page.locator('#fixture').evaluate(el => { (el as HTMLElement).style.height = '240px'; });
    await expect.poll(() => region.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
    await expect(panel.locator('.book-panel-grid')).toHaveCSS('height', '440px');
    await region.evaluate(el => { el.scrollTop = el.scrollHeight; });
    await expect.poll(() => region.evaluate(el => Math.abs(el.scrollHeight - el.clientHeight - el.scrollTop))).toBeLessThan(1);
    if (depth !== 'ask-only') await expect(panel.locator('.book-panel-grid > div').nth(1).locator('.book-price-value').last()).toBeInViewport();
  }
});

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
          const prices = [...center.querySelectorAll('.book-price-value')];
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
          const quantityAligned = [...grid.querySelectorAll('.book-quantity-content')].every(cell => {
            const quantity = cell.querySelector('.flex-1')!;
            const range = document.createRange(); range.selectNodeContents(quantity);
            const text = range.getBoundingClientRect(), box = cell.getBoundingClientRect(), css = getComputedStyle(cell);
            return quantity.classList.contains('text-qty-ask')
              ? Math.abs(text.right - (box.right - parseFloat(css.paddingRight))) < 0.1
              : Math.abs(text.left - (box.left + parseFloat(css.paddingLeft))) < 0.1;
          });
          return {
            quantityFits, quantityAligned,
            sideMinimum: parseFloat(getComputedStyle(grid).getPropertyValue('--book-side-content-width')),
            count: prices.length, gridWidth: grid.getBoundingClientRect().width,
            leftWidth: left.getBoundingClientRect().width, rightWidth: right.getBoundingClientRect().width, centerWidth: bounds.width,
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
        expect(g.quantityAligned).toBe(true);
        expect(g.gridWidth).toBeCloseTo(Math.max(width, 2 * (width < 531 ? g.sideMinimum : Math.max(184, g.sideMinimum)) + g.centerWidth), 0);
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
      const compactMin = Math.round(2 * await panel.locator('.book-panel-grid').evaluate(el => parseFloat(getComputedStyle(el).getPropertyValue('--book-side-content-width'))) + (await gridCenterWidth(panel)));
      expect(await region.evaluate(el => el.scrollWidth > el.clientWidth)).toBe(width < compactMin);
      const inline = panel.locator('.book-inline-summary');
      const info = panel.getByRole('button', { name: '종목 상세 정보' });
      if (width >= 531) {
        await expect(inline).toBeVisible();
        await expect(info).toBeHidden();
      } else {
        await expect(inline).toBeHidden();
        if (width < compactMin) {
          await region.focus();
          await page.keyboard.press('ArrowRight');
          await expect.poll(() => region.evaluate(el => el.scrollLeft)).toBeGreaterThan(0);
          await region.evaluate(el => { el.scrollLeft = el.scrollWidth; });
          await expect(region).toHaveJSProperty('scrollLeft', compactMin - width);
        }
        await expect(info).toBeInViewport();
        await info.click();
        const dialog = page.getByRole('dialog', { name: '종목 상세 정보' });
        await expectBookSummary(dialog);
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

async function gridCenterWidth(panel: Locator) {
  return panel.locator('.book-panel-grid > div').nth(1).evaluate(el => el.getBoundingClientRect().width);
}

test('10호가의 천만 원대 가격과 확대 글꼴은 배지·등락률·잔량을 침범하지 않는다', async ({ page }, testInfo) => {
  await page.goto('/tests/e2e/fixtures/book-price-layout.html?offset=8838000');
  await page.evaluate(() => document.fonts.ready);
  const panel = page.locator('.book-panel');
  for (const fontSize of [16, 20, 24]) {
    await page.evaluate(size => { document.documentElement.style.fontSize = `${size}px`; }, fontSize);
    for (const width of [640, 409, 320]) {
      await page.locator('#fixture').evaluate((el, w) => { (el as HTMLElement).style.width = `${w}px`; }, width);
      await expect(async () => {
        const geometry = await panel.locator('.book-price-line').evaluateAll(rows => rows.map(row => {
          const box = row.getBoundingClientRect();
          const value = row.querySelector('.book-price-value')!.getBoundingClientRect();
          const amount = row.querySelector('.book-price-amount')!.getBoundingClientRect();
          const percent = row.querySelector('.book-price-percent')!.getBoundingClientRect();
          const badge = row.querySelector('[data-price-badges]')?.getBoundingClientRect();
          return { text: row.querySelector('.book-price-amount')!.textContent,
            font: getComputedStyle(row).fontSize, valueFont: getComputedStyle(row.querySelector('.book-price-value')!).fontSize,
            padding: getComputedStyle(row.querySelector('.book-price-value')!).paddingLeft,
            axisFont: getComputedStyle(row.closest('.book-panel-grid')!).fontSize,
            columns: getComputedStyle(row).gridTemplateColumns, amountWidth: amount.width,
            left: box.left, valueLeft: value.left, right: box.right, percentRight: percent.right, contained: value.left >= box.left && percent.right <= box.right + 0.1,
            separated: amount.right <= percent.left, innerGap: percent.left - amount.right,
            leftGutter: value.left - box.left, rightGutter: box.right - percent.right,
            gap: badge ? amount.left - badge.right : null,
            smaller: parseFloat(getComputedStyle(row.querySelector('.book-price-percent')!).fontSize) < parseFloat(getComputedStyle(row.querySelector('.book-price-value')!).fontSize),
            edge: amount.right };
        }));
        for (const row of geometry) {
          expect(row.contained, JSON.stringify({ fontSize, width, row })).toBe(true); expect(row.separated).toBe(true); expect(row.smaller).toBe(true);
          expect(row.innerGap).toBeCloseTo(2, 1);
          expect(row.leftGutter).toBeGreaterThanOrEqual(7.9); expect(row.rightGutter).toBeGreaterThanOrEqual(7.9);
          if (row.gap !== null) expect(row.gap).toBeCloseTo(4, 1);
        }
        expect(Math.max(...geometry.map(row => row.edge)) - Math.min(...geometry.map(row => row.edge))).toBeLessThan(0.5);
      }).toPass({ timeout: 3000 });
    }
  }
  await page.evaluate(() => { document.documentElement.style.fontSize = '16px'; });
  await page.locator('#fixture').evaluate(el => { (el as HTMLElement).style.width = '409px'; });
  await panel.screenshot({ path: testInfo.outputPath('ten-million-book-price.png') });
});
