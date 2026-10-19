import { expect, test, type Page } from '@playwright/test';

async function mount(page: Page, large = false, many = false) {
  await page.setViewportSize({ width: 1200, height: 600 });
  await page.route(url => url.pathname === '/', route => route.fulfill({ contentType: 'text/html',
    body: '<html><body style="margin:0"><script>window.$RefreshSig$=()=>type=>type;window.$RefreshReg$=()=>{};window.__vite_plugin_react_preamble_installed=true;</script></body></html>',
  }));
  await page.goto('/');
  await page.evaluate(async args => {
    const path = '/tests/e2e/helpers/brokerLayoutHarness.tsx';
    const harness = await import(path);
    harness.mount(args.large, args.many);
    await document.fonts.ready;
  }, { large, many });
  await expect(page.getByTestId('broker-row').first()).toBeVisible();
}

async function resize(page: Page, width: number) {
  await page.locator('.live-window').evaluate((host, width) => { (host as HTMLElement).style.width = `${width}px`; }, width);
}

async function metrics(page: Page) {
  return page.getByRole('region', { name: '거래원 목록' }).evaluate(scroller => {
    const rows = Array.from(scroller.querySelectorAll('[data-testid="broker-row"]'));
    const positions = rows.map(row => Array.from(row.children).map(cell => {
      const rect = cell.getBoundingClientRect();
      return { left: rect.left, right: rect.right, width: rect.width };
    }));
    const fits = rows.every(row => [row.firstElementChild!, row.lastElementChild!].every(cell => {
      const range = document.createRange(); range.selectNodeContents(cell);
      const text = range.getBoundingClientRect(), box = cell.getBoundingClientRect();
      return text.left >= box.left - 1 && text.right <= box.right + 1;
    }));
    const footer = scroller.querySelector('.broker-footer')!.getBoundingClientRect();
    return { fits, positions, heights: rows.map(row => row.getBoundingClientRect().height),
      font: getComputedStyle(rows[0]).fontSize, scroll: scroller.scrollWidth > scroller.clientWidth + 1,
      footerBottom: footer.bottom, viewportBottom: scroller.getBoundingClientRect().bottom,
      footerRight: scroller.querySelector('[data-testid="broker-foreign-sum"]')!.getBoundingClientRect().right };
  });
}

test('broker rows and foreign total share responsive columns without changing type or row height', async ({ page }, info) => {
  await mount(page);
  const samples = [];
  for (const width of [720, 560, 400, 320, 720]) {
    await resize(page, width);
    await expect(page.locator('.broker-table')).toHaveCSS('column-gap', width < 480 ? '2px' : width < 640 ? '4px' : '8px');
    const sample = await metrics(page);
    expect(sample.fits).toBe(true);
    expect(sample.scroll).toBe(false);
    for (const row of sample.positions) {
      expect(row).toEqual(sample.positions[0]);
      expect(row[1].width).toBeGreaterThanOrEqual(64);
      expect(row[2].right).toBe(sample.footerRight);
    }
    expect(sample.footerBottom).toBeCloseTo(sample.viewportBottom, 1);
    samples.push(sample);
    if (width === 320) await page.screenshot({ path: info.outputPath('broker-320.png') });
  }
  for (const sample of samples) {
    expect(sample.heights).toEqual(samples[0].heights);
    expect(sample.font).toBe(samples[0].font);
  }
  await info.attach('resize-metrics', { body: JSON.stringify(samples), contentType: 'application/json' });
});

test('external cursors and local hover cannot move the shared tracks or row order', async ({ page }) => {
  await mount(page);
  await resize(page, 320);
  const before = await metrics(page);
  const names = await page.getByTestId('broker-row').locator('[title]').allTextContents();
  for (const minutes of [0, 5, 10, 15]) {
    await page.evaluate(async minutes => {
      const path = '/tests/e2e/helpers/brokerLayoutHarness.tsx';
      const harness = await import(path);
      harness.setCursor(harness.open + minutes * 60000);
    }, minutes);
    if (minutes === 5) await expect(page.getByTestId('broker-foreign-sum')).toHaveText('+1,999,999,998');
    const after = await metrics(page);
    expect(after.fits).toBe(true);
    expect(after.positions).toEqual(before.positions);
    expect(after.heights).toEqual(before.heights);
  }
  const plot = page.getByTestId('broker-row').first().locator('svg');
  const box = (await plot.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.02, box.y + box.height / 2);
  await expect(page.getByTestId('broker-foreign-sum')).toHaveText('+1,999,999,998');
  expect((await metrics(page)).positions).toEqual(before.positions);
  await expect(page.getByTestId('cursor-marker')).toHaveCount(4);
  await page.getByTestId('broker-sell-divider').hover();
  await expect(page.getByTestId('cursor-marker')).toHaveCount(0);
  expect((await metrics(page)).positions).toEqual(before.positions);
  expect(await page.getByTestId('broker-row').locator('[title]').allTextContents()).toEqual(names);
});

test('long figures scroll without clipping names, badges, plots or the total', async ({ page }) => {
  await mount(page, true);
  await resize(page, 200);
  await page.evaluate(async () => {
    const path = '/tests/e2e/helpers/brokerLayoutHarness.tsx';
    const harness = await import(path);
    harness.setCursor(harness.open + 300000);
  });
  const sample = await metrics(page);
  expect(sample.scroll).toBe(true);
  expect(sample.fits).toBe(true);
  expect(sample.positions[0][1].width).toBeGreaterThanOrEqual(64);
  await expect(page.getByTestId('broker-foreign-badge')).toHaveCount(2);
  await expect(page.getByTestId('broker-foreign-sum')).toHaveText('+19,999,999,980,000');
  await page.getByRole('region', { name: '거래원 목록' }).evaluate(el => { el.scrollLeft = el.scrollWidth; });
  await expect(page.getByTestId('broker-foreign-sum')).toBeInViewport();
  const after = await metrics(page);
  expect(after.positions[0][2].right).toBe(after.footerRight);
});

test('the foreign total stays at the viewport floor while a long list scrolls', async ({ page }) => {
  await mount(page, false, true);
  await resize(page, 320);
  const region = page.getByRole('region', { name: '거래원 목록' });
  await expect(page.getByRole('button', { name: '거래원 더 보기 ↓' })).toBeVisible();
  const before = await metrics(page);
  expect(before.footerBottom).toBeCloseTo(before.viewportBottom, 1);
  await region.evaluate(el => { el.scrollTop = el.scrollHeight; });
  await expect(page.getByRole('button', { name: '거래원 더 보기 ↓' })).toHaveCount(0);
  const after = await metrics(page);
  expect(after.footerBottom).toBeCloseTo(after.viewportBottom, 1);
  expect(after.positions[0][2].right).toBe(after.footerRight);
});
