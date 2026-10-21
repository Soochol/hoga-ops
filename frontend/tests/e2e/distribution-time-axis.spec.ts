import { test, expect } from '@playwright/test';
import { installLiveMocks } from './helpers/liveMocks';
import type { mount } from './helpers/distributionTimeHarness';

type HarnessWindow = Window & { distributionTime: ReturnType<typeof mount> };
for (const [firstMinute, label] of [[480, '08:00'], [540, '09:00'], [555, '09:15']] as const) {
  test(`매물대 실제 시작 ${label}: 프로그램 시간축과 정렬하고 호버 집계 중 고정한다`, async ({ page }, info) => {
    await page.setViewportSize({ width: 900, height: 720 });
    await installLiveMocks(page);
    await page.goto('/');
    await page.evaluate(async first => {
      const path = '/tests/e2e/helpers/distributionTimeHarness.tsx';
      const { mount } = await import(path);
      (window as unknown as HarnessWindow).distributionTime = mount(first);
      await document.fonts.ready;
    }, firstMinute);
    const axis = page.getByTestId('volume-distribution-time-axis');
    const programAxis = page.getByTestId('program-sparkline-time-axis');
    await expect(axis.locator('span').first()).toHaveText(label);
    await expect(axis.locator('span').last()).toHaveText('10:00');
    await expect(programAxis).toHaveText(await axis.textContent() ?? '');
    const graph = page.getByTestId('volume-distribution-close-graph');
    await expect(graph.locator('path')).toHaveAttribute('d', /^M 0\.00 .* L 100\.00 0\.00$/);
    const graphBounds = await graph.boundingBox(), axisBounds = await axis.boundingBox();
    expect(graphBounds).not.toBeNull(); expect(axisBounds).not.toBeNull();
    expect(graphBounds!.x).toBeCloseTo(axisBounds!.x, 1);
    expect(graphBounds!.width).toBeCloseTo(axisBounds!.width, 1);
    const histogram = page.getByTestId('volume-distribution-bar-window');
    const left = await histogram.evaluate(element => parseFloat(element.style.left));
    expect(left).toBeCloseTo(Math.max(0, (540 - firstMinute) / (600 - firstMinute) * 100), 4);
    const dot = await page.getByTestId('volume-distribution-close-dot').boundingBox();
    expect(dot).not.toBeNull();
    expect(dot!.x + dot!.width / 2).toBeCloseTo(graphBounds!.x + graphBounds!.width, 1);
    const labels = await axis.textContent(), path = await graph.locator('path').getAttribute('d');
    await page.evaluate(() => (window as unknown as HarnessWindow).distributionTime.hover());
    await expect(axis).toHaveText(labels ?? '');
    await expect(graph.locator('path')).toHaveAttribute('d', path!);
    await expect(page.getByTestId('volume-distribution-cursor-marker')).toBeVisible();
    await page.screenshot({ path: info.outputPath('observed-time-axis.png') });
  });
}
