import { expect, test, type Page } from '@playwright/test';

async function mount(page: Page, large = false) {
  await page.setViewportSize({ width: 1200, height: 600 });
  await page.route(url => url.pathname === '/', route => route.fulfill({ contentType: 'text/html',
    body: '<html><body style="margin:0"><script>window.$RefreshSig$=()=>type=>type;window.$RefreshReg$=()=>{};window.__vite_plugin_react_preamble_installed=true;</script></body></html>',
  }));
  await page.goto('/');
  await page.evaluate(async large => {
    const path = '/tests/e2e/helpers/programLayoutHarness.tsx';
    const harness = await import(path);
    harness.mount(large);
    await document.fonts.ready;
  }, large);
  await expect(page.getByRole('table')).toBeVisible();
}

async function resize(page: Page, width: number) {
  await page.locator('.live-window').evaluate((host, width) => { (host as HTMLElement).style.width = `${width}px`; }, width);
}

async function dailyMetrics(page: Page) {
  return page.getByRole('table').evaluate(table => {
    const rows = Array.from(table.querySelectorAll('tbody tr, tfoot tr'));
    const fits = Array.from(table.querySelectorAll('th, td')).every(cell => {
      const box = cell.getBoundingClientRect(), css = getComputedStyle(cell);
      const range = document.createRange(); range.selectNodeContents(cell);
      const text = range.getBoundingClientRect();
      return text.left >= box.left + parseFloat(css.paddingLeft) - 1
        && text.right <= box.right - parseFloat(css.paddingRight) + 1;
    });
    const scroller = table.closest('[aria-label="일별 프로그램 내역"]')!;
    return { fits, scroll: scroller.scrollWidth > scroller.clientWidth + 1,
      heights: rows.map(row => row.getBoundingClientRect().height),
      cells: rows.map(row => row.children.length),
      right: rows.map(row => Array.from(row.querySelectorAll('td')).map(cell => cell.getBoundingClientRect().right)),
      textEdges: rows.map(row => Array.from(row.querySelectorAll('td')).map(cell => {
        const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
        const nodes: Node[] = [];
        while (walker.nextNode()) if (walker.currentNode.textContent?.trim()) nodes.push(walker.currentNode);
        const range = document.createRange();
        range.setStart(nodes[0], 0);
        const last = nodes[nodes.length - 1];
        range.setEnd(last, last.textContent!.length);
        return { textRight: range.getBoundingClientRect().right,
          cellRight: cell.getBoundingClientRect().right - parseFloat(getComputedStyle(cell).paddingRight) };
      })),
      font: getComputedStyle(rows[0].children[1]).fontSize };
  });
}

test('daily program keeps one row and shares aligned columns across dates and totals', async ({ page }, info) => {
  await mount(page);
  const samples = [];
  for (const width of [720, 560, 400, 320, 720]) {
    await resize(page, width);
    await expect(page.locator('tbody th').first()).toHaveCSS('min-width', width < 480 ? '48px' : width < 640 ? '56px' : '72px');
    await expect(page.locator('tbody td').first()).toHaveCSS('padding-right', width < 640 ? '1px' : '4px');
    const sample = await dailyMetrics(page);
    expect(sample.fits).toBe(true);
    expect(sample.scroll).toBe(false);
    expect(sample.cells).toEqual([4, 4, 4, 4]);
    for (const row of sample.right) expect(row).toEqual(sample.right[0]);
    samples.push(sample);
    if (width === 320) await page.screenshot({ path: info.outputPath('program-daily-320.png') });
  }
  for (const sample of samples) {
    expect(sample.heights).toEqual(samples[0].heights);
    expect(sample.font).toBe(samples[0].font);
  }
  await page.getByRole('button', { name: '금액', exact: true }).click();
  for (const width of [720, 560, 400, 320]) {
    await resize(page, width);
    for (const display of ['모두', '순매수', '총매수', '총매도']) {
      await page.getByRole('button', { name: display, exact: true }).click();
      const sample = await dailyMetrics(page);
      expect(sample.fits).toBe(true);
      expect(sample.scroll).toBe(false);
      expect(sample.textEdges).toHaveLength(4);
      for (const row of sample.textEdges) {
        expect(row).toHaveLength(display === '모두' ? 3 : 1);
        for (const cell of row) expect(cell.textRight).toBeCloseTo(cell.cellRight, 1);
      }
      if (display === '모두') await page.screenshot({ path: info.outputPath(`program-daily-amount-${width}.png`) });
    }
  }
  await info.attach('resize-metrics', { body: JSON.stringify(samples), contentType: 'application/json' });
});

test('intraday values stay complete as the window narrows', async ({ page }, info) => {
  await mount(page);
  await page.getByRole('button', { name: '당일 누적', exact: true }).click();
  const samples = [];
  for (const width of [720, 560, 400, 320]) {
    await resize(page, width);
    await expect(page.locator('.program-metric').nth(1)).toHaveCSS('padding-left', width < 480 ? '1px' : width < 640 ? '4px' : '8px');
    const sample = await page.getByLabel('프로그램 누적 요약').evaluate(scroller => ({
      scroll: scroller.scrollWidth > scroller.clientWidth + 1,
      values: Array.from(scroller.querySelectorAll('.program-metric > span:last-child')).map(el => ({
        fits: el.scrollWidth <= el.clientWidth + 1,
        overflow: getComputedStyle(el).overflow,
        font: getComputedStyle(el).fontSize,
        text: el.textContent,
      })),
    }));
    expect(sample.scroll).toBe(false);
    expect(sample.values).toHaveLength(3);
    for (const value of sample.values) {
      expect(value.fits).toBe(true);
      expect(value.overflow).toBe('visible');
    }
    samples.push(sample);
  }
  for (const sample of samples) expect(sample.values).toEqual(samples[0].values);
  await expect(page.getByTestId('program-metric-strip')).toContainText('-123,456,789');
  await page.screenshot({ path: info.outputPath('program-intraday-320.png') });
});

test('long raw values scroll without clipping while date and chart remain in place', async ({ page }) => {
  await mount(page, true);
  await resize(page, 280);
  await page.getByRole('button', { name: 'K 단위', exact: true }).click();
  const sample = await dailyMetrics(page);
  expect(sample.fits).toBe(true);
  expect(sample.scroll).toBe(true);
  await expect(page.getByRole('table')).toContainText('-1,234,567,890,000');
  const date = page.locator('tbody th').first();
  const left = (await date.boundingBox())!.x;
  await page.getByLabel('일별 프로그램 내역').evaluate(el => { el.scrollLeft = el.scrollWidth; });
  expect((await date.boundingBox())!.x).toBeCloseTo(left, 1);
  await page.getByRole('button', { name: '당일 누적', exact: true }).click();
  await expect(page.getByTestId('program-metric-strip')).toContainText('-1,234,567,890,000');
  const metrics = await page.getByLabel('프로그램 누적 요약').evaluate(el => ({
    scroll: el.scrollWidth > el.clientWidth + 1,
    contentScroll: el.closest('.program-trade-content')!.scrollWidth > el.closest('.program-trade-content')!.clientWidth + 1,
    fits: Array.from(el.querySelectorAll('.program-metric > span:last-child')).every(value => value.scrollWidth <= value.clientWidth + 1),
  }));
  expect(metrics).toEqual({ scroll: true, contentScroll: false, fits: true });
  await page.getByLabel('프로그램 누적 요약').evaluate(el => { el.scrollLeft = el.scrollWidth; });
  await expect(page.getByTestId('program-metric-strip').getByText('1,469,135,780,000', { exact: true })).toBeInViewport();
});
