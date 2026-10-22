import { expect, test } from '@playwright/test';
import descriptions from '../../src/heatmap/stockDescriptions.json' with { type: 'json' };
import { installLiveMocks } from './helpers/liveMocks';

test('캔들 차트 종목명만 공통 설명을 열고 종목 변경·드래그·닫기에는 해제한다', async ({ page }, info) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await installLiveMocks(page);
  await page.routeWebSocket(/\/api\/ws/, () => {});
  await page.addInitScript(() => {
    sessionStorage.setItem('live.workspace.v1', JSON.stringify({ schema_version: 2,
      windows: [
        { id: 'first', kind: 'chart', group: 1, chart: { timeframe: 'D' }, rect: { x: 0, y: 0, w: .5, h: .5 } },
        { id: 'second', kind: 'chart', group: 2, chart: { timeframe: 'D' }, rect: { x: .5, y: 0, w: .5, h: .5 } },
        { id: 'book', kind: 'book', group: 1, rect: { x: 0, y: .5, w: .5, h: .5 } },
      ], zOrder: ['first', 'second', 'book'],
      groupSymbols: { 1: { code: '005930', name: '삼성전자' }, 2: { code: '005930', name: '삼성전자 별칭' } },
    }));
  });
  await page.goto('/live');
  const first = page.locator('[data-win="first"]');
  const firstHeader = first.locator('.live-window-titlebar');
  const firstName = firstHeader.locator('.live-symbol-name');
  const secondName = page.locator('[data-win="second"] .live-window-titlebar .live-symbol-name');
  const tooltip = page.getByTestId('stock-description-tooltip');
  await expect(firstName).toHaveText('삼성전자');
  await expect(page.locator('.live-window-titlebar [title]')).toHaveCount(0);

  await firstName.hover();
  await expect(tooltip).toBeVisible();
  await expect(tooltip.getByTestId('stock-description-lines')).toHaveText(descriptions['005930'].lines.join(''));
  await expect(firstName).toHaveAttribute('aria-describedby', await tooltip.getAttribute('id') as string);
  await page.screenshot({ path: info.outputPath('live-company-tooltip.png') });
  await firstHeader.getByTestId('titlebar-current-price').hover();
  await expect(tooltip).toHaveCount(0);
  await firstHeader.getByRole('button', { name: '차트 설정', exact: true }).hover();
  await expect(tooltip).toHaveCount(0);
  await page.locator('[data-win="book"] .live-window-titlebar .live-symbol-name').hover();
  await expect(tooltip).toHaveCount(0);

  await secondName.hover();
  await expect(tooltip).toBeVisible();
  await expect(tooltip.getByTestId('stock-description-lines')).toHaveText(descriptions['005930'].lines.join(''));
  await expect(tooltip).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(tooltip).toHaveCount(0);

  await firstName.hover();
  await expect(tooltip).toBeVisible();
  await page.evaluate(async () => {
    const path = '/src/state/workspace.ts';
    const { useWorkspaceStore } = await import(path);
    useWorkspaceStore.getState().setWindowSymbol('first', { code: '066570', name: 'LG전자' });
  });
  await expect(firstName).toHaveText('LG전자');
  await expect(tooltip).toHaveCount(0);
  await page.mouse.move(0, 0);
  await firstName.hover();
  await expect(tooltip.getByTestId('stock-description-lines')).toHaveText(descriptions['066570'].lines.join(''));
  await page.mouse.down();
  await expect(tooltip).toHaveCount(0);
  await page.mouse.move(20, 20, { steps: 3 });
  await page.mouse.up();
  await firstName.hover();
  await expect(tooltip).toBeVisible();
  await firstHeader.getByRole('button', { name: 'LG전자 차트 창 닫기', exact: true }).click();
  await expect(first).toHaveCount(0);
  await expect(tooltip).toHaveCount(0);
});
