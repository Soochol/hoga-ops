import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { installLiveMocks } from './helpers/liveMocks';
import { installLiveWs } from './helpers/liveWs';
import { apiExact } from './helpers/apiRoutes';

async function setup(page: Page, context: BrowserContext, twoWindows = false) {
  const day = '20261030', open = Date.parse('2026-10-30T09:00:00+09:00');
  await page.clock.install({ time: open + 60 * 60_000 });
  await page.setViewportSize({ width: 1500, height: 1000 });
  await page.addInitScript(two => {
    if (sessionStorage.getItem('live.workspace.v1')) return;
    sessionStorage.setItem('live.workspace.v1', JSON.stringify({ schema_version: 2,
      windows: [{ id: 'comparison', kind: 'market-indices', group: 1, rect: { x: 0, y: 0, w: .48, h: .65 } },
        ...(two ? [{ id: 'other', kind: 'market-indices', group: 2, rect: { x: .5, y: 0, w: .48, h: .65 } }] : [])],
      zOrder: two ? ['other', 'comparison'] : ['comparison'],
      groupSymbols: { 1: { code: '005930', name: '삼성전자' }, 2: { code: '000660', name: 'SK하이닉스' } },
    }));
  }, twoWindows);
  await installLiveMocks(context);
  const ws = await installLiveWs(page);
  const indexRequests: string[] = [], stockRequests: string[] = [];
  await context.route(apiExact('live/index-quotes'), route => route.fulfill({ json: { quotes: [] } }));
  await context.route(apiExact('live/index-candles'), route => {
    const params = new URL(route.request().url()).searchParams;
    const id = params.get('index_id')!;
    indexRequests.push(id);
    const daily = params.get('timeframe') === 'D';
    const change = id === 'KOSPI' ? .1 : id === 'KOSDAQ' ? 1 : 10;
    const candles = Array.from({ length: daily ? 1 : 61 }, (_, i) => ({
      t_ms: daily ? open - 86400_000 : open + i * 60_000,
      open: 100, high: 120, low: 99, close: daily ? 100 : 100 + change * i / 60, volume: 10,
    }));
    return route.fulfill({ json: { index_id: id, timeframe: params.get('timeframe'),
      from: params.get('from'), to: params.get('to'), candles, data_warnings: [] } });
  });
  await context.route(apiExact('live/past-candles'), route => {
    const params = new URL(route.request().url()).searchParams, code = params.get('code')!;
    stockRequests.push(code);
    return route.fulfill({ json: { code, from: day, to: day, venue: params.get('venue'), bucket_ms: 60_000,
      cached_dates: [], fresh_dates: [day], data_warnings: [],
      candles: Array.from({ length: 61 }, (_, i) => ({ t_ms: open + i * 60_000,
        open: 100, high: 120, low: 99, close: 100 + Math.sin(i / 10) * 10, volume: 10 })),
    } });
  });
  await context.route(apiExact('live/series'), route => route.fulfill({ json: {
    code: new URL(route.request().url()).searchParams.get('code'), date: day,
    snapshots: [], trades: [], brokers: [], programs: [], after_hours: [], expected: [],
    session_open_ms: open, session_close_ms: null, is_open: true,
  } }));
  await page.goto('/live');
  const frame = page.locator('[data-win="comparison"]');
  await expect(frame.locator('[data-index-series]')).toHaveCount(3);
  await expect(frame.locator('[data-stock-series] path')).toHaveAttribute('d', /^M/);
  return { frame, ws, indexRequests, stockRequests };
}

