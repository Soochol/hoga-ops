import { expect, test, type Page } from '@playwright/test';

async function mount(page: Page) {
  await page.setViewportSize({ width: 1200, height: 600 });
  await page.route(url => url.pathname === '/', route => route.fulfill({ contentType: 'text/html',
    body: '<html><body style="margin:0"><script>window.$RefreshSig$=()=>type=>type;window.$RefreshReg$=()=>{};window.__vite_plugin_react_preamble_installed=true;</script></body></html>',
  }));
  await page.goto('/');
  await page.evaluate(async () => {
    const path = '/tests/e2e/helpers/programTapeLayoutHarness.tsx';
    const harness = await import(path);
    harness.mount();
    await document.fonts.ready;
  });
  await expect(page.getByRole('table')).toBeVisible();
}

async function resize(page: Page, width: number) {
  await page.locator('.live-window').evaluate((host, width) => { (host as HTMLElement).style.width = `${width}px`; }, width);
}

async function update(page: Page, mode: 'normal' | 'large' | 'small' | 'empty', scope = 'same') {
  await page.evaluate(async args => {
    const path = '/tests/e2e/helpers/programTapeLayoutHarness.tsx';
    const harness = await import(path);
    harness.render(args.mode, args.scope);
  }, { mode, scope });
}

async function metrics(page: Page) {
  return page.getByRole('table').evaluate(table => {
    const rows = Array.from(table.querySelectorAll('[role="row"]'));
    const positions = rows.map(row => Array.from(row.children).map(cell => {
      const box = cell.getBoundingClientRect();
      const range = document.createRange(); range.selectNodeContents(cell);
      const text = range.getBoundingClientRect();
      return { left: box.left, right: box.right, width: box.width, textRight: text.right,
        fits: text.left >= box.left - 1 && text.right <= box.right + 1 };
    }));
    const scroller = table.closest('[aria-label="프로그램 체결 목록"]')!;
    return { positions, scroll: scroller.scrollWidth > scroller.clientWidth + 1,
      heights: rows.slice(1).map(row => row.getBoundingClientRect().height),
      font: getComputedStyle(rows[1]).fontSize };
  });
}

test('program tape shares responsive columns for the header, prices and signed changes', async ({ page }, info) => {
  await mount(page);
  const samples = [];
  for (const width of [720, 560, 400, 320, 720]) {
    await resize(page, width);
    await expect(page.getByRole('table')).toHaveCSS('column-gap', width < 480 ? '2px' : width < 640 ? '4px' : '8px');
    const sample = await metrics(page);
    expect(sample.scroll).toBe(false);
    expect(sample.positions).toHaveLength(4);
    for (const row of sample.positions) {
      expect(row).toHaveLength(3);
      expect(row[0].width).toBe(width < 480 ? 52 : width < 640 ? 56 : 64);
      for (const cell of row) expect(cell.fits).toBe(true);
      for (const i of [1, 2]) {
        expect(row[i].right).toBe(sample.positions[0][i].right);
        expect(row[i].textRight).toBeCloseTo(sample.positions[0][i].textRight, 1);
      }
    }
    await expect(page.getByRole('cell', { name: '09:00:02' })).toBeVisible();
    await expect(page.getByRole('cell', { name: '—', exact: true })).toBeVisible();
    samples.push(sample);
    if (width === 320) await page.screenshot({ path: info.outputPath('program-tape-320.png') });
  }
  for (const sample of samples) {
    expect(sample.heights).toEqual(samples[0].heights);
    expect(sample.font).toBe(samples[0].font);
  }
  await info.attach('resize-metrics', { body: JSON.stringify(samples), contentType: 'application/json' });
});

test('a signed change keeps its reserved width through eviction and empty data until remount', async ({ page }) => {
  await mount(page);
  await resize(page, 200);
  await update(page, 'large');
  const large = await metrics(page);
  expect(large.scroll).toBe(true);
  await update(page, 'small');
  expect((await metrics(page)).positions[1].map(cell => cell.width)).toEqual(large.positions[1].map(cell => cell.width));
  await update(page, 'empty');
  await expect(page.getByText('새 수신 대기')).toBeVisible();
  await update(page, 'small');
  expect((await metrics(page)).positions[1].map(cell => cell.width)).toEqual(large.positions[1].map(cell => cell.width));
  await update(page, 'small', 'another-scope');
  expect((await metrics(page)).positions[1][2].width).toBeLessThan(large.positions[1][2].width);
});

test('long positive and negative changes scroll without clipping either sign', async ({ page }) => {
  await mount(page);
  await resize(page, 180);
  await update(page, 'large');
  const sample = await metrics(page);
  expect(sample.scroll).toBe(true);
  for (const row of sample.positions) for (const cell of row) expect(cell.fits).toBe(true);
  await page.getByLabel('프로그램 체결 목록').evaluate(el => { el.scrollLeft = el.scrollWidth; });
  for (const value of ['+1,234,567,890,123', '−1,234,567,890,123']) {
    await expect(page.getByRole('cell', { name: value, exact: true })).toBeInViewport();
  }
  const after = await metrics(page);
  expect(after.positions[1][2].right).toBe(after.positions[0][2].right);
});
