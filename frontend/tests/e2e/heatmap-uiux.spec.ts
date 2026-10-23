import { test, expect } from '@playwright/test';
import { installLiveMocks } from './helpers/liveMocks';
import { apiExact, apiPrefix } from './helpers/apiRoutes';
for (const fontSize of [16, 20]) for (const width of [1440, 800, 600]) {
  test(`heatmap single-line headers, search and collection at ${width}px / ${fontSize}px font`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await installLiveMocks(page);
    await page.route(apiPrefix('heatmap'), (route) => route.fulfill({ json: {
      version: 3,
      folders: [{ id: 'a', name: '반도체-메모리와 긴 그룹 이름', order: 0 }, { id: 'b', name: '대형주', order: 1 }],
      entries: [
        { code: '005930', name: '삼성전자', folder_id: 'a', order: 0 },
        { code: '000660', name: 'SK하이닉스', folder_id: 'a', order: 1 },
        { code: '005930', name: '삼성전자', folder_id: 'b', order: 0 },
      ], capture_markers: { '005930': '20260908', '000660': '20260907' },
    } }));
    await page.route(apiExact('heatmap/group-flow'), route => route.fulfill({ json: {
      date: '2026-10-23', bucket_ms: 300000, t_base_ms: 1792713600000,
      groups: ['a', 'b'].map(folder_id => ({ folder_id, pct: [0, 1.2, 4.5] })),
    } }));
    await page.route(apiPrefix('live/quotes'), route => route.fulfill({ json: {
      phase: 'open', quotes: ['005930', '000660'].map(code => ({ code, price: 100000, change_pct: 4.5, change_won: 4500 })),
    } }));
    await page.goto('/heatmap');
    await page.addStyleTag({ content: `:root { font-size: ${fontSize}px !important; }` });
    const main = page.getByTestId('heatmap-page-primary');
    await expect(main.getByText('3개 등록 · 2개 고유 종목', { exact: false })).toBeVisible();
    const box = await main.boundingBox();
    expect(box!.x + box!.width).toBeLessThanOrEqual(width);
    await expect(main.getByRole('button', { name: /그룹 메뉴/ })).toHaveCount(0);
    const header = main.getByRole('group', { name: '반도체-메모리와 긴 그룹 이름 그룹', exact: true });
    await expect(header).toContainText('+4.5%');
    await expect(header.locator('svg polyline')).toBeVisible();
    // The name, fixed-size sparkline and actions must share a row and fit
    // inside the header even when the long name needs ellipsis.
    const layout = await header.evaluate(node => {
      const bounds = node.getBoundingClientRect();
      const parts = [node.querySelector('[data-testid^="heatmap-folder-name-"]')!, node.querySelector('svg')!, node.lastElementChild!]
        .map(part => {
          const rect = part.getBoundingClientRect();
          return { left: rect.left, right: rect.right, centerY: (rect.top + rect.bottom) / 2 };
        });
      return { left: bounds.left, right: bounds.right, centerY: (bounds.top + bounds.bottom) / 2, parts };
    });
    for (const part of layout.parts) {
      expect(part.centerY).toBeCloseTo(layout.centerY, 0);
      expect(part.left).toBeGreaterThanOrEqual(layout.left);
      expect(part.right).toBeLessThanOrEqual(layout.right);
    }
    expect(layout.parts[0].right).toBeLessThanOrEqual(layout.parts[1].left);
    expect(layout.parts[1].right).toBeLessThanOrEqual(layout.parts[2].left);
    await page.getByTestId('heatmap-search').fill('삼성');
    await main.getByRole('button', { name: '일치 종목만' }).click();
    await expect(main.getByTestId('heatmap-row-000660')).toHaveCount(0);
    await main.getByRole('button', { name: '다음 일치 종목' }).click();
    await expect(main.getByTestId('heatmap-row-005930').first()).toBeFocused();
    await main.getByRole('button', { name: '다음 일치 종목' }).click();
    await expect(main.getByTestId('heatmap-row-005930').last()).toBeFocused();
    await expect(main.getByTestId('heatmap-folder-lag-a')).toHaveCount(0);
    await header.click({ button: 'right' });
    await page.getByRole('menuitem', { name: '보충 수집' }).click();
    await expect(page.getByRole('dialog')).toContainText('20260908');
    await expect(page.getByRole('dialog')).toContainText('SK하이닉스');
    await page.getByRole('button', { name: '취소', exact: true }).click();
    await main.getByRole('button', { name: '데이터 수집', exact: false }).click();
    await expect(page.getByRole('dialog')).toContainText('2/2개 선택');
    await page.getByRole('button', { name: '전체 해제' }).click();
    await expect(page.getByRole('button', { name: '커버리지 확인' })).toBeDisabled();
    await page.getByRole('button', { name: '취소', exact: true }).click();
    await header.focus();
    await page.keyboard.press('Shift+F10');
    await expect(page.getByRole('menuitem', { name: '그룹 이름 변경' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(header).toBeFocused();
  });
}
