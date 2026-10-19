import { test, expect, type Page } from '@playwright/test';

async function mount(page: Page, width: number, amount = false, large = false) {
  await page.setViewportSize({ width: 1200, height: 600 });
  await page.route(url => url.pathname === '/', route => route.fulfill({ contentType: 'text/html',
    body: '<html><body style="margin:0"><script>window.$RefreshSig$=()=>type=>type;window.$RefreshReg$=()=>{};window.__vite_plugin_react_preamble_installed=true;</script></body></html>',
  }));
  await page.goto('/');
  await page.evaluate(async args => {
    const path = '/tests/e2e/helpers/investorDailyLayoutHarness.tsx';
    const harness = await import(path);
    harness.mount(args.width, args.amount, args.large);
    await document.fonts.ready;
  }, { width, amount, large });
  await expect(page.getByRole('table')).toBeVisible();
}

async function expectNumbersFit(page: Page) {
  const overflow = await page.getByRole('table').evaluate(table =>
    Array.from(table.querySelectorAll('tbody td, tfoot td')).some(cell => {
      const box = cell.getBoundingClientRect(), css = getComputedStyle(cell);
      const range = document.createRange();
      range.selectNodeContents(cell);
      const text = range.getBoundingClientRect();
      return text.left < box.left + parseFloat(css.paddingLeft) - 1
        || text.right > box.right - parseFloat(css.paddingRight) + 1;
    }));
  expect(overflow).toBe(false);
}

async function setting(page: Page, name: string) {
  const button = page.getByRole('button', { name, exact: true });
  if (await button.count() === 0) await page.getByRole('button', { name: '표시 설정', exact: true }).click();
  await button.click();
  const close = page.getByRole('button', { name: '표시 설정 닫기', exact: true });
  if (await close.count()) await close.click();
}

for (const width of [320, 560, 1000]) {
  test(`daily investor columns align in all views at ${width}px`, async ({ page }, info) => {
    await mount(page, width);
    const table = page.getByRole('table');
    await expect(table.locator('thead th').first()).toHaveCSS('text-align', 'left');
    await expect(table.locator('tfoot th').first()).toHaveCSS('text-align', 'left');
    const positions = await table.evaluate(el => Array.from(el.querySelectorAll('tbody tr, tfoot tr'))
      .map(row => Array.from(row.querySelectorAll('td span[title]')).map(n => n.getBoundingClientRect().right)));
    expect(positions[0]).toHaveLength(12);
    for (const row of positions) row.forEach((x, i) => expect(x).toBeCloseTo(positions[0][i], 1));
    await expectNumbersFit(page);
    await setting(page, '순매수');
    const columns = await table.locator('thead').getByRole('columnheader').evaluateAll(headers => headers.map(h => h.getBoundingClientRect().width));
    expect(columns).toHaveLength(5);
    expect(columns[0]).toBe(80);
    columns.slice(1).forEach(w => expect(w).toBeCloseTo(columns[1], 1));
    if (width === 560) expect(columns[1]).toBe(120);
    await expectNumbersFit(page);
    await setting(page, '기관 상세 펼치기');
    await expect(table.locator('thead').getByRole('columnheader')).toHaveCount(13);
    const padding = await table.locator('tbody tr').first().evaluate(row => {
      const cells = row.querySelectorAll('td');
      return [getComputedStyle(cells[3]).paddingRight, getComputedStyle(cells[4]).paddingLeft];
    });
    expect(padding).toEqual(['8px', '16px']);
    await expectNumbersFit(page);
    const date = table.locator('tbody th').first();
    const left = (await date.boundingBox())!.x;
    await page.getByLabel('일별 투자자 내역').evaluate(el => { el.scrollLeft = el.scrollWidth; });
    expect((await date.boundingBox())!.x).toBeCloseTo(left, 1);
    await page.screenshot({ path: info.outputPath('daily-details.png') });
  });
}

test('amount decimal slots align through body and cumulative rows', async ({ page }, info) => {
  await mount(page, 1000, true);
  for (const display of ['모두', '순매수'] as const) {
    await setting(page, display);
    const slots = await page.getByRole('table').evaluate(table => Array.from(table.querySelectorAll('tbody tr, tfoot tr'))
      .map(row => Array.from(row.querySelectorAll('td .inline-grid > span')).map(span => span.getBoundingClientRect().left)));
    expect(slots[0].length).toBe(display === '모두' ? 12 : 4);
    for (const row of slots) row.forEach((x, i) => expect(x).toBeCloseTo(slots[0][i], 1));
    await expectNumbersFit(page);
  }
  await page.screenshot({ path: info.outputPath('daily-amounts.png') });
});

test('long raw quantities and cumulative totals keep their reserved tracks', async ({ page }) => {
  await mount(page, 560, false, true);
  await setting(page, 'K 단위');
  await expectNumbersFit(page);
  const scrolling = await page.getByLabel('일별 투자자 내역').evaluate(el => el.scrollWidth > el.clientWidth);
  expect(scrolling).toBe(true);
  await setting(page, '순매수');
  await expectNumbersFit(page);
  await setting(page, '기관 상세 펼치기');
  await expectNumbersFit(page);
});
