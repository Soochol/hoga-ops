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
    expect(columns[0]).toBe(width < 480 ? 48 : width < 640 ? 56 : 72);
    columns.slice(1).forEach(w => expect(w).toBeGreaterThan(0));
    await expectNumbersFit(page);
    await setting(page, '기관 상세 펼치기');
    await expect(table.locator('thead').getByRole('columnheader')).toHaveCount(13);
    const padding = await table.locator('tbody tr').first().evaluate(row => {
      const cells = row.querySelectorAll('td');
      return [getComputedStyle(cells[3]).paddingRight, getComputedStyle(cells[4]).paddingLeft];
    });
    expect(padding).toEqual(width < 480 ? ['1px', '1px'] : width < 640 ? ['1px', '3px'] : ['4px', '6px']);
    await expectNumbersFit(page);
    const date = table.locator('tbody th').first();
    const left = (await date.boundingBox())!.x;
    await page.getByLabel('일별 투자자 내역').evaluate(el => { el.scrollLeft = el.scrollWidth; });
    expect((await date.boundingBox())!.x).toBeCloseTo(left, 1);
    await page.screenshot({ path: info.outputPath('daily-details.png') });
  });
}

for (const width of [320, 560, 1000]) {
  test(`amount text ends align through body and cumulative rows at ${width}px`, async ({ page }, info) => {
    await mount(page, width, true);
    for (const display of ['모두', '순매수', '기관 상세 펼치기'] as const) {
      await setting(page, display);
      const rows = await page.getByRole('table').evaluate(table => Array.from(table.querySelectorAll('tbody tr, tfoot tr'))
        .map(row => Array.from(row.querySelectorAll('td')).map(cell => {
          // Measure visible text rather than a wrapper that can include an empty
          // fractional slot. Integers, decimals and zero share the same edge.
          const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
          const textNodes: Node[] = [];
          while (walker.nextNode()) if (walker.currentNode.textContent?.trim()) textNodes.push(walker.currentNode);
          if (!textNodes.length) return null;
          const range = document.createRange();
          range.setStart(textNodes[0], 0);
          const last = textNodes.at(-1)!;
          range.setEnd(last, last.textContent!.length);
          return { textRight: range.getBoundingClientRect().right,
            cellRight: cell.getBoundingClientRect().right - parseFloat(getComputedStyle(cell).paddingRight) };
        })));
      expect(rows[0]).toHaveLength(display === '모두' ? 12 : display === '순매수' ? 4 : 12);
      for (const row of rows) for (const cell of row) {
        if (cell) expect(cell.textRight).toBeCloseTo(cell.cellRight, 1);
      }
      await expectNumbersFit(page);
    }
    await page.screenshot({ path: info.outputPath('daily-amounts.png') });
  });
}

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

test('resizing the same window adjusts density and preserves one row per date', async ({ page }, info) => {
  await mount(page, 720);
  const samples = [];
  for (const width of [720, 560, 360, 720]) {
    await page.locator('.live-window').evaluate((host, width) => { (host as HTMLElement).style.width = `${width}px`; }, width);
    const expectedDate = width < 480 ? '48px' : width < 640 ? '56px' : '72px';
    await expect.poll(() => page.locator('tbody th').first().evaluate(el => getComputedStyle(el).minWidth)).toBe(expectedDate);
    const sample = await page.getByRole('table').evaluate(table => {
      const scroller = table.closest('[aria-label="일별 투자자 내역"]')!;
      return {
        rowHeights: Array.from(table.querySelectorAll('tbody tr')).map(row => row.getBoundingClientRect().height),
        cellCounts: Array.from(table.querySelectorAll('tbody tr')).map(row => row.children.length),
        font: getComputedStyle(table.querySelector('td')!).fontSize,
        padding: getComputedStyle(table.querySelector('td:nth-child(3)')!).paddingRight,
        scroll: scroller.scrollWidth > scroller.clientWidth + 1,
      };
    });
    expect(sample.cellCounts).toEqual([13, 13, 13]);
    expect(sample.padding).toBe(width < 640 ? '1px' : '4px');
    if (width >= 560) expect(sample.scroll).toBe(false);
    await expectNumbersFit(page);
    samples.push(sample);
    if (width === 560) await page.screenshot({ path: info.outputPath('daily-fluid-560.png') });
  }
  for (const sample of samples) {
    expect(sample.rowHeights).toEqual(samples[0].rowHeights);
    expect(sample.font).toBe(samples[0].font);
  }
  await info.attach('resize-density', { body: JSON.stringify(samples), contentType: 'application/json' });
});
