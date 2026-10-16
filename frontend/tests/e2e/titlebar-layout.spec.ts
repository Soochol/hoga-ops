import { test, expect } from '@playwright/test';

for (const width of [320, 500, 700, 1000]) {
  test(`chart header keeps its columns during historical loading at ${width}px`, async ({ page }, info) => {
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
        result.push(Object.fromEntries(['current-price', 'change', 'heatmap-group'].map(name => {
          const el = document.querySelector(`[data-testid="titlebar-${name}"]`)!;
          const box = el.getBoundingClientRect();
          return [name, { x: box.x, width: box.width, visible: getComputedStyle(el).display !== 'none' }];
        })));
      }
      header.update('20260501', 1551000, 29.99);
      await frame();
      return result;
    }, width);
    await info.attach('header-positions', { body: JSON.stringify(samples), contentType: 'application/json' });
    for (const sample of samples) expect(sample).toEqual(samples[0]);
    await expect(page.getByTestId('titlebar-current-price')).toHaveText('1,551,000');
    await expect(page.getByTestId('past-backfill-progress-chip')).toBeVisible();
    await expect(page.getByTestId('past-backfill-progress-chip')).toHaveAttribute('title', /05\/01까지 로드됨/);
    for (const name of ['titlebar-current-price', 'titlebar-change', 'past-backfill-progress-chip']) {
      const fits = await page.getByTestId(name).evaluate(el => el.scrollWidth <= el.clientWidth);
      expect(fits, `${name} must fit its reserved slot`).toBe(true);
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
