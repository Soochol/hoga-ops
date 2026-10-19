import { test, expect, type Page } from '@playwright/test';

async function mount(page: Page, large = false) {
  await page.setViewportSize({ width: 1200, height: 600 });
  await page.route(url => url.pathname === '/', route => route.fulfill({ contentType: 'text/html',
    body: '<html><body style="margin:0"><script>window.$RefreshSig$=()=>type=>type;window.$RefreshReg$=()=>{};window.__vite_plugin_react_preamble_installed=true;</script></body></html>',
  }));
  await page.goto('/');
  await page.evaluate(async large => {
    const path = '/tests/e2e/helpers/investorEstimateLayoutHarness.tsx';
    const harness = await import(path);
    harness.mount(720, large);
    await document.fonts.ready;
  }, large);
  await expect(page.getByRole('table')).toBeVisible();
}

async function metrics(page: Page) {
  return page.getByRole('table').evaluate(table => {
    const rows = Array.from(table.querySelectorAll('tbody tr'));
    const fits = Array.from(table.querySelectorAll('th, td')).every(cell => {
      const box = cell.getBoundingClientRect(), css = getComputedStyle(cell);
      const range = document.createRange(); range.selectNodeContents(cell);
      const text = range.getBoundingClientRect();
      return text.left >= box.left + parseFloat(css.paddingLeft) - 1
        && text.right <= box.right - parseFloat(css.paddingRight) + 1;
    });
    const scroller = table.closest('[aria-label="잠정투자자 내역"]')!;
    return { fits, scroll: scroller.scrollWidth > scroller.clientWidth + 1,
      heights: rows.map(row => row.getBoundingClientRect().height),
      cells: rows.map(row => row.children.length),
      right: rows.map(row => Array.from(row.querySelectorAll('td')).slice(1).map(cell => cell.getBoundingClientRect().right)),
      font: getComputedStyle(rows[0].children[1]).fontSize };
  });
}

test('estimate columns respond to the window, keeping every round on one line', async ({ page }, info) => {
  await mount(page);
  const samples = [];
  for (const width of [720, 560, 400, 320, 720]) {
    await page.locator('.live-window').evaluate((host, width) => { (host as HTMLElement).style.width = `${width}px`; }, width);
    await expect(page.locator('tbody td').nth(1)).toHaveCSS('padding-right', width < 480 ? '1px' : width < 640 ? '4px' : '8px');
    const sample = await metrics(page);
    expect(sample.fits).toBe(true);
    expect(sample.scroll).toBe(false);
    expect(sample.cells).toEqual([4, 4, 4]);
    for (const row of sample.right) expect(row).toEqual(sample.right[0]);
    samples.push(sample);
    if (width === 400) await page.screenshot({ path: info.outputPath('estimate-fluid-400.png') });
  }
  for (const sample of samples) {
    expect(sample.heights).toEqual(samples[0].heights);
    expect(sample.font).toBe(samples[0].font);
  }
  await page.getByRole('button', { name: '금액(억원)', exact: true }).click();
  await expect(page.getByText('단위: 억원')).toBeVisible();
  await expect(page.getByRole('table')).toContainText('-5.4');
  expect((await metrics(page)).fits).toBe(true);
  await info.attach('resize-metrics', { body: JSON.stringify(samples), contentType: 'application/json' });
});

test('long raw quantities scroll at their intrinsic minimum without clipping', async ({ page }) => {
  await mount(page, true);
  await page.locator('.live-window').evaluate(host => { (host as HTMLElement).style.width = '280px'; });
  await expect(page.locator('tbody td').nth(1)).toHaveCSS('padding-right', '1px');
  const sample = await metrics(page);
  expect(sample.scroll).toBe(true);
  expect(sample.fits).toBe(true);
  await expect(page.getByRole('table')).toContainText('-1,234,567,890,000');
  await page.getByLabel('잠정투자자 내역').evaluate(el => { el.scrollLeft = el.scrollWidth; });
  await expect(page.getByRole('columnheader', { name: '합산' })).toBeInViewport();
});
