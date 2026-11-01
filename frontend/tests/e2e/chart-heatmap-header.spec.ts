import { test, expect } from '@playwright/test';
import type { HeatmapEntry, HeatmapFolder } from '../../src/api/heatmap';
import type { WorkspaceWindow } from '../../src/state/workspace';
import { installLiveMocks } from './helpers/liveMocks';
import { apiExact, apiPrefix } from './helpers/apiRoutes';

test('chart heart opens both registration tabs and heatmap membership remains local', async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await installLiveMocks(page);
  await page.routeWebSocket(/\/api\/ws/, () => {});
  let folders: HeatmapFolder[] = [{ id: 'f_a', name: '반도체', order: 0 }, { id: 'f_b', name: '관찰', order: 1 }];
  let entries: HeatmapEntry[] = [];
  let failNext = false;
  let watchlistWrites = 0;
  const writes: { method: string; code: string; folderId: string }[] = [];
  await page.route(apiExact('watchlist'), route => route.fulfill({ json: {
    folders: [], entries: [], memos: [], next_run_at_ms: 0,
  } }));
  await page.route(apiPrefix('watchlist/folders'), route => {
    if (route.request().method() !== 'GET') watchlistWrites++;
    return route.fulfill({ status: 500, json: { detail: 'unexpected watchlist write' } });
  });
  await page.route(apiExact('heatmap'), route => route.fulfill({ json: { folders, entries, capture_markers: {}, next_run_at_ms: 0 } }));
  await page.route(apiExact('heatmap/folders'), async route => {
    const folder = { id: 'f_new', name: route.request().postDataJSON().name as string, order: folders.length };
    folders = [...folders, folder];
    await route.fulfill({ json: folder });
  });
  await page.route(apiPrefix('heatmap/folders/[^/]+/members'), async route => {
    const method = route.request().method();
    const parts = new URL(route.request().url()).pathname.split('/');
    const folderId = parts[4];
    const code = method === 'POST' ? route.request().postDataJSON().code as string : parts[6];
    writes.push({ method, code, folderId });
    if (failNext) {
      failNext = false;
      return route.fulfill({ status: 500, json: { detail: 'test failure' } });
    }
    entries = entries.filter(entry => entry.code !== code || entry.folder_id !== folderId);
    if (method === 'DELETE') return route.fulfill({ status: 204 });
    const entry = { code, name: code === '098460' ? '고영' : '삼성전자', folder_id: folderId, order: 0 };
    entries.push(entry);
    return route.fulfill({ json: entry });
  });
  await page.goto('/live?code=098460');
  const ids = await page.evaluate(async () => {
    const path = '/src/state/workspace.ts';
    const { useWorkspaceStore: store } = await import(path);
    store.getState().addWindow('chart');
    const charts = store.getState().windows.filter((window: WorkspaceWindow) => window.kind === 'chart').slice(0, 2);
    store.setState({ windows: charts.map((window: WorkspaceWindow, i: number) => ({ ...window, group: i + 1,
      chart: { ...window.chart, timeframe: '1m' }, rect: { x: i * .5, y: 0, w: .5, h: 1 } })),
      zOrder: charts.map((window: WorkspaceWindow) => window.id), maximizedId: null });
    store.getState().setWindowSymbol(charts[0].id, { code: '098460', name: '고영', kind: 'stock' });
    store.getState().setWindowSymbol(charts[1].id, { code: '005930', name: '삼성전자', kind: 'stock' });
    return charts.map((window: WorkspaceWindow) => window.id) as string[];
  });
  const first = page.locator(`[data-win="${ids[0]}"]`);
  const second = page.locator(`[data-win="${ids[1]}"]`);
  const button = first.getByTestId('live-watchlist-heart-button');
  const secondButton = second.getByTestId('live-watchlist-heart-button');
  const toolbar = first.getByTestId('chart-window-header');
  const order = await toolbar.getByRole('button').evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label')));
  const drawingIndex = order.indexOf('그리기');
  expect(order[drawingIndex - 1]).toBe('보조지표');
  expect(order[drawingIndex + 1]).toBe('호버 연동');
  await expect(toolbar.getByTestId('live-heatmap-button')).toHaveCount(0);
  const drawing = (await toolbar.getByTestId('drawing-menu-trigger').boundingBox())!;
  const cursor = (await toolbar.getByRole('button', { name: '호버 연동', exact: true }).boundingBox())!;
  expect(cursor.y).toBe(drawing.y);
  expect(cursor.x).toBeGreaterThan(drawing.x);

  await button.click();
  const picker = page.getByRole('dialog', { name: '종목 등록 그룹', exact: true });
  await expect(picker).toContainText('고영');
  await picker.getByRole('tab', { name: '히트맵', exact: true }).click();
  const semiconductor = picker.getByRole('checkbox', { name: '반도체', exact: true });
  const observation = picker.getByRole('checkbox', { name: '관찰', exact: true });
  await semiconductor.click();
  await expect(semiconductor).toBeChecked();
  await expect(button).toHaveAttribute('aria-pressed', 'false');
  await expect(secondButton).toHaveAttribute('aria-pressed', 'false');
  expect(writes[0]).toEqual({ method: 'POST', folderId: 'f_a', code: '098460' });
  await observation.click();
  await expect(observation).toBeChecked();
  await semiconductor.click();
  await expect(semiconductor).not.toBeChecked();
  await expect(observation).toBeChecked();
  await expect(button).toHaveAttribute('aria-pressed', 'false');

  failNext = true;
  await semiconductor.click();
  await expect(picker.getByRole('alert')).toContainText('저장하지 못했습니다');
  await expect(semiconductor).not.toBeChecked();
  await semiconductor.click();
  await expect(semiconductor).toBeChecked();
  await expect(picker.getByRole('alert')).toHaveCount(0);
  await picker.getByRole('textbox', { name: '새 히트맵 그룹' }).fill('중장기');
  await picker.getByRole('button', { name: '등록', exact: true }).click();
  await expect(picker.getByRole('checkbox', { name: '중장기' })).toBeChecked();
  await page.keyboard.press('Escape');
  await expect(picker).toBeHidden();
  await expect(button).toBeFocused();

  await page.evaluate(async id => {
    const path = '/src/state/workspace.ts';
    const { useWorkspaceStore: store } = await import(path);
    store.setState({ windows: store.getState().windows.map((window: WorkspaceWindow) => window.id === id
      ? { ...window, rect: { ...window.rect, w: .24 } } : window) });
  }, ids[0]);
  const heartBox = (await button.boundingBox())!;
  const frame = (await first.boundingBox())!;
  expect(heartBox.x).toBeGreaterThanOrEqual(frame.x);
  expect(heartBox.x + heartBox.width).toBeLessThanOrEqual(frame.x + frame.width);
  await button.click();
  await expect(picker).toBeVisible();
  await picker.getByRole('tab', { name: '히트맵', exact: true }).click();
  await page.screenshot({ path: info.outputPath('chart-heatmap-picker.png') });
  await page.evaluate(async id => {
    const path = '/src/state/workspace.ts';
    const { useWorkspaceStore: store } = await import(path);
    store.getState().setWindowSymbol(id, { code: '000660', name: 'SK하이닉스', kind: 'stock' });
  }, ids[0]);
  await expect(picker).toBeHidden();
  await expect(button).toHaveAttribute('aria-pressed', 'false');
  await page.evaluate(async id => {
    const path = '/src/state/workspace.ts';
    const { useWorkspaceStore: store } = await import(path);
    store.getState().setWindowSymbol(id, { code: 'KOSPI', name: '코스피', kind: 'index' });
  }, ids[0]);
  await expect(button).toBeDisabled();
  expect(watchlistWrites).toBe(0);
  expect(entries.every(entry => entry.code === '098460')).toBe(true);
});
