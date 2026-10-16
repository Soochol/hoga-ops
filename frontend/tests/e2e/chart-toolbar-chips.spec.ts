import { test, expect } from '@playwright/test';

for (const width of [320, 1000]) {
  for (const fontSize of [16, 20]) {
    test(`chart badges match timeframe height at ${width}px / root ${fontSize}px`, async ({ page }, info) => {
      await page.route(url => url.pathname === '/', route => route.fulfill({ contentType: 'text/html',
        body: '<html><body style="margin:0"><script>window.$RefreshSig$=()=>type=>type;window.$RefreshReg$=()=>{};window.__vite_plugin_react_preamble_installed=true;</script></body></html>',
      }));
      await page.goto('/');
      await page.evaluate(async ({ width, fontSize }) => {
        const path = '/tests/e2e/helpers/chartToolbarChipsHarness.tsx';
        const { mount } = await import(path);
        document.documentElement.style.fontSize = `${fontSize}px`;
        mount(width);
        await document.fonts.ready;
      }, { width, fontSize });
      const group = page.getByRole('group', { name: 'LiveTimeframe' });
      const reference = (await group.boundingBox())!;
      for (const id of ['live-viewed-date-chip', 'live-saved-range-chip', 'live-minute-jump-chip']) {
        const chip = page.getByTestId(id);
        const box = (await chip.boundingBox())!;
        expect(box.height).toBe(reference.height);
        const close = (await chip.getByRole('button').boundingBox())!;
        expect(close.y + close.height / 2).toBeCloseTo(box.y + box.height / 2, 1);
        expect(close.height).toBeLessThanOrEqual(box.height);
        expect(box.x + box.width).toBeLessThanOrEqual(width);
        if (width === 1000) expect(box.y).toBe(reference.y);
      }
      await page.screenshot({ path: info.outputPath('aligned-badges.png') });
      for (const name of ['최근 시각으로 돌아가기', '저장뷰 기간 표시 해제', '기간 점프 해제']) {
        await page.getByRole('button', { name, exact: true }).click();
      }
      await expect(page.locator('.live-chart-state-chip')).toHaveCount(0);
      await expect(group).toBeVisible();
    });
  }
}
