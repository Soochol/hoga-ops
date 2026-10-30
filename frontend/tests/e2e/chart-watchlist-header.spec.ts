import { test, expect } from '@playwright/test';
import type { WatchlistEntry, WatchlistResponse } from '../../src/api/watchlist';
import type { WorkspaceWindow } from '../../src/state/workspace';
import { installLiveMocks } from './helpers/liveMocks';
import { apiExact, apiPrefix } from './helpers/apiRoutes';

test('chart toolbar heart adds the local stock, supports undo and stays usable in narrow windows', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await installLiveMocks(page);
  await page.routeWebSocket(/\/api\/ws/, () => {});
  const folders = [{ id: 'f_a', name: '관찰', order: 0 }, { id: 'f_b', name: '장기', order: 1 }];
  let entries: WatchlistEntry[] = [];
  let failNext = false;
  const writes: { method: string; folderId: string; code: string }[] = [];
  const read = (): WatchlistResponse => ({ folders, entries, memos: [], next_run_at_ms: 0 });
  await page.route(apiExact('watchlist'), route => route.fulfill({ json: read() }));
  await page.route(apiPrefix('watchlist/folders/[^/]+/members'), async route => {
    const method = route.request().method();
    const parts = new URL(route.request().url()).pathname.split('/');
    const folderId = parts[4];
    const code = method === 'POST' ? route.request().postDataJSON().code as string : parts[6];
    writes.push({ method, folderId, code });
    if (failNext) {
      failNext = false;
      return route.fulfill({ status: 500, json: { detail: 'test write failure' } });
    }
    if (method === 'POST') {
      const entry = { code, name: code === '098460' ? '고영' : '삼성전자', folder_id: folderId, order: 0,
        registered_at_kst_date: '20261012', last_success_date: null };
      entries = [...entries.filter(e => e.code !== code || e.folder_id !== folderId), entry];
      await route.fulfill({ json: entry });
    } else if (method === 'DELETE') {
      entries = entries.filter(e => e.code !== code || e.folder_id !== folderId);
      await route.fulfill({ status: 204 });
    } else await route.fallback();
  });
  await page.route(apiExact('live/quotes'), route => {
    const codes = new URL(route.request().url()).searchParams.get('codes')?.split(',') ?? [];
    return route.fulfill({ json: { phase: 'open', quotes: codes.map(code => ({
      code, price: code === '098460' ? 35000 : 72000, change_pct: 1.25, change_won: 500, stale: false,
    })) } });
  });
  await page.goto('/live?code=098460');
  const ids = await page.evaluate(async () => {
    const path = '/src/state/workspace.ts';
    const { useWorkspaceStore: store } = await import(path);
    store.getState().addWindow('chart');
    const charts = store.getState().windows.filter((w: { kind: string }) => w.kind === 'chart').slice(0, 2);
    store.setState({ windows: charts.map((w: WorkspaceWindow, i: number) => ({ ...w, group: i + 1,
      rect: { x: i * .5, y: 0, w: .5, h: 1 } })),
      zOrder: charts.map((w: { id: string }) => w.id), maximizedId: null });
    store.getState().setWindowSymbol(charts[0].id, { code: '098460', name: '고영', kind: 'stock' });
    store.getState().setWindowSymbol(charts[1].id, { code: '005930', name: '삼성전자', kind: 'stock' });
    return charts.map((w: { id: string }) => w.id) as string[];
  });
  const first = page.locator(`[data-win="${ids[0]}"]`);
  const second = page.locator(`[data-win="${ids[1]}"]`);
  const firstHeart = first.getByTestId('live-watchlist-heart-button');
  const secondHeart = second.getByTestId('live-watchlist-heart-button');
  await expect(firstHeart).toHaveAttribute('aria-pressed', 'false');
  await expect(secondHeart).toHaveAttribute('aria-pressed', 'false');
  await expect(firstHeart).toHaveAttribute('aria-label', '관심 그룹 편집');
  await expect(firstHeart.locator('svg')).toHaveAttribute('fill', 'none');
  const frameBefore = (await first.boundingBox())!;
  const buttonBox = (await firstHeart.boundingBox())!;
  await page.mouse.move(buttonBox.x + buttonBox.width / 2, buttonBox.y + buttonBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(buttonBox.x + buttonBox.width / 2 + 5, buttonBox.y + buttonBox.height / 2 + 3);
  await page.mouse.up();
  const picker = page.getByTestId('watchlist-group-picker');
  await expect(picker).toBeVisible();
  const frameAfter = (await first.boundingBox())!;
  expect(frameAfter.x).toBe(frameBefore.x);
  expect(frameAfter.y).toBe(frameBefore.y);
  await expect(picker).toContainText('고영 098460');
  await picker.getByRole('checkbox', { name: '관찰', exact: true }).click();
  await expect(firstHeart).toHaveAttribute('aria-pressed', 'true');
  await expect(secondHeart).toHaveAttribute('aria-pressed', 'false');
  await expect(picker.getByRole('button', { name: '실행 취소' })).toBeEnabled();
  expect(writes[0]).toEqual({ method: 'POST', folderId: 'f_a', code: '098460' });

  await picker.getByRole('checkbox', { name: '장기', exact: true }).click();
  await expect(firstHeart).toHaveAttribute('aria-pressed', 'true');
  await expect(picker.getByRole('button', { name: '실행 취소' })).toBeEnabled();
  await picker.getByRole('button', { name: '실행 취소' }).click();
  await expect(firstHeart).toHaveAttribute('aria-pressed', 'true');
  await expect(picker.getByRole('checkbox', { name: '관찰', exact: true })).toBeChecked();
  await expect(picker.getByRole('checkbox', { name: '장기', exact: true })).not.toBeChecked();

  failNext = true;
  await picker.getByRole('checkbox', { name: '장기', exact: true }).click();
  await expect(picker).toContainText('저장하지 못했습니다. 다시 시도해 주세요.');
  await expect(picker.getByRole('checkbox', { name: '장기', exact: true })).not.toBeChecked();
  await expect(firstHeart).toHaveAttribute('aria-pressed', 'true');

  // Keep the dialog target local, even if a stock changes while it is open.
  await page.evaluate(async id => {
    const path = '/src/state/workspace.ts';
    const { useWorkspaceStore: store } = await import(path);
    store.getState().setWindowSymbol(id, { code: '000660', name: 'SK하이닉스', kind: 'stock' });
  }, ids[0]);
  await expect(picker).toBeHidden();
  await expect(firstHeart).toHaveAttribute('aria-pressed', 'false');
  await secondHeart.click();
  await expect(picker).toContainText('삼성전자 005930');
  await picker.getByRole('checkbox', { name: '관찰', exact: true }).click();
  await expect(secondHeart).toHaveAttribute('aria-pressed', 'true');
  await expect(picker.getByRole('button', { name: '실행 취소' })).toBeEnabled();
  await page.keyboard.press('Escape');
  await expect(picker).toBeHidden();
  await expect(secondHeart).toBeFocused();

  await page.evaluate(async id => {
    const path = '/src/state/workspace.ts';
    const { useWorkspaceStore: store } = await import(path);
    store.setState({ windows: store.getState().windows.map((w: WorkspaceWindow) => w.id === id
      ? { ...w, rect: { ...w.rect, w: .24 } } : w) });
  }, ids[1]);
  await expect(secondHeart).toBeVisible();
  await expect(secondHeart.locator('svg')).toHaveAttribute('fill', 'currentColor');
  const narrow = (await second.boundingBox())!;
  const heart = (await secondHeart.boundingBox())!;
  expect(heart.x).toBeGreaterThan(narrow.x);
  expect(heart.x + heart.width).toBeLessThan(narrow.x + narrow.width);
  await secondHeart.click();
  await expect(picker).toContainText('삼성전자 005930');
  await picker.screenshot({ path: testInfo.outputPath('watchlist-heart-popover.png') });
  await page.screenshot({ path: testInfo.outputPath('chart-watchlist-header.png') });
  expect(entries.map(e => e.code).sort()).toEqual(['005930', '098460']);
});
