import { expect, test } from '@playwright/test';
import { installLiveMocks } from './helpers/liveMocks';

for (const theme of ['toss-light', 'trading-desk']) {
  for (const timeframe of ['1m', 'D']) {
    test(`${theme} ${timeframe}: 모든 지표의 그룹명 레일과 오른쪽 표시 열을 유지한다`, async ({ page }, info) => {
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.addInitScript(({ theme, timeframe }) => {
        localStorage.setItem('ui.themePreference.v1', JSON.stringify({ themePreference: theme }));
        sessionStorage.setItem('live.workspace.v1', JSON.stringify({ schema_version: 2,
          windows: [{ id: 'rail', kind: 'chart', group: 1, chart: { timeframe }, rect: { x: 0, y: 0, w: .9, h: .9 } }],
          zOrder: ['rail'], groupSymbols: { 1: { code: '098460', name: '고영' } },
        }));
      }, { theme, timeframe });
      await installLiveMocks(page);
      await page.goto('/live?code=098460');
      await page.getByTestId('live-indicators-button').click();
      const editor = page.getByTestId('indicator-panel-shell');
      await editor.getByRole('button', { name: '지표 추가', exact: true }).click();
      const names = await editor.locator('.indicator-nav-row > button:first-child').evaluateAll(buttons => buttons.map(b => b.getAttribute('aria-label')!));
      for (const name of names) {
        await editor.getByRole('button', { name, exact: true }).click();
        await expect(editor.locator('.indicator-settings-group').first()).toBeVisible();
        await expect(editor.locator('.settings-dependent > summary')).toHaveCount(0);
        await expect(async () => {
          expect(await editor.locator('.indicator-config').evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
          expect(await editor.locator('.indicator-settings-group').evaluateAll(groups => groups.every(group => {
            const label = group.querySelector('.settings-property-group-label')!.getBoundingClientRect();
            const body = group.querySelector('.settings-property-group-body')!.getBoundingClientRect();
            return label.right < body.left;
          }))).toBe(true);
          expect(await editor.locator('.indicator-line-row').evaluateAll(rows => rows.every(row => {
            const label = row.querySelector('label')!.getBoundingClientRect();
            const toggle = row.querySelector('button[role=switch]')!.getBoundingClientRect();
            return toggle.left > label.right;
          }))).toBe(true);
        }).toPass();
      }
      for (const name of ['볼린저 밴드', '거래량', '신규 거래원 등장', '당일 최대벽']) {
        await editor.getByRole('button', { name, exact: true }).click();
        await editor.locator('.indicator-config').evaluate(el => el.scrollTop = 0);
        await editor.screenshot({ path: info.outputPath(`${theme}-${timeframe}-${name}.png`) });
      }
      for (const width of [640, 390, 320]) {
        await page.setViewportSize({ width, height: 760 });
        for (const name of ['이동평균선', '볼린저 밴드', '거래량', '신규 거래원 등장', '당일 최대벽', '호가 잔량 히트맵']) {
          await editor.getByRole('button', { name, exact: true }).click();
          await expect(async () => {
            expect(await editor.locator('.indicator-config').evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
          }).toPass();
          await expect(editor.locator('.settings-editor-footer')).toBeInViewport();
        }
        await editor.screenshot({ path: info.outputPath(`${theme}-${timeframe}-${width}.png`) });
      }
    });
  }
}
