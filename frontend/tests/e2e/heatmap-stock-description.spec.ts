import { test, expect } from '@playwright/test';
import descriptions from '../../src/heatmap/stockDescriptions.json' with { type: 'json' };
import { installLiveMocks } from './helpers/liveMocks';
import { apiExact } from './helpers/apiRoutes';

test.beforeEach(async ({ page }) => {
  await page.routeWebSocket(/\/api\/ws/, () => {});
  await installLiveMocks(page);
  await page.route(apiExact('heatmap'), route => route.fulfill({ json: {
    folders: [
      { id: 'f_0000000a', name: '로봇-대형주', order: 0 },
      { id: 'f_0000000b', name: 'AI데이터센터-냉각', order: 1 },
    ],
    entries: [
      { code: '066570', name: 'LG전자', folder_id: 'f_0000000a', order: 0 },
      { code: '0158S0', name: '엘리스', folder_id: 'f_0000000a', order: 1 },
      { code: '066570', name: 'LG전자', folder_id: 'f_0000000b', order: 0 },
      { code: '031980', name: '피에스케이홀딩스', folder_id: 'f_0000000b', order: 1 },
    ], capture_markers: { '066570': '20261022' }, next_run_at_ms: 0,
  } }));
});

for (const width of [1440, 600]) {
  test(`stock-name hover shares prose and fits the viewport at ${width}px`, async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setViewportSize({ width, height: 700 });
    await page.goto('/heatmap');
    const main = page.getByTestId('heatmap-page-primary');
    const first = main.getByTestId('heatmap-row-066570').first();
    const name = first.getByText('LG전자', { exact: true });
    const before = await first.boundingBox();
    await name.hover();
    const tooltip = page.getByRole('tooltip');
    await expect(tooltip).toBeVisible();
    await expect(tooltip).toHaveClass(/tooltip-surface/);
    await expect(tooltip).toHaveCSS('padding', '6px 10px');
    await expect(tooltip).toHaveCSS('border-radius', '6px');
    await expect(tooltip).toContainText('가전·전장·냉난방공조');
    await expect(first).toHaveAttribute('aria-describedby', await tooltip.getAttribute('id') as string);
    expect(await first.boundingBox()).toEqual(before);
    const prose = await tooltip.getByTestId('stock-description-lines').innerText();
    await page.keyboard.press('Escape');
    await expect(tooltip).toHaveCount(0);
    const second = main.getByTestId('heatmap-row-066570').last();
    await second.getByText('LG전자', { exact: true }).hover();
    await expect(tooltip).toBeVisible();
    await expect(tooltip.getByTestId('stock-description-lines')).toHaveText(prose.replaceAll('\n', ''));
    await expect(tooltip).toHaveCount(1);

    // Measure every authored entry with the real font, width and line-height.
    const tooLong = await tooltip.getByTestId('stock-description-lines').evaluate((element, catalogue) => {
      const probe = element.cloneNode(false) as HTMLElement;
      probe.style.visibility = 'hidden';
      probe.style.position = 'absolute';
      probe.style.width = `${element.getBoundingClientRect().width}px`;
      element.parentElement!.append(probe);
      const lineHeight = parseFloat(getComputedStyle(element).lineHeight);
      const failures: string[] = [];
      for (const [code, item] of Object.entries(catalogue)) {
        probe.replaceChildren(...item.lines.map(text => { const div = document.createElement('div'); div.textContent = text; return div; }));
        if (probe.getBoundingClientRect().height > lineHeight * 3 + 1) failures.push(`${code} ${item.name}`);
      }
      probe.remove();
      return failures;
    }, descriptions);
    expect(tooLong).toEqual([]);
    const box = await tooltip.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(8);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width - 8);
    expect(box!.y + box!.height).toBeLessThanOrEqual(692);
    await page.screenshot({ path: testInfo.outputPath('company-tooltip.png') });
    await page.mouse.move(0, 0);
    await expect(tooltip).toHaveCount(0);
    await main.getByTestId('heatmap-row-0158S0').getByText('엘리스', { exact: true }).hover();
    await expect(tooltip).toContainText('0158S0');
    await expect(tooltip).toContainText('GPU 인프라');
    await page.getByTestId('heatmap-board').dispatchEvent('scroll');
    await expect(tooltip).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}

test('keyboard access and edge placement preserve chart navigation', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 700 });
  await page.goto('/heatmap');
  const row = page.getByTestId('heatmap-page-primary').getByTestId('heatmap-row-031980');
  await row.focus();
  const tooltip = page.getByRole('tooltip');
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toContainText('디스컴 세정');
  await page.keyboard.press('Escape');
  await expect(tooltip).toHaveCount(0);
  await row.evaluate(element => { element.style.position = 'fixed'; element.style.right = '0'; element.style.bottom = '0'; });
  await row.getByText('피에스케이홀딩스', { exact: true }).hover();
  await expect(tooltip).toBeVisible();
  const anchor = await row.boundingBox();
  const box = await tooltip.boundingBox();
  expect(box!.y + box!.height).toBeLessThanOrEqual(anchor!.y);
  expect(box!.x + box!.width).toBeLessThanOrEqual(1432);
  await row.dispatchEvent('pointerdown');
  await expect(tooltip).toHaveCount(0);
  await row.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/live/);
  await expect(page.getByRole('tooltip')).toHaveCount(0);
});
