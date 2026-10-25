import { readFile } from 'node:fs/promises';
import { test, expect } from '@playwright/test';
import { installLiveMocks } from './helpers/liveMocks';

test('seconds shares chart tools, edits its own indicators, and restores them after reload', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.setViewportSize({ width: 1500, height: 950 });
  await installLiveMocks(page);
  await page.route('**/api/live/second-trade-dates?**', r => r.fulfill({ json: { dates: [] } }));
  await page.route('**/api/live/second-aggregates?**', r => {
    const params = new URL(r.request().url()).searchParams;
    const date = params.get('date')!;
    const seconds = Number(params.get('seconds'));
    const start = Date.parse(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}T09:00:00+09:00`);
    const bars = Array.from({ length: 300 }, (_, i) => ({ t_ms: start + i * seconds * 1000,
      open: 35000 + i * 10, high: 35100 + i * 10, low: 34900 + i * 10, close: 35050 + i * 10,
      volume: 100 + i, count: 3, trade_value: 3500000 }));
    const from = Number(params.get('from_ms') ?? 0), to = Number(params.get('to_ms') ?? Infinity);
    return r.fulfill({ json: { code: '098460', venue: 'KRX', date, seconds, source: 'second_trades',
      status: 'observed', coverage: 'unverified', storage_error: null,
      first_observed_ms: start, last_observed_ms: bars.at(-1)!.t_ms,
      bars: bars.filter(b => b.t_ms >= from && b.t_ms < to), prices: [] } });
  });
  await page.goto('/live?code=098460');
  await page.evaluate(async () => {
    const path = '/src/state/workspace.ts';
    const { useWorkspaceStore: store } = await import(path);
    const win = store.getState().windows.find((w: { kind: string }) => w.kind === 'chart');
    store.setState({ windows: [{ ...win, rect: { x: 0, y: 0, w: 1, h: 1 }, chart: { timeframe: '1m' } }], zOrder: [win.id], maximizedId: null });
  });
  const switchTo = async (name: string) => {
    await page.getByTestId('chart-window-header').getByRole('button', { name: /봉 선택 열기:/ }).click();
    await page.getByRole('menuitemradio', { name, exact: true }).click();
  };
  await switchTo('5초');
  const chart = page.getByTestId('second-chart');
  const toolbar = chart.getByTestId('chart-window-header');
  await expect(chart.locator('.legend-row-ma').first()).toBeVisible();
  for (const name of ['보조지표', '그리기', 'PNG로 저장', '차트 이미지 복사', '복기 노트에 추가', '레전드 끄기', '호버 연동', '정규장만 보기'])
    await expect(toolbar.getByRole('button', { name, exact: true })).toBeVisible();

  await toolbar.getByRole('button', { name: '보조지표', exact: true }).click();
  await expect(page.getByTestId('indicator-panel-scope-badge')).toContainText('초봉');
  await page.getByRole('button', { name: '이동평균선', exact: true }).click();
  const period = page.getByRole('spinbutton', { name: '기간1 길이', exact: true });
  await period.fill('7');
  await period.blur();
  await page.getByRole('button', { name: '지표 추가', exact: true }).click();
  await expect(page.getByRole('button', { name: '호가비', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '볼린저 밴드', exact: true }).click();
  const bollingerPeriod = page.getByRole('spinbutton', { name: '볼린저 기간' });
  await bollingerPeriod.fill('35');
  await bollingerPeriod.blur();
  await page.getByRole('button', { name: '설정대로 추가', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(chart.locator('.legend-row-ma').first()).toContainText('7');
  await toolbar.getByRole('button', { name: '레전드 끄기', exact: true }).click();
  await expect(chart.locator('.legend-row-ma')).toHaveCount(0);
  await expect(chart.locator('.legend-ohlc-open')).toBeVisible();
  await toolbar.getByRole('button', { name: '레전드 켜기', exact: true }).click();
  await toolbar.getByRole('button', { name: '호버 연동', exact: true }).click();
  await expect(toolbar.getByRole('button', { name: '호버 연동', exact: true })).toHaveAttribute('aria-pressed', 'false');

  await toolbar.getByRole('button', { name: '그리기', exact: true }).click();
  await page.getByRole('menuitemradio', { name: /^수평선 / }).click();
  const canvas = chart.locator('canvas').first();
  const bounds = await canvas.boundingBox();
  const x = bounds!.x + bounds!.width * 0.4, y = bounds!.y + bounds!.height * 0.5;
  await page.mouse.move(x, y);
  await expect(chart.locator('[data-drawing-overlay]')).toHaveCSS('pointer-events', 'auto');
  await page.mouse.click(x, y);
  await page.keyboard.press('Escape');
  const drawingCount = () => page.evaluate(async () => {
    const path = '/src/state/drawings.ts';
    const { useDrawingsStore } = await import(path);
    return [...useDrawingsStore.getState().byScope].filter(([key]: [string]) => key.endsWith('|seconds')).reduce((n: number, [, rows]: [string, unknown[]]) => n + rows.length, 0);
  });
  await expect.poll(drawingCount).toBe(1);

  const downloadPromise = page.waitForEvent('download');
  await toolbar.getByRole('button', { name: 'PNG로 저장', exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^chart_098460_5s_/);
  const output = testInfo.outputPath('seconds-tools.png');
  await download.saveAs(output);
  const png = await readFile(output);
  expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  expect(png.length).toBeGreaterThan(5000);

  // Wait for the real persistence subscriber before a browser reload.
  await expect.poll(() => page.evaluate(() => {
    const raw = JSON.parse(localStorage.getItem('live.indicators.v2') ?? '{}');
    return Object.values(raw.byWindow ?? {}).some((row: any) => row.seconds?.bollingerPeriod === 35 && row.seconds?.movingAverages?.[0]?.period === 7);
  })).toBe(true);
  await page.reload();
  await expect(chart.locator('.legend-row-ma').first()).toContainText('7');
  await expect.poll(drawingCount).toBe(1);
  await switchTo('30초');
  await expect(chart.locator('.legend-row-ma').first()).toContainText('7');
  await switchTo('1분');
  await page.getByTestId('chart-window-header').getByRole('button', { name: '보조지표', exact: true }).click();
  await page.getByRole('button', { name: '이동평균선', exact: true }).click();
  await expect(page.getByRole('spinbutton', { name: '기간1 길이', exact: true })).not.toHaveValue('7');
  await page.keyboard.press('Escape');
  await switchTo('10초');
  await expect(chart.locator('.legend-row-ma').first()).toContainText('7');
  for (const width of [400, 160]) {
    await toolbar.evaluate((el, w) => { el.style.width = `${w}px`; }, width);
    if (width < 200) await expect(toolbar).toHaveAttribute('data-compact-timeframe', '');
    else await expect(toolbar).not.toHaveAttribute('data-compact-timeframe');
    await expect.poll(() => toolbar.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    for (const button of await toolbar.getByRole('button').all()) await expect(button).toBeInViewport();
  }
  await page.screenshot({ path: testInfo.outputPath('seconds-narrow-toolbar.png') });
  expect(errors).toEqual([]);
});
