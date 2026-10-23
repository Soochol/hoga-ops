import { readFile } from 'node:fs/promises';
import { test, expect } from '@playwright/test';
import { installLiveMocks } from './helpers/liveMocks';
import { apiPrefix } from './helpers/apiRoutes';

test('chart toolbar icon buttons save a rendered PNG and copy an image to the clipboard', async ({ page, context }, testInfo) => {
  await page.setViewportSize({ width: 2000, height: 900 });
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await installLiveMocks(page);
  await page.route(apiPrefix('live/past-daily-candles'), route => route.fulfill({ json: {
    code: '098460', from: '20260501', to: '20260528', cached_batches: [], fresh_batches: [], data_warnings: [],
    candles: Array.from({ length: 20 }, (_, i) => ({ t_ms: Date.UTC(2026, 4, 1 + i),
      open: 35000 + i * 50, high: 35200 + i * 50, low: 34900 + i * 50,
      close: 35000 + i * 50 + (i % 2 ? -50 : 100), volume: 100 + i * 10 })),
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
  const chart = page.getByTestId('live-chart-root');
  await expect(chart.locator('.legend-ohlc-open')).toBeVisible();
  const toolbar = page.getByTestId('chart-window-header');
  const copyButton = toolbar.getByRole('button', { name: '차트 이미지 복사', exact: true });
  const saveButton = toolbar.getByRole('button', { name: 'PNG로 저장', exact: true });
  await expect(copyButton).toBeVisible();
  await expect(saveButton).toBeVisible();
  await expect(toolbar.getByRole('button', { name: '차트 메뉴', exact: true })).toHaveCount(0);
  await expect(toolbar.locator('.live-action-label')).toHaveCount(0);
  for (const button of [copyButton, saveButton, toolbar.getByRole('button', { name: '보조지표', exact: true })]) {
    await expect(button).toHaveText('');
    await expect(button).toHaveAttribute('data-tooltip', /.+/);
  }
  await expect(toolbar.getByRole('button', { name: '그리기', exact: true })).not.toContainText('그리기');
  const indicatorBounds = await toolbar.getByRole('button', { name: '보조지표', exact: true }).boundingBox();
  const copyBounds = await copyButton.boundingBox();
  expect(copyBounds!.x).toBeGreaterThan(indicatorBounds!.x);
  expect(copyBounds!.y).toBe(indicatorBounds!.y);
  await chart.click({ button: 'right', position: { x: 160, y: 120 } });
  await expect(page.getByRole('menu', { name: '캔들 차트' })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('chart-toolbar-icons.png') });
  const downloadPromise = page.waitForEvent('download');
  await saveButton.click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^chart_098460_D_\d{8}_\d{6}\.png$/);
  const imagePath = testInfo.outputPath('chart-export.png');
  await download.saveAs(imagePath);
  const png = await readFile(imagePath);
  expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  const viewport = await chart.evaluate(el => ({ width: el.clientWidth, height: el.clientHeight, scale: Math.min(devicePixelRatio, 2) }));
  expect(png.readUInt32BE(16)).toBe(Math.round(viewport.width * viewport.scale));
  expect(png.readUInt32BE(20)).toBe(Math.round(viewport.height * viewport.scale));
  expect(png.length).toBeGreaterThan(5000);
  await expect(page.getByRole('menu', { name: '캔들 차트' })).toHaveCount(0);

  await copyButton.click();
  await expect(page.getByText('차트 이미지를 복사했습니다', { exact: true })).toBeVisible();
  const clipboard = await page.evaluate(async () => {
    const items = await navigator.clipboard.read();
    const image = await items[0].getType('image/png');
    const bitmap = await createImageBitmap(image);
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(bitmap, 0, 0);
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const colors = new Set<string>();
    for (let i = 0; i < data.length; i += 4) colors.add(`${data[i]},${data[i + 1]},${data[i + 2]}`);
    return { width: bitmap.width, height: bitmap.height, colors: colors.size };
  });
  expect(clipboard.width).toBe(Math.round(viewport.width * viewport.scale));
  expect(clipboard.height).toBe(Math.round(viewport.height * viewport.scale));
  expect(clipboard.colors).toBeGreaterThan(30);
});