test('selection updates the legend, axis and tooltip and stops hidden index/stock requests', async ({ page, context }, info) => {
  const { frame, ws, indexRequests, stockRequests } = await setup(page, context);
  const legend = frame.getByRole('list', { name: '표시 항목' });
  await expect(legend).toHaveText('코스피(+0.10%)코스닥(+1.00%)K200(+10.00%)삼성전자');
  await expect(frame.getByRole('img')).not.toHaveAttribute('aria-label', /별도\s?배율|독립\s?배율/);
  const axis = frame.getByTestId('major-indices-axis-labels');
  const before = await axis.textContent();
  await frame.getByRole('button', { name: '주요 지수 설정' }).click();
  const settings = page.getByRole('dialog', { name: '주요 지수 설정' });
  await expect(settings.getByRole('checkbox')).toHaveCount(0);
  await settings.getByRole('switch', { name: '툴팁 표시' }).check();
  const kosdaq = settings.getByRole('switch', { name: '코스닥', exact: true });
  await expect(kosdaq).toHaveCSS('width', '26px');
  await expect(kosdaq).toHaveCSS('height', '15px');
  await settings.locator('label').filter({ hasText: /^코스닥$/ }).click();
  await expect(kosdaq).not.toBeChecked();
  await kosdaq.focus();
  await page.keyboard.press('Space');
  await expect(kosdaq).toBeChecked();
  await page.keyboard.press('Enter');
  await expect(kosdaq).not.toBeChecked();
  await settings.getByRole('switch', { name: 'K200', exact: true }).uncheck();
  await expect(settings.getByRole('switch', { name: '코스피', exact: true })).toBeDisabled();
  await settings.getByRole('switch', { name: '그룹 종목 표시' }).uncheck();
  await settings.screenshot({ path: info.outputPath('major-indices-settings.png') });
  await page.keyboard.press('Escape');
  await expect(frame.getByRole('button', { name: '주요 지수 설정' })).toBeFocused();
  await expect(legend).toHaveText('코스피(+0.10%)');
  await expect(frame.locator('[data-index-series]')).toHaveCount(1);
  await expect(frame.locator('[data-stock-series]')).toHaveCount(0);
  await expect(axis).not.toHaveText(before!);
  await frame.getByRole('img').hover({ position: { x: 5, y: 80 } });
  await expect(frame.getByRole('tooltip')).toContainText('코스피');
  await expect(frame.getByRole('tooltip')).not.toContainText(/코스닥|K200|삼성전자/);
  await frame.getByRole('button', { name: '링크 그룹 1 변경' }).click();
  await page.getByRole('dialog', { name: '연결 그룹 선택' }).getByRole('button', { name: '2', exact: true }).click();
  await expect(frame.getByRole('button', { name: '링크 그룹 2 변경' })).toBeVisible();
  const hiddenBefore = indexRequests.filter(id => id !== 'KOSPI').length;
  const selectedBefore = indexRequests.filter(id => id === 'KOSPI').length;
  for (let i = 0; i < 3; i++) {
    ws.pushEvent({ type: 'diagnostic_heartbeat' });
    await page.clock.runFor(21_000);
  }
  expect(indexRequests.filter(id => id !== 'KOSPI')).toHaveLength(hiddenBefore);
  expect(indexRequests.filter(id => id === 'KOSPI').length).toBeGreaterThan(selectedBefore);
  expect(stockRequests).not.toContain('000660');
  await expect.poll(() => ws.subscribed().includes('005930')).toBe(false);
  await frame.getByRole('button', { name: '주요 지수 설정' }).click();
  await settings.getByRole('switch', { name: '그룹 종목 표시' }).check();
  await page.keyboard.press('Escape');
  await expect(legend).toHaveText('코스피(+0.10%)SK하이닉스');
  await expect(frame.locator('[data-stock-series] path')).toHaveAttribute('d', /^M/);
  await ws.waitForSubscribe('000660');
  await frame.screenshot({ path: info.outputPath('major-indices-selection.png') });
});

