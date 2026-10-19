import { expect, test, type Page } from '@playwright/test';

async function mount(page: Page) {
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.route(url => url.pathname === '/', route => route.fulfill({ contentType: 'text/html',
    body: '<html><body style="margin:0"><script>window.$RefreshSig$=()=>type=>type;window.$RefreshReg$=()=>{};window.__vite_plugin_react_preamble_installed=true;</script></body></html>',
  }));
  await page.goto('/');
  await page.evaluate(async () => {
    const path = '/tests/e2e/helpers/bookFluidLayoutHarness.tsx';
    const harness = await import(path);
    harness.mount();
    await document.fonts.ready;
  });
  await expect(page.locator('.book-price-value')).toHaveCount(20);
}

async function resize(page: Page, width: number) {
  await page.locator('.live-window').evaluate((host, width) => { (host as HTMLElement).style.width = `${width}px`; }, width);
}

async function update(page: Page, mode: 'normal' | 'large' | 'plain', symbol = 'same') {
  await page.evaluate(async args => {
    const path = '/tests/e2e/helpers/bookFluidLayoutHarness.tsx';
    const harness = await import(path);
    harness.render(args.mode, args.symbol);
  }, { mode, symbol });
}

async function metrics(page: Page) {
  return page.locator('.book-panel').evaluate(panel => {
    const grid = panel.querySelector('.book-panel-grid')!, [left, center, right] = Array.from(grid.children);
    const region = panel.querySelector('.book-scroll-region')!;
    const rangeBounds = (el: Element) => { const r = document.createRange(); r.selectNodeContents(el); return r.getBoundingClientRect(); };
    const fits = Array.from(panel.querySelectorAll('.book-quantity-content, .book-trade-row, .book-strength-row')).every(cell => {
      const bounds = cell.getBoundingClientRect();
      return Array.from(cell.children).every(span => {
        const text = rangeBounds(span);
        return text.left >= bounds.left - 1 && text.right <= bounds.right + 1;
      });
    });
    const trades = Array.from(panel.querySelectorAll('.book-trade-row')).map(row => Array.from(row.children).map(span => rangeBounds(span).right));
    const qty = panel.querySelector('.book-quantity-content')!, style = getComputedStyle(qty);
    return { fits, trades, left: left.getBoundingClientRect().width, right: right.getBoundingClientRect().width,
      center: center.getBoundingClientRect().width,
      offset: (center.getBoundingClientRect().left + center.getBoundingClientRect().right - grid.getBoundingClientRect().left - grid.getBoundingClientRect().right) / 2,
      scroll: region.scrollWidth > region.clientWidth + 1,
      pad: style.paddingLeft, gap: style.columnGap,
      rowHeights: Array.from(panel.querySelectorAll('.book-quantity-content')).map(el => el.parentElement!.getBoundingClientRect().height),
      font: style.fontSize, min: parseFloat(getComputedStyle(grid).getPropertyValue('--book-side-content-width')) };
  });
}

test('book keeps the twenty-row centered ladder and full quantities while spacing responds', async ({ page }, info) => {
  await mount(page);
  const samples = [];
  for (const width of [640, 530, 409, 360, 320, 640]) {
    await resize(page, width);
    await expect(page.locator('.book-quantity-content').first()).toHaveCSS('padding-left', width >= 531 ? '8px' : width >= 400 ? '4px' : '2px');
    await expect(async () => {
      const m = await metrics(page);
      expect(m.fits).toBe(true);
      expect(m.scroll).toBe(false);
      expect(m.left).toBeCloseTo(m.right, 1);
      expect(m.offset).toBeCloseTo(0, 1);
      expect(m.rowHeights).toEqual(Array(20).fill(22));
      for (const row of m.trades) expect(row).toEqual(m.trades[0]);
    }).toPass();
    samples.push(await metrics(page));
    if (width === 320) await page.screenshot({ path: info.outputPath('book-fluid-320.png') });
  }
  for (const m of samples) { expect(m.center).toBe(samples[0].center); expect(m.font).toBe(samples[0].font); }
  await info.attach('responsive-spacing', { body: JSON.stringify(samples), contentType: 'application/json' });
});

test('large balances and transient deltas reserve symmetric widths without clipping or shrinking', async ({ page }, info) => {
  await mount(page);
  await resize(page, 320);
  await update(page, 'large');
  await expect.poll(async () => (await metrics(page)).scroll).toBe(true);
  const large = await metrics(page);
  expect(large.fits).toBe(true);
  expect(large.left).toBeCloseTo(large.right, 1);
  await update(page, 'plain');
  await expect(page.locator('.book-qty-delta')).toHaveCount(0);
  expect((await metrics(page)).min).toBe(large.min);
  await update(page, 'normal');
  expect((await metrics(page)).min).toBe(large.min);
  await update(page, 'normal', 'another-symbol');
  await expect.poll(async () => (await metrics(page)).scroll).toBe(false);
  expect((await metrics(page)).min).toBeLessThan(large.min);
  await update(page, 'large');
  const region = page.getByRole('region', { name: '10호가 사다리와 요약' });
  await region.evaluate(el => { el.scrollLeft = el.scrollWidth; });
  await expect(page.getByText('−5,400,000', { exact: true }).first()).toBeInViewport();
  await page.screenshot({ path: info.outputPath('book-large-balanced.png') });
});

test('side widths follow font density and summary numbers share a right edge', async ({ page }) => {
  await mount(page);
  const sizes = [];
  for (const font of [14, 16, 20]) {
    await page.evaluate(font => { document.documentElement.style.fontSize = `${font}px`; }, font);
    await resize(page, 320);
    await expect.poll(async () => parseFloat((await metrics(page)).font)).toBeCloseTo(font * 11.5 / 16, 1);
    await expect(async () => {
      const m = await metrics(page);
      expect(m.fits).toBe(true);
      expect(m.left).toBeCloseTo(m.right, 1);
      expect(m.rowHeights).toEqual(Array(20).fill(22));
    }).toPass();
    sizes.push((await metrics(page)).min);
  }
  expect(sizes[0]).toBeLessThan(sizes[1]); expect(sizes[1]).toBeLessThan(sizes[2]);
  await page.evaluate(() => { document.documentElement.style.fontSize = '16px'; });
  await resize(page, 640);
  const ends = await page.getByTestId('book-summary').locator('.book-summary-row > span:nth-child(2)').evaluateAll(spans => spans.map(span => span.getBoundingClientRect().right));
  for (const end of ends) expect(end).toBeCloseTo(ends[0], 1);
});
