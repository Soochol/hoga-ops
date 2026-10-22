import { test, expect } from '@playwright/test';

for (const width of [320, 500]) {
  for (const kind of ['book', 'order'] as const) {
    test(`${kind} header keeps venue badges readable at ${width}px`, async ({ page }, info) => {
      await page.route(url => url.pathname === '/', route => route.fulfill({
        contentType: 'text/html',
        body: '<html><body style="margin:0"><script>window.$RefreshSig$=()=>type=>type;window.$RefreshReg$=()=>{};window.__vite_plugin_react_preamble_installed=true;</script></body></html>',
      }));
      await page.goto('/');
      await page.evaluate(async ({ width, kind }) => {
        const path = '/tests/e2e/helpers/titlebarLayoutHarness.tsx';
        const { mount } = await import(path);
        mount(width, kind, false);
        await document.fonts.ready;
      }, { width, kind });
      await expect(page.getByLabel('KRX 거래 지원', { exact: true })).toHaveCount(0);
      const nxt = page.getByLabel('NXT 거래 미지원', { exact: true });
      await expect(nxt).toHaveText('NXT 미지원');
      await expect.poll(() => nxt.evaluate(el => {
        const badge = el.getBoundingClientRect();
        const title = el.closest('.live-data-title')!.getBoundingClientRect();
        return badge.left >= title.left && badge.right <= title.right + 1;
      })).toBe(true);
      await expect(page.getByRole('button', { name: 'NXT', exact: true })).toHaveCount(0);
      const maximize = page.getByRole('button', { name: '창 최대화', exact: true });
      await expect(maximize).toBeVisible();
      await page.screenshot({ path: info.outputPath(`${kind}-venue-support.png`) });
    });
  }
}

for (const width of [320, 500, 700, 1000]) {
  test(`chart header keeps quote spacing and metadata position at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width: 1200, height: 500 });
    await page.route(url => url.pathname === '/', route => route.fulfill({
      contentType: 'text/html',
      body: '<html><body style="margin:0"><script>window.$RefreshSig$=()=>type=>type;window.$RefreshReg$=()=>{};window.__vite_plugin_react_preamble_installed=true;</script></body></html>',
    }));
    await page.goto('/');
    const samples = await page.evaluate(async width => {
      const path = '/tests/e2e/helpers/titlebarLayoutHarness.tsx';
      const { mount } = await import(path);
      const header = mount(width);
      await document.fonts.ready;
      const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      const result = [];
      for (const [date, price, pct] of [
        [null, null, null], ['20260909', 9999, 0], ['20261010', 10000, -10.5],
        ['20260501', 1551000, 29.99], [null, null, null],
      ] as const) {
        header.update(date, price, pct);
        await frame();
        const identity = document.querySelector('.live-symbol-identity')!.getBoundingClientRect();
        const cells = Object.fromEntries(['current-price', 'change', 'heatmap-group'].map(name => {
          const el = document.querySelector(`[data-testid="titlebar-${name}"]`)!;
          const box = el.getBoundingClientRect();
          return [name, { x: box.x, right: box.right, width: box.width, visible: getComputedStyle(el).display !== 'none' }];
        }));
        result.push({ identityRight: identity.right, cells });
      }
      header.update('20260501', 1551000, 29.99);
      await frame();
      return result;
    }, width);
    await info.attach('header-positions', { body: JSON.stringify(samples), contentType: 'application/json' });
    for (const { identityRight, cells } of samples) {
      expect(cells['heatmap-group']).toEqual(samples[0].cells['heatmap-group']);
      if (cells['current-price'].visible) {
        expect(cells['current-price'].x - identityRight).toBeCloseTo(8, 1);
      }
      if (cells.change.visible) {
        expect(cells.change.x - cells['current-price'].right).toBeCloseTo(4, 1);
      }
    }
    await expect(page.getByTestId('titlebar-current-price')).toHaveText('1,551,000');
    if (width > 320) await expect(page.getByTestId('past-backfill-progress-chip')).toBeVisible();
    else await expect(page.getByTestId('past-backfill-progress-chip')).toBeHidden();
    await expect(page.getByTestId('past-backfill-progress-chip')).not.toHaveAttribute('title');
    for (const name of ['titlebar-current-price', 'titlebar-change', 'past-backfill-progress-chip']) {
      const fits = await page.getByTestId(name).evaluate(el => el.scrollWidth <= el.clientWidth);
      expect(fits, `${name} must fit without clipping`).toBe(true);
    }
    await page.screenshot({ path: info.outputPath('header-loading.png') });
    await page.evaluate(async () => {
      const path = '/src/live/workspace/windowWarningsSource.ts';
      const { clearWindowWarnings } = await import(path);
      clearWindowWarnings('layout');
    });
    await expect(page.getByTestId('past-backfill-progress-chip')).toBeHidden();
    if (width > 760) await expect(page.getByTestId('titlebar-heatmap-group')).toBeVisible();
    else await expect(page.getByTestId('titlebar-heatmap-group')).toBeHidden();
    await page.screenshot({ path: info.outputPath('header-idle.png') });
  });
}