test('window selections stay independent through reload and preset restore, including narrow legend layout', async ({ page, context }, info) => {
  const { frame } = await setup(page, context, true);
  const other = page.locator('[data-win="other"]');
  await frame.getByRole('button', { name: '주요 지수 설정' }).click();
  const settings = page.getByRole('dialog', { name: '주요 지수 설정' });
  await settings.getByRole('switch', { name: '코스피', exact: true }).uncheck();
  await settings.getByRole('switch', { name: 'K200', exact: true }).uncheck();
  await settings.getByRole('switch', { name: '그룹 종목 표시' }).uncheck();
  await page.keyboard.press('Escape');
  await expect(frame.getByRole('list', { name: '표시 항목' })).toHaveText('코스닥(+1.00%)');
  await expect(other.getByRole('list', { name: '표시 항목' })).toHaveText('코스피(+0.10%)코스닥(+1.00%)K200(+10.00%)SK하이닉스');
  await page.reload();
  await expect(frame.getByRole('list', { name: '표시 항목' })).toHaveText('코스닥(+1.00%)');
  await expect(other.locator('[data-index-series]')).toHaveCount(3);
  const preset = await page.evaluate(async () => {
    const path = '/src/live/presets/layoutPresetSnapshot.ts';
    return (await import(path)).capturePresetPayload();
  });
  await frame.getByRole('button', { name: '주요 지수 설정' }).click();
  await settings.getByRole('switch', { name: '코스피', exact: true }).check();
  await page.keyboard.press('Escape');
  await page.evaluate(async payload => {
    const path = '/src/live/presets/layoutPresetSnapshot.ts';
    (await import(path)).applyPresetPayload(payload, null);
  }, preset);
  await expect(frame.getByRole('list', { name: '표시 항목' })).toHaveText('코스닥(+1.00%)');
  await other.evaluate(element => { (element as HTMLElement).style.width = '210px'; });
  const legend = other.getByRole('list', { name: '표시 항목' });
  await expect.poll(() => legend.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  const labels = await legend.getByRole('listitem').evaluateAll(elements => elements.map(element => element.getBoundingClientRect().top));
  expect(new Set(labels).size).toBeGreaterThan(1);
  const legendBounds = (await legend.boundingBox())!, plot = (await other.getByTestId('major-indices-chart').boundingBox())!;
  expect(legendBounds.y + legendBounds.height).toBeLessThanOrEqual(plot.y + 1);
  await other.screenshot({ path: info.outputPath('major-indices-narrow-legend.png') });
});


test('tooltip defaults OFF for legacy settings and persists independent window choices without reviving pins', async ({ page, context }, info) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem('hoga.window.settings.v1')) localStorage.setItem('hoga.window.settings.v1', JSON.stringify({
      schema_version: 1, byWindow: { comparison: { majorIndices: { indices: ['KOSPI', 'KOSDAQ', 'KOSPI200'], showStock: true } } },
    }));
  });
  const { frame } = await setup(page, context, true);
  const other = page.locator('[data-win="other"]');
  const svg = frame.getByRole('img');
  const legend = frame.getByRole('list', { name: '표시 항목' });
  const legendBefore = await legend.textContent();
  await svg.hover({ position: { x: 5, y: 80 } });
  await svg.click({ position: { x: 5, y: 80 } });
  await expect(frame.getByRole('tooltip')).toHaveCount(0);
  await expect(frame.locator('.major-indices-cursor')).toHaveCount(0);
  await frame.getByRole('button', { name: '주요 지수 설정' }).click();
  const settings = page.getByRole('dialog', { name: '주요 지수 설정' });
  const toggle = settings.getByRole('switch', { name: '툴팁 표시' });
  await expect(toggle).not.toBeChecked();
  await settings.locator('label').filter({ hasText: /^툴팁 표시$/ }).click();
  await expect(toggle).toBeChecked();
  await settings.screenshot({ path: info.outputPath('major-indices-tooltip-setting.png') });
  await page.keyboard.press('Escape');
  await svg.click({ position: { x: 5, y: 80 } });
  await page.mouse.move(0, 0);
  await expect(frame.getByRole('tooltip')).toBeVisible();
  await frame.getByRole('button', { name: '주요 지수 설정' }).click();
  await toggle.uncheck();
  await expect(frame.getByRole('tooltip')).toHaveCount(0);
  await expect(frame.locator('.major-indices-cursor')).toHaveCount(0);
  await toggle.check();
  await page.keyboard.press('Escape');
  await expect(frame.getByRole('tooltip')).toHaveCount(0);
  await svg.hover({ position: { x: 5, y: 80 } });
  await expect(frame.getByRole('tooltip')).toBeVisible();
  await page.mouse.move(0, 0);
  await expect(frame.getByRole('tooltip')).toHaveCount(0);
  await other.getByRole('img').hover({ position: { x: 5, y: 80 } });
  await expect(other.getByRole('tooltip')).toHaveCount(0);
  await page.reload();
  await svg.hover({ position: { x: 5, y: 80 } });
  await expect(frame.getByRole('tooltip')).toBeVisible();
  await other.getByRole('img').hover({ position: { x: 5, y: 80 } });
  await expect(other.getByRole('tooltip')).toHaveCount(0);
  const preset = await page.evaluate(async () => {
    const path = '/src/live/presets/layoutPresetSnapshot.ts';
    return (await import(path)).capturePresetPayload();
  });
  await frame.getByRole('button', { name: '주요 지수 설정' }).click();
  await toggle.uncheck();
  await page.keyboard.press('Escape');
  await page.evaluate(async payload => {
    const path = '/src/live/presets/layoutPresetSnapshot.ts';
    (await import(path)).applyPresetPayload(payload, null);
  }, preset);
  await expect(frame.getByRole('tooltip')).toHaveCount(0);
  await svg.hover({ position: { x: 5, y: 80 } });
  await expect(frame.getByRole('tooltip')).toBeVisible();
  await expect(legend).toHaveText(legendBefore!);
});
