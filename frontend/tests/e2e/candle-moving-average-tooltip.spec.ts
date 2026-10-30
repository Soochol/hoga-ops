import { expect, test } from '@playwright/test';

for (const [width, theme] of [[320, 'trading-desk'], [800, 'toss-light']] as const) {
  test(`MA tooltip reads plotted values and fits ${width}px / ${theme}`, async ({ page }, info) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route(url => url.pathname === '/', route => route.fulfill({ contentType: 'text/html',
      body: '<html><body style="margin:0"><script>window.$RefreshSig$=()=>type=>type;window.$RefreshReg$=()=>{};window.__vite_plugin_react_preamble_installed=true;</script></body></html>',
    }));
    await page.goto('/');
    await page.evaluate(async ({ width, theme }) => {
      const path = '/tests/e2e/helpers/candleMovingAverageHarness.tsx';
      const { mount } = await import(path);
      mount(width, theme);
      await document.fonts.ready;
    }, { width, theme });
    const readPoint = () => page.evaluate(async () => {
      const path = '/tests/e2e/helpers/candleMovingAverageHarness.tsx';
      return (await import(path)).hoverPoint() as { x: number; y: number } | null;
    });
    await expect.poll(readPoint).not.toBeNull();
    const point = (await readPoint())!;
    await page.mouse.move(point.x, point.y);
    const tooltip = page.getByTestId('candle-tooltip');
    const rows = tooltip.getByTestId('candle-ma-row');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText('105 (+4.76%)');
    await expect(rows.nth(1)).toContainText('102 (+7.84%)');
    const bounds = (await page.getByTestId('chart-container').boundingBox())!;
    const tip = (await tooltip.boundingBox())!;
    expect(tip.x).toBeGreaterThanOrEqual(bounds.x);
    expect(tip.x + tip.width).toBeLessThanOrEqual(bounds.x + bounds.width);
    expect(tip.y).toBeGreaterThanOrEqual(bounds.y);
    expect(tip.y + tip.height).toBeLessThanOrEqual(bounds.y + bounds.height);
    await page.screenshot({ path: info.outputPath('moving-average-tooltip.png') });
    // Update the live candle without moving the pointer. Both the SMA and its
    // percentage must reflect the new close after the overlay pushes its data.
    await page.evaluate(async () => {
      const path = '/tests/e2e/helpers/candleMovingAverageHarness.tsx';
      const { update } = await import(path);
      update();
    });
    await expect(rows.nth(0)).toContainText('110 (+9.09%)');
    await expect(rows.nth(1)).toContainText('104 (+15.38%)');
    await page.mouse.move(1, 1);
    await expect(tooltip).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}
