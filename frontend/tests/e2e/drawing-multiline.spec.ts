import { expect, test } from '@playwright/test';
import { installLiveMocks } from './helpers/liveMocks';
import { apiPrefix } from './helpers/apiRoutes';

test('text drawing supports Shift+Enter, multiline re-editing and reload persistence', async ({ page }, testInfo) => {
  await installLiveMocks(page);
  await page.route(apiPrefix('live/past-daily-candles'), r => r.fulfill({ json: {
    code: '098460', from: '20260527', to: '20260528', cached_batches: [], fresh_batches: [], data_warnings: [],
    candles: Array.from({ length: 2 }, (_, i) => ({ t_ms: Date.UTC(2026, 4, 27 + i),
      open: 35000 + i, high: 35200 + i, low: 34900 + i, close: 35100 + i, volume: 100 })),
  } }));
  await page.goto('/live?code=098460');
  await page.evaluate(async () => {
    const path = '/src/state/workspace.ts';
    const { useWorkspaceStore: store } = await import(path);
    const chart = store.getState().windows.find((w: { kind: string }) => w.kind === 'chart');
    store.setState({ windows: [{ ...chart, rect: { x: 0, y: 0, w: 1, h: 1 }, chart: { timeframe: 'D' } }],
      zOrder: [chart.id], maximizedId: null });
    store.getState().setWindowSymbol(chart.id, { code: '098460', name: '고영', kind: 'stock' });
  });
  await expect(page.getByTestId('live-state-banner')).toBeVisible();
  const overlay = page.locator('[data-drawing-overlay]').first();
  await expect(overlay).toBeAttached();
  await expect(page.locator('.legend-ohlc-open').first()).toContainText('35');
  await page.keyboard.press('Alt+t');
  const box = (await overlay.boundingBox())!;
  const x = box.x + box.width * 0.5;
  const y = box.y + 120;
  await page.mouse.click(x, y);
  const editor = page.getByRole('textbox', { name: '텍스트 그리기' });
  await expect(editor).toBeFocused();
  await editor.pressSequentially('가나다라');
  await editor.press('Shift+Enter');
  await editor.pressSequentially('마바사아');
  await expect(editor).toHaveValue('가나다라\n마바사아');
  await page.screenshot({ path: testInfo.outputPath('multiline-editing.png') });
  await editor.press('Enter');
  await expect(editor).toHaveCount(0);
  const readText = () => page.evaluate(async () => {
    const path = '/src/state/drawings.ts';
    const { useDrawingsStore: store, drawingScopeFor } = await import(path);
    return store.getState().drawingsFor(drawingScopeFor('098460', 'D'))
      .find((d: { kind: string }) => d.kind === 'text')?.text;
  });
  await expect.poll(readText).toBe('가나다라\n마바사아');
  await page.keyboard.press('Escape');
  // Double-click the second line: its hit box must grow along with the rendering.
  await page.mouse.dblclick(x + 5, y + 20);
  await expect(editor).toHaveValue('가나다라\n마바사아');
  await editor.fill('가나다라\n\n마바사아');
  await editor.press('Enter');
  await expect.poll(readText).toBe('가나다라\n\n마바사아');
  await page.screenshot({ path: testInfo.outputPath('multiline-saved.png') });
  await expect.poll(() => page.evaluate(() => Object.values(localStorage)
    .some(value => value.includes('가나다라\\n\\n마바사아')))).toBe(true);
  await page.reload();
  await expect.poll(readText).toBe('가나다라\n\n마바사아');
});
